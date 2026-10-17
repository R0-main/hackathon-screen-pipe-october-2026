// Parcours complet d'un connecteur MCP contre un faux fournisseur local (serveur MCP + serveur d'autorisation) :
// découverte, enregistrement dynamique, page de connexion, échange du code avec PKCE, liste des outils en SSE avec
// pagination, jeton révoqué puis rafraîchi. Et la protection SSRF : sans dépendances de test, 127.0.0.1 est refusé.

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
      // Page de connexion du fournisseur : ici l'utilisateur accepte tout de suite.
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
      return send(res, 400, { error: "invalid_grant", error_description: "jeton de rafraîchissement inconnu" })
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
        // Réponse en SSE, flux laissé ouvert : le client doit s'arrêter dès la réponse reçue.
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
      return send(res, 200, { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "méthode inconnue" } })
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

test("MCP distant : découverte, enregistrement, connexion, code PKCE, outils, rafraîchissement", async () => {
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

  // Le navigateur suit l'adresse de connexion ; le fournisseur redirige vers notre adresse de retour avec le code.
  const { verifier, challenge } = pkcePair()
  const authorize = await guardedRequest(buildAuthorizeUrl(meta, { client_id: client.client_id, redirect_uri: redirectUri, state: "etat-1", code_challenge: challenge }), { redirects: 0 }, deps)
  assert.equal(authorize.status, 302)
  const back = new URL(authorize.headers.location)
  assert.equal(back.searchParams.get("state"), "etat-1")
  const code = back.searchParams.get("code")!

  await assert.rejects(exchangeCode(meta, client, { code, verifier: "mauvais-verificateur", redirect_uri: redirectUri }, deps), /invalid_grant/, "PKCE : mauvais vérificateur refusé")
  // Le code a été consommé par la tentative ratée : on en redemande un.
  const again = await guardedRequest(buildAuthorizeUrl(meta, { client_id: client.client_id, redirect_uri: redirectUri, state: "etat-2", code_challenge: challenge }), { redirects: 0 }, deps)
  const tokens = await exchangeCode(meta, client, { code: new URL(again.headers.location).searchParams.get("code")!, verifier, redirect_uri: redirectUri }, deps)
  assert.ok(tokens.access_token.startsWith("at_"))
  assert.ok(tokens.expires_at && tokens.expires_at > Date.now())

  await assert.rejects(listTools(serverUrl, undefined, deps), McpAuthError)
  const result = await listTools(serverUrl, tokens.access_token, deps)
  assert.deepEqual(result.tools, TOOLS, "deux pages d'outils")
  assert.equal(result.server, "fake-mcp 1.0")
  assert.equal(seen.sessionHeader, "sess-1", "identifiant de session renvoyé")
  assert.equal(seen.initializedNotification, true)

  // Jeton révoqué côté fournisseur : 401, puis rafraîchissement.
  access.delete(tokens.access_token)
  await assert.rejects(listTools(serverUrl, tokens.access_token, deps), McpAuthError)
  const next = await refreshTokens(meta, client, tokens, deps)
  assert.notEqual(next.access_token, tokens.access_token)
  assert.deepEqual((await listTools(serverUrl, next.access_token, deps)).tools, TOOLS)
  await assert.rejects(refreshTokens(meta, client, tokens, deps), /jeton de rafraîchissement inconnu/, "ancien jeton de rafraîchissement consommé")
})

test("MCP distant : adresses internes refusées sans dépendances de test (SSRF)", async () => {
  await assert.rejects(guardedRequest(`${base}/mcp`, { method: "POST", body: "{}" }), /adresse interne refusée/)
  await assert.rejects(guardedRequest("http://localhost:1/x"), /adresse interne refusée/)
  await assert.rejects(discover("http://169.254.169.254/latest/meta-data"), /adresse interne refusée/)
})

test("portées : celles du défi, sinon une liste courte annoncée ; une longue liste n'est pas demandée en bloc", () => {
  const many = Array.from({ length: MAX_DEFAULT_SCOPES + 1 }, (_, i) => `scope${i}:write`)
  assert.deepEqual(pickScopes("read write", many), ["read", "write"])
  assert.deepEqual(pickScopes(undefined, ["read", "none", 3]), ["read"])
  assert.equal(pickScopes(undefined, many), undefined)
  assert.equal(pickScopes(undefined, []), undefined)
  assert.equal(pickScopes(undefined, undefined), undefined)
})
