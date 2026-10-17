import { test } from "node:test"
import assert from "node:assert/strict"
import {
  MCP_CATALOG,
  MCP_CATEGORIES,
  authServerMetadataUrls,
  buildAuthorizeUrl,
  canonicalResource,
  findResponse,
  parseSseMessages,
  parseTokenResponse,
  parseWwwAuthenticate,
  protectedResourceUrls,
  publicMcpConnector,
  readAuthServerMetadata,
  tokenAuthMethod,
  tokenExpiring,
  validateMcpUrl,
} from "./remote-mcp"

test("catalogue MCP : identifiants uniques, https, catégories connues, application à déclarer documentée", () => {
  const ids = MCP_CATALOG.map((e) => e.id)
  assert.equal(new Set(ids).size, ids.length)
  assert.ok(MCP_CATALOG.length >= 40)
  for (const e of MCP_CATALOG) {
    assert.ok(e.url.startsWith("https://"), e.id)
    assert.ok(MCP_CATEGORIES.includes(e.category), e.id)
    assert.match(e.color, /^#[0-9A-F]{6}$/i, e.id)
    assert.ok(e.description.fr && e.description.en, e.id)
    if (e.auth === "manual") assert.ok(e.setup_url?.startsWith("https://"), `${e.id} : setup_url`)
  }
})

test("WWW-Authenticate : paramètres entre guillemets ou non, échappements", () => {
  const h = 'Bearer error="invalid_token", resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp", scope="read write"'
  assert.deepEqual(parseWwwAuthenticate(h), { error: "invalid_token", resource_metadata: "https://mcp.example.com/.well-known/oauth-protected-resource/mcp", scope: "read write" })
  assert.deepEqual(parseWwwAuthenticate('Bearer realm=api, error_description="a \\"b\\""'), { realm: "api", error_description: 'a "b"' })
  assert.deepEqual(parseWwwAuthenticate(null), {})
})

test("découverte : adresses bien connues avec insertion du chemin (RFC 9728, RFC 8414, OpenID)", () => {
  assert.deepEqual(protectedResourceUrls("https://mcp.linear.app/mcp"), ["https://mcp.linear.app/.well-known/oauth-protected-resource/mcp", "https://mcp.linear.app/.well-known/oauth-protected-resource"])
  assert.deepEqual(protectedResourceUrls("https://mcp.stripe.com"), ["https://mcp.stripe.com/.well-known/oauth-protected-resource"])
  assert.deepEqual(authServerMetadataUrls("https://mcp.notion.com"), ["https://mcp.notion.com/.well-known/oauth-authorization-server", "https://mcp.notion.com/.well-known/openid-configuration"])
  assert.deepEqual(authServerMetadataUrls("https://auth.monday.com/mcp/"), [
    "https://auth.monday.com/.well-known/oauth-authorization-server/mcp",
    "https://auth.monday.com/.well-known/openid-configuration/mcp",
    "https://auth.monday.com/mcp/.well-known/openid-configuration",
  ])
})

test("ressource canonique et adresse de serveur", () => {
  assert.equal(canonicalResource("HTTPS://MCP.Example.com/"), "https://mcp.example.com")
  assert.equal(canonicalResource("https://api.githubcopilot.com/mcp/#x"), "https://api.githubcopilot.com/mcp/")
  assert.deepEqual(validateMcpUrl(" https://mcp.example.com/mcp#frag "), { url: "https://mcp.example.com/mcp" })
  assert.ok("error" in validateMcpUrl("http://mcp.example.com/mcp"))
  assert.deepEqual(validateMcpUrl("http://127.0.0.1:3000/mcp", { allowHttp: true }), { url: "http://127.0.0.1:3000/mcp" })
  assert.ok("error" in validateMcpUrl("https://user:pw@mcp.example.com"))
  assert.ok("error" in validateMcpUrl("pas une adresse"))
})

test("métadonnées du serveur d'autorisation : points d'accès requis, PKCE S256 exigé quand annoncé", () => {
  const base = { issuer: "https://as.example.com", authorization_endpoint: "https://as.example.com/authorize", token_endpoint: "https://as.example.com/token" }
  const meta = readAuthServerMetadata({ ...base, registration_endpoint: "https://as.example.com/register", code_challenge_methods_supported: ["S256"], scopes_supported: ["openid"] }, "https://mcp.example.com/mcp", ["read"])
  assert.equal(meta?.registration_endpoint, "https://as.example.com/register")
  assert.deepEqual(meta?.scopes, ["read"])
  assert.equal(readAuthServerMetadata({ ...base, scopes_supported: ["openid", "email"] }, "r")?.scopes, undefined, "pas de repli sur scopes_supported")
  assert.equal(readAuthServerMetadata({ ...base, code_challenge_methods_supported: ["plain"] }, "r"), null)
  assert.equal(readAuthServerMetadata({ issuer: "x", token_endpoint: "https://as.example.com/token" }, "r"), null)
})

test("URL d'autorisation : PKCE S256, état, ressource et portées", () => {
  const meta = { issuer: "https://as.example.com", authorization_endpoint: "https://as.example.com/authorize?prompt=consent", token_endpoint: "https://as.example.com/token", scopes: ["read", "write"], resource: "https://mcp.example.com/mcp" }
  const u = new URL(buildAuthorizeUrl(meta, { client_id: "abc", redirect_uri: "https://www.nos-brainer.tech/api/connectors/mcp/callback", state: "st", code_challenge: "ch" }))
  assert.equal(u.searchParams.get("prompt"), "consent", "paramètres existants gardés")
  assert.equal(u.searchParams.get("response_type"), "code")
  assert.equal(u.searchParams.get("code_challenge_method"), "S256")
  assert.equal(u.searchParams.get("scope"), "read write")
  assert.equal(u.searchParams.get("resource"), "https://mcp.example.com/mcp")
  assert.equal(u.searchParams.get("redirect_uri"), "https://www.nos-brainer.tech/api/connectors/mcp/callback")
})

test("réponse de jeton : JSON, formulaire, erreur OAuth, expiration", () => {
  const t = parseTokenResponse('{"access_token":"a","refresh_token":"r","expires_in":3600,"token_type":"Bearer"}', "application/json", 1_000)
  assert.deepEqual(t, { access_token: "a", refresh_token: "r", token_type: "Bearer", scope: undefined, expires_at: 3_601_000 })
  assert.equal(parseTokenResponse("access_token=gho_x&scope=repo&token_type=bearer", "application/x-www-form-urlencoded").access_token, "gho_x")
  assert.throws(() => parseTokenResponse('{"error":"invalid_grant","error_description":"code expiré"}', "application/json"), /invalid_grant : code expiré/)
  assert.throws(() => parseTokenResponse("{}", "application/json"), /aucun jeton/)
  assert.equal(tokenExpiring({ access_token: "a", expires_at: 100_000 }, 50_000), true)
  assert.equal(tokenExpiring({ access_token: "a", expires_at: 1_000_000 }, 50_000), false)
  assert.equal(tokenExpiring({ access_token: "a" }), false)
})

test("authentification du client au point de jeton", () => {
  assert.equal(tokenAuthMethod({}), "none")
  assert.equal(tokenAuthMethod({ client_secret: "s" }), "client_secret_post")
  assert.equal(tokenAuthMethod({ client_secret: "s" }, ["client_secret_basic"]), "client_secret_basic")
  assert.equal(tokenAuthMethod({ client_secret: "s", auth_method: "client_secret_basic" }, ["client_secret_post"]), "client_secret_basic")
})

test("JSON-RPC : réponse trouvée en SSE (multi-lignes, notifications avant) ou en JSON", () => {
  const sse = 'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\nevent: message\ndata: {"jsonrpc":"2.0","id":2,\ndata: "result":{"tools":[]}}\n\n'
  assert.equal(parseSseMessages(sse).length, 2)
  assert.deepEqual(findResponse(sse, "text/event-stream", 2)?.result, { tools: [] })
  assert.equal(findResponse(sse.slice(0, 80), "text/event-stream", 2), null, "flux coupé : pas encore de réponse")
  assert.deepEqual(findResponse('{"jsonrpc":"2.0","id":1,"error":{"code":-1,"message":"non"}}', "application/json", 1)?.error, { code: -1, message: "non" })
  assert.equal(findResponse("<html>", "text/html", 1), null)
})

test("vue publique : jamais de secret, statut déduit", () => {
  const c = {
    id: "linear",
    catalog_id: "linear",
    name: "Linear",
    url: "https://mcp.linear.app/mcp",
    auth: "dynamic" as const,
    enabled: true,
    added_at: "2026-10-17T00:00:00.000Z",
    client: { client_id: "cid", client_secret: "SECRET-CLIENT" },
    tokens: { access_token: "SECRET-ACCESS", refresh_token: "SECRET-REFRESH" },
    pending: { state: "SECRET-STATE", verifier: "SECRET-VERIFIER", redirect_uri: "x", by: "u", created_at: 0 },
  }
  const pub = publicMcpConnector(c)
  assert.equal(pub.status, "connected")
  assert.doesNotMatch(JSON.stringify(pub), /SECRET/)
  assert.equal(publicMcpConnector({ ...c, tokens: undefined }).status, "needs_auth")
  assert.equal(publicMcpConnector({ ...c, last_check: { at: "", ok: false, tools: [], error: "x" } }).status, "error")
  assert.equal(publicMcpConnector({ ...c, auth: "none", tokens: undefined }).status, "connected")
})
