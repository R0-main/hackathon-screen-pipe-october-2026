// Connecteurs MCP distants de l'entreprise : réglages (clé `mcp_connectors` des réglages de l'entreprise, lus et écrits
// par l'API seulement — jetons, secrets et vérificateurs PKCE ne quittent jamais le serveur), connexion OAuth avec
// redirection vers la page de connexion du fournisseur, retour (callback) et test de connexion (liste des outils).
// Les outils des serveurs connectés sont mis en cache (clé `mcp_tools`) et proposés aux agents de l'équipe par le MCP du
// cerveau, selon la règle choisie par l'admin (aucun, lecture seule, tous) et la zone du connecteur.

import {
  MCP_RETURN_PAGES,
  buildAuthorizeUrl,
  callResultText,
  catalogEntry,
  hasAccess,
  mcpImportDue,
  publicMcpConnector,
  toolsForAgents,
  tokenExpiring,
  truncate,
  validateMcpUrl,
  type McpCheck,
  type McpConnectorConfig,
  type McpConnectorPublic,
  type McpAgentsMode,
  type McpConnectorsConfig,
  type McpImportRun,
  type McpReturn,
  type McpToolDef,
} from "@brain/core"
import type { Viewer } from "../auth"
import { getClaude } from "../ai"
import { ingestItems } from "../brain"
import { recordIncident, sendAlert } from "../monitoring"
import { getStore } from "../store"
import { callTool, listTools, McpAuthError } from "./client"
import { exploreConnector } from "./import"
import { discover, exchangeCode, pkcePair, randomToken, refreshTokens, registerClient } from "./oauth"

const SETTING = "mcp_connectors"
const TOOLS_SETTING = "mcp_tools"
/** Au-delà, la liste d'outils en cache est relue au prochain usage par un agent. */
const TOOLS_TTL_MS = 24 * 60 * 60_000
/** Durée laissée pour se connecter chez le fournisseur et revenir. */
const PENDING_MS = 15 * 60_000

/** Adresse de retour OAuth de ce cerveau (à déclarer chez les fournisseurs qui exigent un client manuel). */
export function mcpRedirectUri(base: string): string {
  return `${base}/api/connectors/mcp/callback`
}

/** Erreur à montrer telle quelle (400 par défaut côté API ; 403 et 404 pour les agents). */
export class McpUserError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message)
  }
}

async function load(): Promise<McpConnectorsConfig> {
  const raw = await getStore().getOrgSetting(SETTING)
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as McpConnectorsConfig
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

/** Relit, modifie, enregistre (les appels réseau se font avant, pour ne pas écraser une modification concurrente). */
async function mutate<T>(fn: (cfg: McpConnectorsConfig) => T): Promise<T> {
  const cfg = await load()
  const out = fn(cfg)
  await getStore().setOrgSetting(SETTING, JSON.stringify(cfg))
  return out
}

export async function listMcpConnectors(): Promise<McpConnectorPublic[]> {
  return Object.values(await load())
    .sort((a, b) => a.added_at.localeCompare(b.added_at))
    .map(publicMcpConnector)
}

function fromCatalog(id: string): McpConnectorConfig | null {
  const entry = catalogEntry(id)
  if (!entry) return null
  return { id, catalog_id: id, name: entry.name, url: entry.url, auth: entry.auth, enabled: true, added_at: new Date().toISOString() }
}

/** Le connecteur `id`, ajouté depuis le catalogue s'il ne l'est pas encore. */
function ensure(cfg: McpConnectorsConfig, id: string): McpConnectorConfig {
  if (!cfg[id]) {
    const c = fromCatalog(id)
    if (!c) throw new McpUserError("Connecteur inconnu.")
    cfg[id] = c
  }
  return cfg[id]
}

export async function getMcpConnector(id: string): Promise<McpConnectorConfig | null> {
  return (await load())[id] ?? fromCatalog(id)
}

function message(err: unknown): string {
  return truncate((err instanceof Error ? err.message : String(err)).replace(/\s+/g, " "), 300)
}

/** Ajoute un serveur du catalogue (sans connexion : un serveur public est testé tout de suite). */
export async function addFromCatalog(id: string): Promise<McpConnectorPublic> {
  const c = await mutate((cfg) => ensure(cfg, id))
  return c.auth === "none" ? checkMcp(id) : publicMcpConnector(c)
}

/** Ajoute un serveur MCP quelconque ; le mode de connexion est découvert (OAuth, public) ou donné par un jeton. */
export async function addCustom(input: { name: string; url: string; token?: string }): Promise<McpConnectorPublic> {
  const valid = validateMcpUrl(input.url, { allowHttp: process.env.NODE_ENV !== "production" })
  if ("error" in valid) throw new McpUserError(`Adresse refusée : ${valid.error}.`)
  const token = input.token?.trim()
  let auth: McpConnectorConfig["auth"] = "token"
  if (!token) {
    const found = await discover(valid.url).catch((err) => {
      throw new McpUserError(`Serveur injoignable : ${message(err)}`)
    })
    if (found.meta) auth = found.meta.registration_endpoint ? "dynamic" : "manual"
    else if (found.open) auth = "none"
    else throw new McpUserError("Ce serveur demande une connexion sans annoncer de serveur OAuth : fournissez un jeton d'accès.")
  }
  const id = `custom-${randomToken(6).toLowerCase().replace(/[^a-z0-9]/g, "")}`
  await mutate((cfg) => {
    cfg[id] = { id, name: input.name.trim() || new URL(valid.url).hostname, url: valid.url, auth, enabled: true, added_at: new Date().toISOString(), token: token || undefined }
  })
  return auth === "dynamic" || auth === "manual" ? publicMcpConnector((await load())[id]) : checkMcp(id)
}

export type McpPatch = {
  client_id?: string
  client_secret?: string
  token?: string
  enabled?: boolean
  agents?: McpAgentsMode
  zone?: string | null
  import_enabled?: boolean
}

/**
 * Client OAuth déclaré à la main, jeton personnel, pause, outils proposés aux agents, zone, import. Un secret vide garde
 * celui enregistré pour ce client.
 */
export async function updateMcp(id: string, patch: McpPatch): Promise<McpConnectorPublic> {
  const c = await mutate((cfg) => {
    const c = ensure(cfg, id)
    const clientId = patch.client_id?.trim()
    if (clientId) {
      const keep = c.client && !c.client.dynamic && c.client.client_id === clientId ? c.client.client_secret : undefined
      c.client = { client_id: clientId, client_secret: patch.client_secret?.trim() || keep, dynamic: false }
      delete c.tokens
      delete c.last_check
    }
    if (patch.token !== undefined && patch.token.trim()) {
      c.token = patch.token.trim()
      delete c.last_check
    }
    if (patch.enabled !== undefined) c.enabled = patch.enabled
    if (patch.agents !== undefined) c.agents = patch.agents
    if (patch.zone !== undefined) c.zone = patch.zone || undefined
    if (patch.import_enabled !== undefined) c.import = { ...c.import, enabled: patch.import_enabled }
    return c
  })
  return publicMcpConnector(c)
}

export async function removeMcp(id: string): Promise<void> {
  await mutate((cfg) => {
    delete cfg[id]
  })
  await saveToolDefs(id, null)
}

type ToolCache = Record<string, { at: string; tools: McpToolDef[] }>

async function loadToolCache(): Promise<ToolCache> {
  const raw = await getStore().getOrgSetting(TOOLS_SETTING)
  try {
    const parsed = raw ? (JSON.parse(raw) as ToolCache) : {}
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

async function saveToolDefs(id: string, tools: McpToolDef[] | null): Promise<void> {
  const cache = await loadToolCache()
  if (tools) cache[id] = { at: new Date().toISOString(), tools }
  else if (cache[id]) delete cache[id]
  else return
  await getStore().setOrgSetting(TOOLS_SETTING, JSON.stringify(cache))
}

/**
 * Exécute `fn` avec le jeton du connecteur : rafraîchi d'abord s'il expire, puis une fois de plus si le serveur le
 * refuse. Les jetons rafraîchis sont enregistrés.
 */
export async function withBearer<T>(c: McpConnectorConfig, fn: (bearer: string | undefined) => Promise<T>): Promise<T> {
  let tokens = c.tokens
  let refreshed = false
  const refresh = async () => {
    if (!c.oauth || !c.client || !tokens?.refresh_token) return false
    tokens = await refreshTokens(c.oauth, c.client, tokens)
    refreshed = true
    return true
  }
  try {
    if (!c.token && tokenExpiring(tokens)) await refresh()
    const bearer = () => c.token ?? tokens?.access_token
    if (c.auth !== "none" && !bearer()) throw new McpUserError("Pas encore connecté : cliquez sur « Se connecter ».")
    try {
      return await fn(bearer())
    } catch (err) {
      if (!(err instanceof McpAuthError) || c.token || refreshed || !(await refresh())) throw err
      return await fn(bearer())
    }
  } finally {
    if (refreshed && tokens) {
      const t = tokens
      await mutate((cfg) => {
        if (cfg[c.id]) cfg[c.id].tokens = t
      })
    }
  }
}

/**
 * Prépare la connexion OAuth et renvoie l'adresse de la page de connexion du fournisseur. Le client est enregistré
 * automatiquement quand le fournisseur l'accepte ; l'état (anti-CSRF) est lié à l'admin qui clique.
 */
export async function startAuthorize(id: string, viewer: Viewer, redirectUri: string, returnTo: McpReturn = "connecteurs"): Promise<string> {
  const c = await getMcpConnector(id)
  if (!c) throw new McpUserError("Connecteur inconnu.")
  if (c.auth === "none") throw new McpUserError("Ce serveur est public : aucune connexion n'est nécessaire.")
  if (c.auth === "token") throw new McpUserError("Ce serveur se connecte par jeton d'accès.")
  const found = await discover(c.url).catch((err) => {
    throw new McpUserError(`Serveur injoignable : ${message(err)}`)
  })
  if (!found.meta) throw new McpUserError("Ce serveur n'annonce pas de serveur d'autorisation OAuth.")
  const meta = found.meta
  let client = c.client
  if (!client || (client.dynamic && client.redirect_uri !== redirectUri)) {
    if (c.auth === "manual" || !meta.registration_endpoint) throw new McpUserError("Renseignez d'abord le client OAuth (client_id et secret) déclaré chez le fournisseur.")
    client = await registerClient(meta, redirectUri).catch((err) => {
      throw new McpUserError(message(err))
    })
  }
  const { verifier, challenge } = pkcePair()
  const state = randomToken(24)
  await mutate((cfg) => {
    const cur = ensure(cfg, id)
    cur.client = client
    cur.oauth = meta
    cur.pending = { state, verifier, redirect_uri: redirectUri, by: viewer.real.id, created_at: Date.now(), return_to: returnTo }
  })
  return buildAuthorizeUrl(meta, { client_id: client.client_id, redirect_uri: redirectUri, state, code_challenge: challenge })
}

/** Page où ramener l'admin après le retour du fournisseur (celle d'où la connexion est partie). */
export async function pendingReturnPage(state: string): Promise<string> {
  const c = Object.values(await load()).find((x) => x.pending?.state === state)
  return MCP_RETURN_PAGES[c?.pending?.return_to ?? "connecteurs"] ?? MCP_RETURN_PAGES.connecteurs
}

/** Retour du fournisseur : vérifie l'état, échange le code contre des jetons, teste la connexion. Renvoie l'id. */
export async function completeAuthorize(viewer: Viewer, p: { state: string; code?: string | null; error?: string | null; error_description?: string | null }): Promise<string> {
  const cfg = await load()
  const c = Object.values(cfg).find((x) => x.pending?.state === p.state)
  if (!c?.pending) throw new McpUserError("Connexion expirée ou déjà utilisée : relancez-la depuis la page Connecteurs.")
  const pending = c.pending
  const clear = () =>
    mutate((cfg) => {
      if (cfg[c.id]?.pending?.state === p.state) delete cfg[c.id].pending
    })
  if (pending.by !== viewer.real.id) throw new McpUserError("Cette connexion a été lancée par un autre compte.")
  if (Date.now() - pending.created_at > PENDING_MS) {
    await clear()
    throw new McpUserError("Connexion expirée : relancez-la depuis la page Connecteurs.")
  }
  if (p.error || !p.code) {
    await clear()
    throw new McpUserError(p.error === "access_denied" ? "Connexion refusée chez le fournisseur." : `Le fournisseur a renvoyé une erreur : ${p.error_description || p.error || "code absent"}.`)
  }
  if (!c.oauth || !c.client) throw new McpUserError("Connexion incomplète : relancez-la.")
  const tokens = await exchangeCode(c.oauth, c.client, { code: p.code, verifier: pending.verifier, redirect_uri: pending.redirect_uri }).catch(async (err) => {
    await clear()
    throw new McpUserError(`Échange du code refusé : ${message(err)}`)
  })
  await mutate((cfg) => {
    const cur = cfg[c.id]
    if (!cur) return
    cur.tokens = tokens
    delete cur.pending
    delete cur.last_check
  })
  await checkMcp(c.id)
  return c.id
}

/** Teste la connexion (liste des outils, mise en cache pour les agents), en rafraîchissant le jeton au besoin. */
export async function checkMcp(id: string): Promise<McpConnectorPublic> {
  const c = (await load())[id]
  if (!c) throw new McpUserError("Connecteur non ajouté.")
  let check: McpCheck
  try {
    const result = await withBearer(c, (bearer) => listTools(c.url, bearer))
    await saveToolDefs(id, result.tools)
    check = { at: new Date().toISOString(), ok: true, tools: result.tools.map((t) => t.name), server: result.server }
  } catch (err) {
    const text = err instanceof McpAuthError ? `${message(err)} : reconnectez le connecteur` : message(err)
    check = { at: new Date().toISOString(), ok: false, tools: [], error: text }
  }
  const next = await mutate((cfg) => {
    const cur = cfg[id]
    if (!cur) return null
    cur.last_check = check
    return cur
  })
  return publicMcpConnector(next ?? { ...c, last_check: check })
}

// ---------------------------------------------------------------------------------------------------------------------
// Outils proposés aux agents (MCP du cerveau)

export type AgentConnector = { id: string; name: string; mode: McpAgentsMode; tools: McpToolDef[] }

/** Connecteur visible par ce membre : actif, connecté, outils ouverts aux agents, et zone lisible s'il en a une. */
function visibleTo(c: McpConnectorConfig, viewer: Viewer): boolean {
  if (!c.enabled || !hasAccess(c) || (c.agents ?? "read") === "off") return false
  return !c.zone || viewer.access.readable.includes(c.zone)
}

/** Outils des connecteurs visibles par ce membre (cache relu au besoin, en parallèle). */
export async function agentConnectors(viewer: Viewer): Promise<AgentConnector[]> {
  const cfg = await load()
  const visible = Object.values(cfg)
    .filter((c) => visibleTo(c, viewer))
    .sort((a, b) => a.added_at.localeCompare(b.added_at))
  if (!visible.length) return []
  const cache = await loadToolCache()
  const stale = visible.filter((c) => !cache[c.id] || Date.now() - Date.parse(cache[c.id].at) > TOOLS_TTL_MS)
  if (stale.length) {
    await Promise.allSettled(stale.map((c) => checkMcp(c.id)))
    Object.assign(cache, await loadToolCache())
  }
  return visible.map((c) => {
    const mode = c.agents ?? "read"
    return { id: c.id, name: c.name, mode, tools: toolsForAgents(cache[c.id]?.tools ?? [], mode) }
  })
}

/** Appel d'un outil par l'agent d'un membre, dans les limites choisies par l'admin. Lève McpUserError (400/403/404). */
export async function callAgentTool(viewer: Viewer, connectorId: string, tool: string, args: Record<string, unknown>): Promise<{ text: string; is_error: boolean }> {
  const c = (await load())[connectorId] ?? Object.values(await load()).find((x) => x.name.toLowerCase() === connectorId.toLowerCase())
  if (!c || !visibleTo(c, viewer)) throw new McpUserError(`Connecteur « ${connectorId} » introuvable ou non partagé avec les agents.`, 404)
  const mode = c.agents ?? "read"
  let defs = (await loadToolCache())[c.id]?.tools
  if (!defs?.some((d) => d.name === tool)) {
    // Outil apparu depuis la mise en cache : on relit la liste une fois.
    await checkMcp(c.id)
    defs = (await loadToolCache())[c.id]?.tools
  }
  const def = defs?.find((d) => d.name === tool)
  if (!def) throw new McpUserError(`Outil « ${tool} » inconnu de ${c.name} : appelez connected_tools pour la liste.`, 404)
  if (!toolsForAgents([def], mode).length)
    throw new McpUserError(`« ${tool} » modifie des données dans ${c.name} : l'admin n'a ouvert que les outils en lecture seule aux agents.`, 403)
  return callResultText(await withBearer(c, (bearer) => callTool(c.url, bearer, tool, args)))
}

// ---------------------------------------------------------------------------------------------------------------------
// Import du contenu dans le cerveau

/**
 * Importe le contenu du connecteur au nom de `viewer` (l'admin qui clique, ou celui dont la visite déclenche l'import
 * automatique) : Claude explore l'outil en lecture seule, ses connaissances entrent dans le cerveau. Ne lève pas : le
 * résultat dit si ça a marché, il est noté avec le connecteur et une alerte part en cas d'échec.
 */
export async function importMcp(viewer: Viewer, id: string): Promise<McpImportRun> {
  const started = Date.now()
  const finish = async (run: McpImportRun) => {
    await mutate((cfg) => {
      if (cfg[id]) cfg[id].import = { enabled: cfg[id].import?.enabled ?? false, last_run: run }
    })
    return run
  }
  try {
    const c = (await load())[id]
    if (!c) throw new McpUserError("Connecteur non ajouté.")
    if (!hasAccess(c)) throw new McpUserError("Pas encore connecté : cliquez sur « Se connecter ».")
    const store = getStore()
    const claude = await getClaude(store)
    if (!claude) throw new McpUserError("aucune clé Claude : ajoutez-en une dans Zones (ou ANTHROPIC_API_KEY sur le serveur).")
    let defs = (await loadToolCache())[id]?.tools
    if (!defs) {
      await checkMcp(id)
      defs = (await loadToolCache())[id]?.tools ?? []
    }
    // Lecture seule seulement, quelle que soit la règle des agents : l'import ne modifie jamais l'outil.
    const tools = defs.filter((d) => d.read_only)
    const [zones, org] = await Promise.all([store.listZones(), store.getOrg()])
    const outcome = await exploreConnector(c, {
      claude,
      tools,
      callTool: (name, args) => withBearer(c, (bearer) => callTool(c.url, bearer, name, args)),
      zones,
      org: { name: org.name, description: org.description || undefined },
      since: c.import?.last_run?.ok ? c.import.last_run.at : undefined,
    })
    const r = outcome.items.length ? await ingestItems(viewer, outcome.items, "job") : { inserted: 0, skipped: 0 }
    return finish({ at: new Date().toISOString(), ok: true, imported: r.inserted, skipped: r.skipped ?? 0, calls: outcome.calls, duration_ms: Date.now() - started })
  } catch (err) {
    const text = message(err)
    if (!(err instanceof McpUserError)) {
      recordIncident(`mcp-import:${id}`, err)
      void sendAlert(`mcp-import:${id}`, `Import du connecteur ${id} en échec : ${text}`)
    }
    return finish({ at: new Date().toISOString(), ok: false, imported: 0, error: text, duration_ms: Date.now() - started })
  }
}

const importing = new Set<string>()

/** Imports automatiques : appelé en arrière-plan quand un admin consulte l'état ; un import à la fois par connecteur. */
export async function runDueMcpImports(viewer: Viewer): Promise<void> {
  if (viewer.real.role !== "admin") return
  for (const c of Object.values(await load())) {
    const key = `${viewer.real.org_id}:${c.id}`
    if (!mcpImportDue(c) || importing.has(key)) continue
    importing.add(key)
    try {
      await importMcp(viewer, c.id)
    } finally {
      importing.delete(key)
    }
  }
}
