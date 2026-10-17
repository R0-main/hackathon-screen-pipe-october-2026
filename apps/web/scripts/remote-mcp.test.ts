// Full journey of an MCP connector against a fake local provider (MCP server + authorization server): discovery,
// dynamic registration, sign-in page, code exchange with PKCE, list of tools over SSE with pagination, token revoked
// then refreshed. And the SSRF protection: without test dependencies, 127.0.0.1 is refused.

import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { createHash, randomBytes } from "node:crypto"
import http from "node:http"
import type { AddressInfo } from "node:net"
import { buildAuthorizeUrl } from "@brain/core"
import { listTools, McpAuthError } from "../lib/remote-mcp/client"
import { guardedRequest, type NetDeps } from "../lib/remote-mcp/net"
import { MAX_DEFAULT_SCOPES, discover, exchangeCode, pickScopes, pkcePair, refreshTokens, registerClient } from "../lib/remote-mcp/oauth"

const deps: NetDeps = { resolve: async () => [{ address: "127.0.0.1", family: 4 }], isBlocked: () => false }

let server: http.Server
let base = ""
const clients = new Map<string, { redirect_uris: string[] }>()
const codes = new Map<string, { client_id: string; challenge: string; redirect_uri: string; resource: string }>()
const access = new Set<string>()
const refresh = new Set<string>()
const seen: { sessionHeader?: string; initializedNotification: boolean; deleted: boolean } = { initializedNotification: false, deleted: false }

function issue() {
  const a = `at_${randomBytes(8).toString("hex")}`
  const r = `rt_${randomBytes(8).toString("hex")}`
  access.add(a)
  refresh.add(r)
  return { access_token: a, refresh_token: r, token_type: "Bearer", expires_in: 3600 }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let s = ""
    req.on("data", (c) => (s += c))
    req.on("end", () => resolve(s))
  })
}

function send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers })
  res.end(JSON.stringify(body))
}

const TOOLS = ["search", "fetch", "create_issue"]

before(async () => {
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", base)
    const body = await readBody(req)
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp") return send(res, 200, { resource: `${base}/mcp`, authorization_servers: [`${base}/auth`], scopes_supported: ["read"] })
    if (url.pathname === "/.well-known/oauth-authorization-server/auth")
      return send(res, 200, { issuer: `${base}/auth`, authorization_endpoint: `${base}/auth/authorize`, token_endpoint: `${base}/auth/token`, registration_endpoint: `${base}/auth/register`, code_challenge_methods_supported: ["S256"] })
    if (url.pathname === "/auth/register" && req.method === "POST") {
      const b = JSON.parse(body) as { redirect_uris: string[]; token_endpoint_auth_method: string }
      assert.equal(b.token_endpoint_auth_method, "none")
      const id = `client_${clients.size + 1}`
      clients.set(id, { redirect_uris: b.redirect_uris })
      return send(res, 201, { client_id: id, token_endpoint_auth_method: "none", redirect_uris: b.redirect_uris })
    }
    if (url.pathname === "/auth/authorize") {
      // The provider's sign-in page: here the user accepts right away.
      const q = url.searchParams
      const client = clients.get(q.get("client_id") ?? "")
      if (!client || !client.redirect_uris.includes(q.get("redirect_uri") ?? "") || q.get("code_challenge_method") !== "S256") return send(res, 400, { error: "invalid_request" })
      const code = `code_${randomBytes(6).toString("hex")}`
      codes.set(code, { client_id: q.get("client_id")!, challenge: q.get("code_challenge")!, redirect_uri: q.get("redirect_uri")!, resource: q.get("resource") ?? "" })
      res.writeHead(302, { location: `${q.get("redirect_uri")}?code=${code}&state=${encodeURIComponent(q.get("state") ?? "")}` })
      return res.end()
    }
    if (url.pathname === "/auth/token" && req.method === "POST") {
      const f = new URLSearchParams(body)
      if (f.get("grant_type") === "authorization_code") {
        const c = codes.get(f.get("code") ?? "")
        codes.delete(f.get("code") ?? "")
        const challenge = createHash("sha256").update(f.get("code_verifier") ?? "").digest("base64url")
        if (!c || c.challenge !== challenge || c.redirect_uri !== f.get("redirect_uri") || c.client_id !== f.get("client_id") || f.get("resource") !== c.resource) return send(res, 400, { error: "invalid_grant" })
        return send(res, 200, issue())
      }
      if (f.get("grant_type") === "refresh_token" && refresh.delete(f.get("refresh_token") ?? "")) return send(res, 200, issue())
      return send(res, 400, { error: "invalid_grant", error_description: "unknown refresh token" })
    }
    if (url.pathname === "/mcp") {
      const bearer = req.headers.authorization?.replace(/^Bearer /, "")
      if (!bearer || !access.has(bearer)) {
        res.writeHead(401, { "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` })
        return res.end()
      }
      if (req.method === "DELETE") {
        seen.deleted = true
        res.writeHead(200)
        return res.end()
      }
      const msg = JSON.parse(body) as { id?: number; method: string; params?: { cursor?: string } }
      if (msg.method === "initialize") {
        // Response over SSE, stream left open: the client must stop as soon as the response is received.
        res.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": "sess-1" })
        res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake-mcp", version: "1.0" } } })}\n\n`)
        return
      }
      seen.sessionHeader = String(req.headers["mcp-session-id"] ?? "")
      if (msg.method === "notifications/initialized") {
        seen.initializedNotification = true
        res.writeHead(202)
        return res.end()
      }
      if (msg.method === "tools/list") {
        const page = msg.params?.cursor === "p2" ? TOOLS.slice(2) : TOOLS.slice(0, 2)
        return send(res, 200, { jsonrpc: "2.0", id: msg.id, result: { tools: page.map((name) => ({ name, inputSchema: { type: "object" } })), ...(msg.params?.cursor ? {} : { nextCursor: "p2" }) } })
      }
      return send(res, 200, { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "unknown method" } })
    }
    if (url.pathname === "/callback") return send(res, 200, { ok: true })
    send(res, 404, { error: "not_found" })
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

after(() => {
  server.closeAllConnections()
  server.close()
})

test("remote MCP: discovery, registration, sign-in, PKCE code, tools, refresh", async () => {
  const serverUrl = `${base}/mcp`
  const redirectUri = `${base}/callback`

  const found = await discover(serverUrl, deps)
  assert.equal(found.open, false)
  assert.ok(found.meta)
  const meta = found.meta
  assert.equal(meta.token_endpoint, `${base}/auth/token`)
  assert.deepEqual(meta.scopes, ["read"])
  assert.equal(meta.resource, `${base}/mcp`)

  const client = await registerClient(meta, redirectUri, deps)
  assert.equal(client.client_id, "client_1")
  assert.equal(client.dynamic, true)

  // The browser follows the sign-in address; the provider redirects to our redirect URI with the code.
  const { verifier, challenge } = pkcePair()
  const authorize = await guardedRequest(buildAuthorizeUrl(meta, { client_id: client.client_id, redirect_uri: redirectUri, state: "state-1", code_challenge: challenge }), { redirects: 0 }, deps)
  assert.equal(authorize.status, 302)
  const back = new URL(authorize.headers.location)
  assert.equal(back.searchParams.get("state"), "state-1")
  const code = back.searchParams.get("code")!

  await assert.rejects(exchangeCode(meta, client, { code, verifier: "wrong-verifier", redirect_uri: redirectUri }, deps), /invalid_grant/, "PKCE: wrong verifier refused")
  // The code was used up by the failed attempt: ask for another one.
  const again = await guardedRequest(buildAuthorizeUrl(meta, { client_id: client.client_id, redirect_uri: redirectUri, state: "state-2", code_challenge: challenge }), { redirects: 0 }, deps)
  const tokens = await exchangeCode(meta, client, { code: new URL(again.headers.location).searchParams.get("code")!, verifier, redirect_uri: redirectUri }, deps)
  assert.ok(tokens.access_token.startsWith("at_"))
  assert.ok(tokens.expires_at && tokens.expires_at > Date.now())

  await assert.rejects(listTools(serverUrl, undefined, deps), McpAuthError)
  const result = await listTools(serverUrl, tokens.access_token, deps)
  assert.deepEqual(result.tools, TOOLS, "two pages of tools")
  assert.equal(result.server, "fake-mcp 1.0")
  assert.equal(seen.sessionHeader, "sess-1", "session id sent back")
  assert.equal(seen.initializedNotification, true)

  // Token revoked on the provider's side: 401, then refresh.
  access.delete(tokens.access_token)
  await assert.rejects(listTools(serverUrl, tokens.access_token, deps), McpAuthError)
  const next = await refreshTokens(meta, client, tokens, deps)
  assert.notEqual(next.access_token, tokens.access_token)
  assert.deepEqual((await listTools(serverUrl, next.access_token, deps)).tools, TOOLS)
  await assert.rejects(refreshTokens(meta, client, tokens, deps), /unknown refresh token/, "old refresh token used up")
})

test("remote MCP: internal addresses refused without test dependencies (SSRF)", async () => {
  await assert.rejects(guardedRequest(`${base}/mcp`, { method: "POST", body: "{}" }), /internal address refused/)
  await assert.rejects(guardedRequest("http://localhost:1/x"), /internal address refused/)
  await assert.rejects(discover("http://169.254.169.254/latest/meta-data"), /internal address refused/)
})

test("scopes: those of the challenge, otherwise a short advertised list; a long list is not requested wholesale", () => {
  const many = Array.from({ length: MAX_DEFAULT_SCOPES + 1 }, (_, i) => `scope${i}:write`)
  assert.deepEqual(pickScopes("read write", many), ["read", "write"])
  assert.deepEqual(pickScopes(undefined, ["read", "none", 3]), ["read"])
  assert.equal(pickScopes(undefined, many), undefined)
  assert.equal(pickScopes(undefined, []), undefined)
  assert.equal(pickScopes(undefined, undefined), undefined)
})
