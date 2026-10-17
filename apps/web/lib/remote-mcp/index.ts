// The company's remote MCP connectors: settings (`mcp_connectors` key of the company settings, read and written by the
// API only — tokens, secrets and PKCE verifiers never leave the server), OAuth connection with a redirect to the
// provider's sign-in page, return (callback) and connection test (list of tools).
// The connected servers' tools are cached (`mcp_tools` key) and offered to the team's agents through the brain's MCP,
// following the rule the admin chose (none, read-only, all) and the connector's zone.

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
/** Beyond this, the cached list of tools is reread the next time an agent uses it. */
const TOOLS_TTL_MS = 24 * 60 * 60_000
/** Time allowed to sign in at the provider and come back. */
const PENDING_MS = 15 * 60_000

/** This brain's OAuth redirect URI (to declare at providers that require a manual client). */
export function mcpRedirectUri(base: string): string {
  return `${base}/api/connectors/mcp/callback`
}

/** Error to show as is (400 by default on the API side; 403 and 404 for agents). */
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

/** Reread, modify, save (network calls happen before, so as not to overwrite a concurrent change). */
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

/** The `id` connector, added from the catalog if it is not yet. */
function ensure(cfg: McpConnectorsConfig, id: string): McpConnectorConfig {
  if (!cfg[id]) {
    const c = fromCatalog(id)
    if (!c) throw new McpUserError("Unknown connector.")
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

/** Adds a catalog server (without connecting: a public server is tested right away). */
export async function addFromCatalog(id: string): Promise<McpConnectorPublic> {
  const c = await mutate((cfg) => ensure(cfg, id))
  return c.auth === "none" ? checkMcp(id) : publicMcpConnector(c)
}

/** Adds any MCP server; the connection mode is discovered (OAuth, public) or given by a token. */
export async function addCustom(input: { name: string; url: string; token?: string }): Promise<McpConnectorPublic> {
  const valid = validateMcpUrl(input.url, { allowHttp: process.env.NODE_ENV !== "production" })
  if ("error" in valid) throw new McpUserError(`Address refused: ${valid.error}.`)
  const token = input.token?.trim()
  let auth: McpConnectorConfig["auth"] = "token"
  if (!token) {
    const found = await discover(valid.url).catch((err) => {
      throw new McpUserError(`Server unreachable: ${message(err)}`)
    })
    if (found.meta) auth = found.meta.registration_endpoint ? "dynamic" : "manual"
    else if (found.open) auth = "none"
    else throw new McpUserError("This server asks for a sign-in without announcing an OAuth server: provide an access token.")
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
 * OAuth client declared by hand, personal token, pause, tools offered to agents, zone, import. An empty secret keeps the
 * one saved for this client.
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
 * Runs `fn` with the connector's token: refreshed first if it expires, then once more if the server refuses it. The
 * refreshed tokens are saved.
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
    if (c.auth !== "none" && !bearer()) throw new McpUserError('Not connected yet: click "Connect".')
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
 * Prepares the OAuth connection and returns the address of the provider's sign-in page. The client is registered
 * automatically when the provider accepts it; the state (anti-CSRF) is tied to the admin who clicks.
 */
export async function startAuthorize(id: string, viewer: Viewer, redirectUri: string, returnTo: McpReturn = "connectors"): Promise<string> {
  const c = await getMcpConnector(id)
  if (!c) throw new McpUserError("Unknown connector.")
  if (c.auth === "none") throw new McpUserError("This server is public: no sign-in is needed.")
  if (c.auth === "token") throw new McpUserError("This server connects with an access token.")
  const found = await discover(c.url).catch((err) => {
    throw new McpUserError(`Server unreachable: ${message(err)}`)
  })
  if (!found.meta) throw new McpUserError("This server does not announce an OAuth authorization server.")
  const meta = found.meta
  let client = c.client
  if (!client || (client.dynamic && client.redirect_uri !== redirectUri)) {
    if (c.auth === "manual" || !meta.registration_endpoint) throw new McpUserError("First fill in the OAuth client (client_id and secret) declared at the provider.")
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

/** Page to bring the admin back to after the provider's return (the one the sign-in started from). */
export async function pendingReturnPage(state: string): Promise<string> {
  const c = Object.values(await load()).find((x) => x.pending?.state === state)
  return MCP_RETURN_PAGES[c?.pending?.return_to ?? "connectors"] ?? MCP_RETURN_PAGES.connectors
}

/** The provider's return: checks the state, exchanges the code for tokens, tests the connection. Returns the id. */
export async function completeAuthorize(viewer: Viewer, p: { state: string; code?: string | null; error?: string | null; error_description?: string | null }): Promise<string> {
  const cfg = await load()
  const c = Object.values(cfg).find((x) => x.pending?.state === p.state)
  if (!c?.pending) throw new McpUserError("Sign-in expired or already used: start it again from the Connectors page.")
  const pending = c.pending
  const clear = () =>
    mutate((cfg) => {
      if (cfg[c.id]?.pending?.state === p.state) delete cfg[c.id].pending
    })
  if (pending.by !== viewer.real.id) throw new McpUserError("This sign-in was started by another account.")
  if (Date.now() - pending.created_at > PENDING_MS) {
    await clear()
    throw new McpUserError("Sign-in expired: start it again from the Connectors page.")
  }
  if (p.error || !p.code) {
    await clear()
    throw new McpUserError(p.error === "access_denied" ? "Sign-in refused at the provider." : `The provider returned an error: ${p.error_description || p.error || "no code"}.`)
  }
  if (!c.oauth || !c.client) throw new McpUserError("Incomplete sign-in: start it again.")
  const tokens = await exchangeCode(c.oauth, c.client, { code: p.code, verifier: pending.verifier, redirect_uri: pending.redirect_uri }).catch(async (err) => {
    await clear()
    throw new McpUserError(`Code exchange refused: ${message(err)}`)
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

/** Tests the connection (list of tools, cached for agents), refreshing the token if needed. */
export async function checkMcp(id: string): Promise<McpConnectorPublic> {
  const c = (await load())[id]
  if (!c) throw new McpUserError("Connector not added.")
  let check: McpCheck
  try {
    const result = await withBearer(c, (bearer) => listTools(c.url, bearer))
    await saveToolDefs(id, result.tools)
    check = { at: new Date().toISOString(), ok: true, tools: result.tools.map((t) => t.name), server: result.server }
  } catch (err) {
    const text = err instanceof McpAuthError ? `${message(err)}: reconnect the connector` : message(err)
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
// Tools offered to agents (the brain's MCP)

export type AgentConnector = { id: string; name: string; mode: McpAgentsMode; tools: McpToolDef[] }

/** Connector visible to this member: enabled, connected, tools open to agents, and a readable zone if it has one. */
function visibleTo(c: McpConnectorConfig, viewer: Viewer): boolean {
  if (!c.enabled || !hasAccess(c) || (c.agents ?? "read") === "off") return false
  return !c.zone || viewer.access.readable.includes(c.zone)
}

/** Tools of the given connectors under their rule (cache reread when needed, in parallel). */
async function connectorTools(list: McpConnectorConfig[], modeOf: (c: McpConnectorConfig) => McpAgentsMode): Promise<AgentConnector[]> {
  if (!list.length) return []
  const sorted = [...list].sort((a, b) => a.added_at.localeCompare(b.added_at))
  const cache = await loadToolCache()
  const stale = sorted.filter((c) => !cache[c.id] || Date.now() - Date.parse(cache[c.id].at) > TOOLS_TTL_MS)
  if (stale.length) {
    await Promise.allSettled(stale.map((c) => checkMcp(c.id)))
    Object.assign(cache, await loadToolCache())
  }
  return sorted.map((c) => {
    const mode = modeOf(c)
    return { id: c.id, name: c.name, mode, tools: toolsForAgents(cache[c.id]?.tools ?? [], mode) }
  })
}

/** Calls `tool` on connector `c` if the rule allows it. Throws McpUserError (403/404). */
async function callConnectorTool(c: McpConnectorConfig, mode: McpAgentsMode, tool: string, args: Record<string, unknown>): Promise<{ text: string; is_error: boolean }> {
  let defs = (await loadToolCache())[c.id]?.tools
  if (!defs?.some((d) => d.name === tool)) {
    // Tool that appeared since it was cached: reread the list once.
    await checkMcp(c.id)
    defs = (await loadToolCache())[c.id]?.tools
  }
  const def = defs?.find((d) => d.name === tool)
  if (!def) throw new McpUserError(`Tool "${tool}" unknown to ${c.name}: list the tools again.`, 404)
  if (!toolsForAgents([def], mode).length) throw new McpUserError(`"${tool}" changes data in ${c.name}: only read-only tools are open here.`, 403)
  return callResultText(await withBearer(c, (bearer) => callTool(c.url, bearer, tool, args)))
}

async function findConnector(idOrName: string): Promise<McpConnectorConfig | undefined> {
  const cfg = await load()
  return cfg[idOrName] ?? Object.values(cfg).find((x) => x.name.toLowerCase() === idOrName.toLowerCase())
}

/** Tools of the connectors visible to this member. */
export async function agentConnectors(viewer: Viewer): Promise<AgentConnector[]> {
  return connectorTools(
    Object.values(await load()).filter((c) => visibleTo(c, viewer)),
    (c) => c.agents ?? "read",
  )
}

/** A member's agent calls a tool, within the limits the admin chose. Throws McpUserError (400/403/404). */
export async function callAgentTool(viewer: Viewer, connectorId: string, tool: string, args: Record<string, unknown>): Promise<{ text: string; is_error: boolean }> {
  const c = await findConnector(connectorId)
  if (!c || !visibleTo(c, viewer)) throw new McpUserError(`Connector "${connectorId}" not found or not shared with agents.`, 404)
  return callConnectorTool(c, c.agents ?? "read", tool, args)
}

/**
 * For the onboarding agent (upload code of an admin): every connected server, read-only tools only, whatever the
 * agents rule. The admin connects them on the creation page while the agent reads the conversations.
 */
export async function onboardingConnectors(): Promise<AgentConnector[]> {
  return connectorTools(
    Object.values(await load()).filter((c) => c.enabled && hasAccess(c)),
    () => "read",
  )
}

export async function callOnboardingTool(connectorId: string, tool: string, args: Record<string, unknown>): Promise<{ text: string; is_error: boolean }> {
  const c = await findConnector(connectorId)
  if (!c || !c.enabled || !hasAccess(c)) throw new McpUserError(`Connector "${connectorId}" not found or not connected.`, 404)
  return callConnectorTool(c, "read", tool, args)
}

// ---------------------------------------------------------------------------------------------------------------------
// Importing the content into the brain

/**
 * Imports the connector's content on behalf of `viewer` (the admin who clicks, or the one whose visit triggers the
 * automatic import): Claude explores the tool read-only, and its knowledge enters the brain. Does not throw: the result
 * says whether it worked, it is saved with the connector and an alert goes out on failure.
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
    if (!c) throw new McpUserError("Connector not added.")
    if (!hasAccess(c)) throw new McpUserError('Not connected yet: click "Connect".')
    const store = getStore()
    const claude = await getClaude(store)
    if (!claude) throw new McpUserError("no Claude key: add one in Zones (or ANTHROPIC_API_KEY on the server).")
    let defs = (await loadToolCache())[id]?.tools
    if (!defs) {
      await checkMcp(id)
      defs = (await loadToolCache())[id]?.tools ?? []
    }
    // Read-only tools only, whatever the agents rule: the import never changes the tool.
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
      void sendAlert(`mcp-import:${id}`, `Import of connector ${id} failed: ${text}`)
    }
    return finish({ at: new Date().toISOString(), ok: false, imported: 0, error: text, duration_ms: Date.now() - started })
  }
}

const importing = new Set<string>()

/** Automatic imports: called in the background when an admin views the state; one import at a time per connector. */
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
