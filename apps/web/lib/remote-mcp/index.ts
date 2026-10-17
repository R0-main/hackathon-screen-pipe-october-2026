// The company's remote MCP connectors: settings (`mcp_connectors` key of the company settings, read and written by the
// API only — tokens, secrets and PKCE verifiers never leave the server), OAuth connection with a redirect to the
// provider's sign-in page, return (callback) and connection test (list of tools).

import {
  MCP_RETURN_PAGES,
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
  type McpReturn,
} from "@brain/core"
import type { Viewer } from "../auth"
import { getStore } from "../store"
import { listTools, McpAuthError } from "./client"
import { discover, exchangeCode, pkcePair, randomToken, refreshTokens, registerClient } from "./oauth"

const SETTING = "mcp_connectors"
/** Time allowed to sign in at the provider and come back. */
const PENDING_MS = 15 * 60_000

/** This brain's OAuth redirect URI (to declare at providers that require a manual client). */
export function mcpRedirectUri(base: string): string {
  return `${base}/api/connectors/mcp/callback`
}

/** Error to show as is to the admin (400 on the API side). */
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

export type McpPatch = { client_id?: string; client_secret?: string; token?: string; enabled?: boolean }

/** OAuth client declared by hand, personal token, pause. An empty secret keeps the one saved for this client. */
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

/** Tests the connection (list of tools), refreshing the token if it expires or is refused once. */
export async function checkMcp(id: string): Promise<McpConnectorPublic> {
  const c = (await load())[id]
  if (!c) throw new McpUserError("Connector not added.")
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
    if (c.auth !== "none" && !bearer()) throw new McpUserError("Not connected yet: click \"Connect\".")
    let result
    try {
      result = await listTools(c.url, bearer())
    } catch (err) {
      if (!(err instanceof McpAuthError) || c.token || refreshed || !(await refresh())) throw err
      result = await listTools(c.url, bearer())
    }
    check = { at: new Date().toISOString(), ok: true, tools: result.tools, server: result.server }
  } catch (err) {
    const text = err instanceof McpAuthError ? `${message(err)}: reconnect the connector` : message(err)
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
