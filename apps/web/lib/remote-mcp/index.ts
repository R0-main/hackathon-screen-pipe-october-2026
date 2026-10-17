// Connecteurs MCP distants de l'entreprise : réglages (clé `mcp_connectors` des réglages de l'entreprise, lus et écrits
// par l'API seulement — jetons, secrets et vérificateurs PKCE ne quittent jamais le serveur), connexion OAuth avec
// redirection vers la page de connexion du fournisseur, retour (callback) et test de connexion (liste des outils).

import {
  buildAuthorizeUrl,
  catalogEntry,
  publicMcpConnector,
  tokenExpiring,
  truncate,
  validateMcpUrl,
  type McpCheck,
  type McpConnectorConfig,
  type McpConnectorPublic,
  type McpConnectorsConfig,
} from "@brain/core"
import type { Viewer } from "../auth"
import { getStore } from "../store"
import { listTools, McpAuthError } from "./client"
import { discover, exchangeCode, pkcePair, randomToken, refreshTokens, registerClient } from "./oauth"

const SETTING = "mcp_connectors"
/** Durée laissée pour se connecter chez le fournisseur et revenir. */
const PENDING_MS = 15 * 60_000

/** Adresse de retour OAuth de ce cerveau (à déclarer chez les fournisseurs qui exigent un client manuel). */
export function mcpRedirectUri(base: string): string {
  return `${base}/api/connectors/mcp/callback`
}

/** Erreur à montrer telle quelle à l'admin (400 côté API). */
export class McpUserError extends Error {}

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

export type McpPatch = { client_id?: string; client_secret?: string; token?: string; enabled?: boolean }

/** Client OAuth déclaré à la main, jeton personnel, pause. Un secret vide garde celui enregistré pour ce client. */
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
    return c
  })
  return publicMcpConnector(c)
}

export async function removeMcp(id: string): Promise<void> {
  await mutate((cfg) => {
    delete cfg[id]
  })
}

/**
 * Prépare la connexion OAuth et renvoie l'adresse de la page de connexion du fournisseur. Le client est enregistré
 * automatiquement quand le fournisseur l'accepte ; l'état (anti-CSRF) est lié à l'admin qui clique.
 */
export async function startAuthorize(id: string, viewer: Viewer, redirectUri: string): Promise<string> {
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
    cur.pending = { state, verifier, redirect_uri: redirectUri, by: viewer.real.id, created_at: Date.now() }
  })
  return buildAuthorizeUrl(meta, { client_id: client.client_id, redirect_uri: redirectUri, state, code_challenge: challenge })
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

/** Teste la connexion (liste des outils), en rafraîchissant le jeton s'il expire ou s'il est refusé une fois. */
export async function checkMcp(id: string): Promise<McpConnectorPublic> {
  const c = (await load())[id]
  if (!c) throw new McpUserError("Connecteur non ajouté.")
  let tokens = c.tokens
  let refreshed = false
  const refresh = async () => {
    if (!c.oauth || !c.client || !tokens?.refresh_token) return false
    tokens = await refreshTokens(c.oauth, c.client, tokens)
    refreshed = true
    return true
  }
  let check: McpCheck
  try {
    if (!c.token && tokenExpiring(tokens)) await refresh()
    const bearer = () => c.token ?? tokens?.access_token
    if (c.auth !== "none" && !bearer()) throw new McpUserError("Pas encore connecté : cliquez sur « Se connecter ».")
    let result
    try {
      result = await listTools(c.url, bearer())
    } catch (err) {
      if (!(err instanceof McpAuthError) || c.token || refreshed || !(await refresh())) throw err
      result = await listTools(c.url, bearer())
    }
    check = { at: new Date().toISOString(), ok: true, tools: result.tools, server: result.server }
  } catch (err) {
    const text = err instanceof McpAuthError ? `${message(err)} : reconnectez le connecteur` : message(err)
    check = { at: new Date().toISOString(), ok: false, tools: [], error: text }
  }
  const next = await mutate((cfg) => {
    const cur = cfg[id]
    if (!cur) return null
    if (refreshed && tokens) cur.tokens = tokens
    cur.last_check = check
    return cur
  })
  return publicMcpConnector(next ?? { ...c, last_check: check })
}
