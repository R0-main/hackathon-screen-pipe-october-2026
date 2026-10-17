// OAuth authorization of a remote MCP server (MCP spec 2025-06-18): discovery (WWW-Authenticate, RFC 9728,
// RFC 8414 / OpenID), dynamic client registration (RFC 7591), PKCE S256, code exchange and refresh.

import { createHash, randomBytes } from "node:crypto"
import {
  authServerMetadataUrls,
  canonicalResource,
  parseTokenResponse,
  parseWwwAuthenticate,
  protectedResourceUrls,
  readAuthServerMetadata,
  tokenAuthMethod,
  type McpClient,
  type McpOAuthMeta,
  type McpTokens,
} from "@brain/core"
import { getJson, guardedRequest, type NetDeps } from "./net"
import { DEFAULT_DEPS } from "../scrape"

export const CLIENT_NAME = "NOS Brainer"
const PROTOCOL_VERSION = "2025-06-18"

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url")
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomToken(32)
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") }
}

export type Discovery = {
  /** The server answers without a token. */
  open: boolean
  /** OAuth metadata (absent: the server does not announce an authorization server). */
  meta?: McpOAuthMeta
}

/** `initialize` call without a token: 401 expected, with the metadata address in WWW-Authenticate. */
async function probe(serverUrl: string, deps: NetDeps): Promise<{ status: number; www: Record<string, string> }> {
  const res = await guardedRequest(
    serverUrl,
    {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": PROTOCOL_VERSION },
      body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: CLIENT_NAME, version: "0.1" } } }),
      // Only the status and headers are needed.
      until: () => true,
      timeoutMs: 10_000,
    },
    deps,
  )
  return { status: res.status, www: parseWwwAuthenticate(res.headers["www-authenticate"]) }
}

/** Beyond this, a scopes_supported list describes everything the provider can do (writes included), not a need. */
export const MAX_DEFAULT_SCOPES = 12

/**
 * Requested scopes: those of the WWW-Authenticate challenge, otherwise the resource metadata's scopes_supported if the
 * list is short; a long list (PagerDuty, Ramp…) is not requested as a block: the provider applies its default scopes,
 * instead of an oversized consent screen or an invalid_scope refusal.
 */
export function pickScopes(challenge: string | undefined, supported: unknown): string[] | undefined {
  const list = challenge
    ? challenge.split(/\s+/).filter(Boolean)
    : Array.isArray(supported)
      ? supported.filter((s): s is string => typeof s === "string" && s !== "none")
      : []
  if (!list.length || (!challenge && list.length > MAX_DEFAULT_SCOPES)) return undefined
  return list
}

export async function discover(serverUrl: string, deps: NetDeps = DEFAULT_DEPS): Promise<Discovery> {
  const { status, www } = await probe(serverUrl, deps)
  const open = status >= 200 && status < 300

  // Protected resource metadata: the announced address, otherwise the well-known addresses.
  const prmUrls = [...(www.resource_metadata ? [www.resource_metadata] : []), ...protectedResourceUrls(serverUrl)]
  let prm: Record<string, unknown> | null = null
  for (const u of prmUrls) {
    prm = await getJson(u, deps)
    if (prm && Array.isArray(prm.authorization_servers) && prm.authorization_servers.length) break
    prm = null
  }
  const resource = typeof prm?.resource === "string" && prm.resource ? prm.resource : canonicalResource(serverUrl)
  const scopes = pickScopes(www.scope, prm?.scopes_supported)

  // Authorization server: the announced one, otherwise (spec 2025-03-26) the MCP server's origin.
  const issuer = prm ? String((prm.authorization_servers as unknown[])[0]) : new URL(serverUrl).origin
  for (const u of authServerMetadataUrls(issuer)) {
    const json = await getJson(u, deps)
    const meta = json && readAuthServerMetadata(json, resource, scopes)
    if (meta) return { open, meta }
  }
  if (!prm && !open && status === 401) {
    // Old convention: default endpoints at the root.
    const origin = new URL(serverUrl).origin
    return { open, meta: { issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register`, scopes, resource } }
  }
  return { open }
}

/** Dynamic registration: a public client (PKCE, no secret) for this redirect URI. */
export async function registerClient(meta: McpOAuthMeta, redirectUri: string, deps: NetDeps = DEFAULT_DEPS): Promise<McpClient> {
  if (!meta.registration_endpoint) throw new Error("this provider does not accept automatic registration: fill in an OAuth client")
  const res = await guardedRequest(
    meta.registration_endpoint,
    {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        client_name: CLIENT_NAME,
        client_uri: "https://www.nos-brainer.tech",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        ...(meta.scopes?.length ? { scope: meta.scopes.join(" ") } : {}),
      }),
    },
    deps,
  )
  let data: Record<string, unknown> = {}
  try {
    data = JSON.parse(res.body) as Record<string, unknown>
  } catch {
    // non-JSON body: handled below
  }
  if (res.status < 200 || res.status >= 300 || typeof data.client_id !== "string") {
    const detail = typeof data.error_description === "string" ? data.error_description : typeof data.error === "string" ? data.error : `HTTP ${res.status}`
    throw new Error(`client registration refused (${detail})`)
  }
  return {
    client_id: data.client_id,
    client_secret: typeof data.client_secret === "string" ? data.client_secret : undefined,
    auth_method: typeof data.token_endpoint_auth_method === "string" ? data.token_endpoint_auth_method : "none",
    dynamic: true,
    redirect_uri: redirectUri,
  }
}

async function tokenRequest(meta: McpOAuthMeta, client: McpClient, params: Record<string, string>, deps: NetDeps): Promise<McpTokens> {
  const method = tokenAuthMethod(client, meta.token_auth_methods)
  const form = new URLSearchParams({ ...params, resource: meta.resource })
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }
  if (method === "client_secret_basic") {
    const enc = (s: string) => encodeURIComponent(s)
    headers.authorization = `Basic ${Buffer.from(`${enc(client.client_id)}:${enc(client.client_secret ?? "")}`).toString("base64")}`
  } else {
    form.set("client_id", client.client_id)
    if (method === "client_secret_post") form.set("client_secret", client.client_secret ?? "")
  }
  const res = await guardedRequest(meta.token_endpoint, { method: "POST", headers, body: form.toString() }, deps)
  if (res.status >= 500) throw new Error(`authorization server error (HTTP ${res.status})`)
  return parseTokenResponse(res.body, res.headers["content-type"] ?? "")
}

export function exchangeCode(meta: McpOAuthMeta, client: McpClient, p: { code: string; verifier: string; redirect_uri: string }, deps: NetDeps = DEFAULT_DEPS): Promise<McpTokens> {
  return tokenRequest(meta, client, { grant_type: "authorization_code", code: p.code, redirect_uri: p.redirect_uri, code_verifier: p.verifier }, deps)
}

/** New access token; the refresh token is kept if the server does not send a new one. */
export async function refreshTokens(meta: McpOAuthMeta, client: McpClient, tokens: McpTokens, deps: NetDeps = DEFAULT_DEPS): Promise<McpTokens> {
  if (!tokens.refresh_token) throw new Error("sign-in expired: reconnect the connector")
  const next = await tokenRequest(meta, client, { grant_type: "refresh_token", refresh_token: tokens.refresh_token }, deps)
  return { ...next, refresh_token: next.refresh_token ?? tokens.refresh_token }
}
