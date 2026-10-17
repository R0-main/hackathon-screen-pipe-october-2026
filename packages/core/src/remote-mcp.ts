// Remote MCP connectors (Streamable HTTP): the catalog of official servers and the pure part of the MCP protocol's
// OAuth authorization (spec 2025-06-18) — reading WWW-Authenticate, discovery addresses (RFC 9728, RFC 8414, OpenID),
// PKCE authorization URL, token responses, JSON-RPC messages received over SSE. No network or crypto here (module also
// imported by the browser): the calls are in apps/web/lib/remote-mcp.

export type McpCategory = "productivity" | "dev" | "crm" | "finance" | "design" | "communication" | "automation" | "knowledge"

export const MCP_CATEGORIES: readonly McpCategory[] = ["productivity", "dev", "crm", "finance", "design", "communication", "automation", "knowledge"]

/**
 * How access is obtained:
 * - `dynamic`: OAuth with dynamic client registration (RFC 7591) — one click, redirect to the sign-in page;
 * - `manual`: OAuth, but the provider requires an app declared by hand (client_id / secret);
 * - `none`: public server, no sign-in.
 */
export type McpAuthKind = "dynamic" | "manual" | "none"

export type McpCatalogEntry = {
  id: string
  name: string
  url: string
  category: McpCategory
  auth: McpAuthKind
  /** Logo key (components/mcp-logos.tsx); without a known logo: monogram in the brand color. */
  logo?: string
  /** Brand color (monogram and fallback). */
  color: string
  description: string
  /** Where to declare the OAuth app (`manual` auth). */
  setup_url?: string
  /** The server also accepts a personal token as Bearer (e.g. GitHub). */
  token_ok?: boolean
}

const e = (
  id: string,
  name: string,
  url: string,
  category: McpCategory,
  auth: McpAuthKind,
  color: string,
  description: string,
  extra: Partial<Pick<McpCatalogEntry, "logo" | "setup_url" | "token_ok">> = {},
): McpCatalogEntry => ({ id, name, url, category, auth, color, description, logo: id, ...extra })

/**
 * Official remote MCP servers, checked live (October 2026): 401 + RFC 9728 metadata, authorization server with
 * PKCE S256, and dynamic registration for the `dynamic` ones. Order: by category then name.
 */
export const MCP_CATALOG: readonly McpCatalogEntry[] = [
  // Productivity
  e("notion", "Notion", "https://mcp.notion.com/mcp", "productivity", "dynamic", "#000000", "Pages, databases and wikis of the workspace."),
  e("asana", "Asana", "https://mcp.asana.com/v2/mcp", "productivity", "manual", "#F06A6A", "Projects, tasks and goals.", { setup_url: "https://app.asana.com/0/my-apps" }),
  e("monday", "monday.com", "https://mcp.monday.com/mcp", "productivity", "dynamic", "#6161FF", "Boards, items and updates."),
  e("clickup", "ClickUp", "https://mcp.clickup.com/mcp", "productivity", "dynamic", "#7B68EE", "Tasks, docs and spaces."),
  e("todoist", "Todoist", "https://ai.todoist.net/mcp", "productivity", "dynamic", "#E44332", "Personal and team tasks and projects."),
  e("airtable", "Airtable", "https://mcp.airtable.com/mcp", "productivity", "dynamic", "#18BFFF", "Bases, tables and records."),
  e("miro", "Miro", "https://mcp.miro.com", "productivity", "dynamic", "#050038", "Whiteboards and workshops."),
  e("box", "Box", "https://mcp.box.com", "productivity", "manual", "#0061D5", "Shared files and folders.", { setup_url: "https://app.box.com/developers/console" }),
  e("dropbox", "Dropbox", "https://mcp.dropbox.com/mcp", "productivity", "dynamic", "#0061FF", "Files and folders."),
  e("google-drive", "Google Drive", "https://drivemcp.googleapis.com/mcp/v1", "productivity", "manual", "#4285F4", "Docs, sheets and slides.", { logo: "googledrive", setup_url: "https://console.cloud.google.com/apis/credentials" }),
  // Development
  e("linear", "Linear", "https://mcp.linear.app/mcp", "dev", "dynamic", "#5E6AD2", "Issues, projects and cycles."),
  e("github", "GitHub", "https://api.githubcopilot.com/mcp/", "dev", "manual", "#181717", "Repositories, issues and pull requests.", { setup_url: "https://github.com/settings/developers", token_ok: true }),
  e("gitlab", "GitLab", "https://gitlab.com/api/v4/mcp", "dev", "dynamic", "#FC6D26", "Projects, issues and merge requests."),
  e("atlassian", "Jira & Confluence", "https://mcp.atlassian.com/v1/mcp", "dev", "dynamic", "#0052CC", "Jira tickets and Confluence pages (Atlassian Cloud)."),
  e("sentry", "Sentry", "https://mcp.sentry.dev/mcp", "dev", "dynamic", "#362D59", "Errors, issues and performance."),
  e("pagerduty", "PagerDuty", "https://mcp.pagerduty.com/mcp", "dev", "manual", "#06AC38", "Incidents, on-call and services.", { setup_url: "https://support.pagerduty.com/main/docs/oauth-2-functionality" }),
  e("vercel", "Vercel", "https://mcp.vercel.com", "dev", "dynamic", "#000000", "Projects, deployments and logs."),
  e("netlify", "Netlify", "https://netlify-mcp.netlify.app/mcp", "dev", "dynamic", "#00C7B7", "Sites and deploys."),
  e("cloudflare", "Cloudflare Workers", "https://bindings.mcp.cloudflare.com/mcp", "dev", "dynamic", "#F38020", "Account Workers, KV, R2 and D1."),
  e("supabase", "Supabase", "https://mcp.supabase.com/mcp", "dev", "dynamic", "#3FCF8E", "Projects, Postgres database and functions."),
  e("neon", "Neon", "https://mcp.neon.tech/mcp", "dev", "dynamic", "#34D59A", "Serverless Postgres databases and branches."),
  e("sanity", "Sanity", "https://mcp.sanity.io", "dev", "dynamic", "#0D0E12", "CMS content and schemas."),
  e("huggingface", "Hugging Face", "https://huggingface.co/mcp", "dev", "dynamic", "#FFD21E", "Models, datasets and Spaces."),
  // CRM and support
  e("hubspot", "HubSpot", "https://mcp.hubspot.com", "crm", "manual", "#FF7A59", "Contacts, companies and deals.", { setup_url: "https://developers.hubspot.com/docs/apps/developer-platform/build-apps/integrate-with-the-remote-hubspot-mcp-server" }),
  e("attio", "Attio", "https://mcp.attio.com/mcp", "crm", "dynamic", "#000000", "CRM people, companies and lists."),
  e("close", "Close", "https://mcp.close.com/mcp", "crm", "dynamic", "#1A73E8", "Leads, opportunities and sales activities."),
  e("intercom", "Intercom", "https://mcp.intercom.com/mcp", "crm", "dynamic", "#000000", "Support conversations and contacts."),
  // Finance
  e("stripe", "Stripe", "https://mcp.stripe.com", "finance", "dynamic", "#635BFF", "Customers, payments, subscriptions and invoices."),
  e("paypal", "PayPal", "https://mcp.paypal.com/mcp", "finance", "dynamic", "#002991", "Transactions, invoices and disputes."),
  e("square", "Square", "https://mcp.squareup.com/mcp", "finance", "dynamic", "#3E4348", "Sales, catalog and customers."),
  e("qonto", "Qonto", "https://mcp.qonto.com/mcp", "finance", "dynamic", "#6B5AED", "Accounts, transactions and receipts."),
  e("pennylane", "Pennylane", "https://mcp.pennylane.com/mcp", "finance", "dynamic", "#00A887", "Accounting, invoices and cash."),
  e("ramp", "Ramp", "https://mcp.ramp.com/mcp", "finance", "dynamic", "#000000", "Spend, cards and reimbursements."),
  // Design and sites
  e("figma", "Figma", "https://mcp.figma.com/mcp", "design", "dynamic", "#F24E1E", "Design files, components and variables."),
  e("canva", "Canva", "https://mcp.canva.com/mcp", "design", "dynamic", "#00C4CC", "Designs and templates."),
  e("webflow", "Webflow", "https://mcp.webflow.com/mcp", "design", "dynamic", "#146EF5", "Sites, pages and CMS collections."),
  e("wix", "Wix", "https://mcp.wix.com/mcp", "design", "dynamic", "#0C6EFC", "Sites, store and bookings."),
  // Communication
  e("slack", "Slack", "https://mcp.slack.com/mcp", "communication", "manual", "#4A154B", "Channels, messages and threads.", { setup_url: "https://api.slack.com/apps" }),
  e("gmail", "Gmail", "https://gmailmcp.googleapis.com/mcp/v1", "communication", "manual", "#EA4335", "Emails and threads.", { setup_url: "https://console.cloud.google.com/apis/credentials" }),
  e("google-calendar", "Google Calendar", "https://calendarmcp.googleapis.com/mcp/v1", "communication", "manual", "#4285F4", "Events and availability.", { logo: "googlecalendar", setup_url: "https://console.cloud.google.com/apis/credentials" }),
  // Automation
  e("zapier", "Zapier", "https://mcp.zapier.com/api/mcp/mcp", "automation", "dynamic", "#FF4F00", "Thousands of apps through your Zapier actions."),
  e("jotform", "Jotform", "https://mcp.jotform.com", "automation", "dynamic", "#FF6100", "Forms and submissions."),
  // Public documentation
  e("cloudflare-docs", "Cloudflare Docs", "https://docs.mcp.cloudflare.com/mcp", "knowledge", "none", "#F38020", "Cloudflare documentation, no account needed.", { logo: "cloudflare" }),
  e("microsoft-learn", "Microsoft Learn", "https://learn.microsoft.com/api/mcp", "knowledge", "none", "#0078D4", "Microsoft and Azure docs, no account needed."),
]

export function catalogEntry(id: string): McpCatalogEntry | undefined {
  return MCP_CATALOG.find((c) => c.id === id)
}

// ---------------------------------------------------------------------------------------------------------------------
// Saved configuration (company settings) and public view

export type McpTokens = { access_token: string; refresh_token?: string; token_type?: string; scope?: string; expires_at?: number }

export type McpClient = {
  client_id: string
  client_secret?: string
  /** Authentication method at the token endpoint: none, client_secret_post, client_secret_basic. */
  auth_method?: string
  /** Client obtained by dynamic registration (done again if the redirect URI changes). */
  dynamic?: boolean
  redirect_uri?: string
}

/** Discovered metadata (cached with the connector). */
export type McpOAuthMeta = {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  registration_endpoint?: string
  scopes?: string[]
  resource: string
  token_auth_methods?: string[]
}

export type McpCheck = { at: string; ok: boolean; tools: string[]; server?: string; error?: string }

/** Pages to come back to after signing in at the provider: the Connectors page, or company creation (step 8). */
export const MCP_RETURN_PAGES = { connectors: "/connectors", create: "/create?draft=1" } as const
export type McpReturn = keyof typeof MCP_RETURN_PAGES

export function isMcpReturn(v: unknown): v is McpReturn {
  return typeof v === "string" && Object.hasOwn(MCP_RETURN_PAGES, v)
}

export type McpPending = { state: string; verifier: string; redirect_uri: string; by: string; created_at: number; return_to?: McpReturn }

export type McpConnectorConfig = {
  id: string
  /** Catalog entry; absent: server added by hand. */
  catalog_id?: string
  name: string
  url: string
  auth: McpAuthKind | "token"
  enabled: boolean
  added_at: string
  client?: McpClient
  oauth?: McpOAuthMeta
  tokens?: McpTokens
  /** Personal token (`token` auth, or a server that accepts it). */
  token?: string
  pending?: McpPending
  last_check?: McpCheck
  /** Tools offered to the team's agents through the brain's MCP (default: read-only). */
  agents?: McpAgentsMode
  /** Zone it belongs to: those who read it see the tools; the import files content there (none: whole team, auto classification). */
  zone?: string
  /** Importing the content into the brain (Claude explores the tool read-only). */
  import?: { enabled: boolean; last_run?: McpImportRun }
}

/** `off`: no tools; `read`: read-only tools; `all`: all tools (writes included). */
export type McpAgentsMode = "off" | "read" | "all"
export const MCP_AGENTS_MODES: readonly McpAgentsMode[] = ["off", "read", "all"]

export type McpImportRun = { at: string; ok: boolean; imported: number; skipped?: number; calls?: number; error?: string; duration_ms?: number }

export type McpConnectorsConfig = Record<string, McpConnectorConfig>

export type McpStatus = "connected" | "needs_auth" | "error"

/** What the dashboard receives: never a token, a secret or a PKCE verifier. */
export type McpConnectorPublic = {
  id: string
  catalog_id?: string
  name: string
  url: string
  auth: McpAuthKind | "token"
  enabled: boolean
  status: McpStatus
  has_client: boolean
  has_token: boolean
  last_check?: McpCheck
  agents: McpAgentsMode
  zone?: string
  import_enabled: boolean
  last_import?: McpImportRun
}

export function hasAccess(c: McpConnectorConfig): boolean {
  if (c.auth === "none") return true
  return Boolean(c.token || c.tokens?.access_token)
}

export function publicMcpConnector(c: McpConnectorConfig): McpConnectorPublic {
  const access = hasAccess(c)
  const status: McpStatus = !access ? "needs_auth" : c.last_check && !c.last_check.ok ? "error" : "connected"
  return {
    id: c.id,
    catalog_id: c.catalog_id,
    name: c.name,
    url: c.url,
    auth: c.auth,
    enabled: c.enabled,
    status,
    has_client: Boolean(c.client?.client_id),
    has_token: Boolean(c.token || c.tokens?.access_token),
    last_check: c.last_check,
    agents: c.agents ?? "read",
    zone: c.zone,
    import_enabled: Boolean(c.import?.enabled),
    last_import: c.import?.last_run,
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Addresses and discovery

/** Acceptable MCP server address: https (http only for localhost, in development), without credentials. */
export function validateMcpUrl(raw: string, opts: { allowHttp?: boolean } = {}): { url: string } | { error: string } {
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    return { error: "invalid address" }
  }
  if (u.protocol !== "https:" && !(opts.allowHttp && u.protocol === "http:")) return { error: "the server must use https" }
  if (u.username || u.password) return { error: "credentials in the address are not allowed" }
  u.hash = ""
  return { url: u.toString() }
}

/** Canonical resource identifier (RFC 8707, MCP spec): no fragment nor lone trailing "/" (URL already lowercases scheme and host). */
export function canonicalResource(raw: string): string {
  const u = new URL(raw)
  const path = u.pathname === "/" && !u.search ? "" : u.pathname
  return `${u.protocol}//${u.host}${path}${u.search}`
}

/** Parameters of a `WWW-Authenticate: Bearer resource_metadata="…", scope="…", error="…"` header. */
export function parseWwwAuthenticate(header: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  const bearer = header.match(/Bearer\s+(.*)$/i)?.[1] ?? ""
  for (const m of bearer.matchAll(/([a-zA-Z_][\w-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g)) out[m[1].toLowerCase()] = m[2] !== undefined ? m[2].replace(/\\(.)/g, "$1") : m[3]
  return out
}

/** Protected resource metadata addresses (RFC 9728) to try: with the server's path, then at the root. */
export function protectedResourceUrls(serverUrl: string): string[] {
  const u = new URL(serverUrl)
  const path = u.pathname.replace(/\/+$/, "")
  const urls = path ? [`${u.origin}/.well-known/oauth-protected-resource${path}`] : []
  urls.push(`${u.origin}/.well-known/oauth-protected-resource`)
  return urls
}

/** Authorization server metadata addresses (RFC 8414 then OpenID Connect, with path insertion). */
export function authServerMetadataUrls(issuer: string): string[] {
  const u = new URL(issuer)
  const path = u.pathname.replace(/\/+$/, "")
  if (!path) return [`${u.origin}/.well-known/oauth-authorization-server`, `${u.origin}/.well-known/openid-configuration`]
  return [`${u.origin}/.well-known/oauth-authorization-server${path}`, `${u.origin}/.well-known/openid-configuration${path}`, `${u.origin}${path}/.well-known/openid-configuration`]
}

type Json = Record<string, unknown>
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined)
const strs = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined)

/** Authorization server metadata → what we need; null if endpoints are missing or PKCE S256 is absent. */
export function readAuthServerMetadata(json: Json, resource: string, scopes?: string[]): McpOAuthMeta | null {
  const authorization_endpoint = str(json.authorization_endpoint)
  const token_endpoint = str(json.token_endpoint)
  if (!authorization_endpoint || !token_endpoint) return null
  const methods = strs(json.code_challenge_methods_supported)
  // The MCP spec requires PKCE; a server that lists its methods without S256 is refused (no list: we try).
  if (methods && methods.length && !methods.includes("S256")) return null
  return {
    issuer: str(json.issuer) ?? new URL(authorization_endpoint).origin,
    authorization_endpoint,
    token_endpoint,
    registration_endpoint: str(json.registration_endpoint),
    // No fallback to the authorization server's scopes_supported: it often lists everything it can do (openid…).
    scopes,
    resource,
    token_auth_methods: strs(json.token_endpoint_auth_methods_supported),
  }
}

/** Client authentication method at the token endpoint. */
export function tokenAuthMethod(client: Pick<McpClient, "client_secret" | "auth_method">, supported?: string[]): "none" | "client_secret_post" | "client_secret_basic" {
  if (!client.client_secret) return "none"
  const m = client.auth_method
  if (m === "client_secret_basic" || m === "client_secret_post") return m
  if (supported?.length && !supported.includes("client_secret_post") && supported.includes("client_secret_basic")) return "client_secret_basic"
  return "client_secret_post"
}

export function buildAuthorizeUrl(meta: McpOAuthMeta, p: { client_id: string; redirect_uri: string; state: string; code_challenge: string }): string {
  const u = new URL(meta.authorization_endpoint)
  u.searchParams.set("response_type", "code")
  u.searchParams.set("client_id", p.client_id)
  u.searchParams.set("redirect_uri", p.redirect_uri)
  u.searchParams.set("state", p.state)
  u.searchParams.set("code_challenge", p.code_challenge)
  u.searchParams.set("code_challenge_method", "S256")
  if (meta.scopes?.length) u.searchParams.set("scope", meta.scopes.join(" "))
  u.searchParams.set("resource", meta.resource)
  return u.toString()
}

/** Token endpoint response (JSON, or form-encoded with some providers) → tokens; throws on an OAuth error. */
export function parseTokenResponse(body: string, contentType: string, now = Date.now()): McpTokens {
  let data: Json = {}
  if (/json/i.test(contentType) || /^\s*\{/.test(body)) {
    try {
      data = JSON.parse(body) as Json
    } catch {
      throw new Error("unreadable authorization server response")
    }
  } else data = Object.fromEntries(new URLSearchParams(body))
  if (str(data.error)) throw new Error(`${data.error}${str(data.error_description) ? `: ${data.error_description}` : ""}`)
  const access_token = str(data.access_token)
  if (!access_token) throw new Error("no access token in the response")
  const expiresIn = Number(data.expires_in)
  return {
    access_token,
    refresh_token: str(data.refresh_token),
    token_type: str(data.token_type),
    scope: str(data.scope),
    expires_at: Number.isFinite(expiresIn) && expiresIn > 0 ? now + expiresIn * 1000 : undefined,
  }
}

/** The token expires in less than a minute (to refresh before the call). */
export function tokenExpiring(t: McpTokens | undefined, now = Date.now()): boolean {
  return Boolean(t?.expires_at && t.expires_at - now < 60_000)
}

// ---------------------------------------------------------------------------------------------------------------------
// JSON-RPC over Streamable HTTP

export type JsonRpcMessage = { jsonrpc: "2.0"; id?: string | number | null; method?: string; result?: unknown; error?: { code: number; message: string } }

/** Messages of an SSE stream (`data:` lines of one event joined); the text may be cut at the end. */
export function parseSseMessages(text: string): JsonRpcMessage[] {
  const out: JsonRpcMessage[] = []
  for (const block of text.replace(/\r\n?/g, "\n").split("\n\n")) {
    const data = block
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).replace(/^ /, ""))
      .join("\n")
    if (!data) continue
    try {
      const msg = JSON.parse(data) as JsonRpcMessage | JsonRpcMessage[]
      for (const m of Array.isArray(msg) ? msg : [msg]) if (m && typeof m === "object") out.push(m)
    } catch {
      // incomplete event (end of buffer) or not JSON
    }
  }
  return out
}

/** The response to request `id` in a JSON or SSE body, if it has arrived. */
export function findResponse(body: string, contentType: string, id: number | string): JsonRpcMessage | null {
  let msgs: JsonRpcMessage[] = []
  if (/text\/event-stream/i.test(contentType)) msgs = parseSseMessages(body)
  else {
    try {
      const parsed = JSON.parse(body) as JsonRpcMessage | JsonRpcMessage[]
      msgs = Array.isArray(parsed) ? parsed : [parsed]
    } catch {
      return null
    }
  }
  return msgs.find((m) => m.id === id && (m.result !== undefined || m.error !== undefined)) ?? null
}

// ---------------------------------------------------------------------------------------------------------------------
// Connector tools, offered to the team's agents by the brain's MCP, and importing their content

/** A tool of a connected MCP server, as cached (JSON Schema input schema). */
export type McpToolDef = { name: string; title?: string; description?: string; input_schema: Record<string, unknown>; read_only: boolean }

const WRITE_VERB = /^(create|update|delete|remove|add|set|send|post|write|edit|move|archive|merge|close|assign|upload|invite|publish|cancel|refund|run|execute|trigger|deploy|duplicate|copy|rename|reply|mark|complete|batch|bulk|upsert|patch|put|insert|apply|approve|reject|start|stop)$/
const READ_VERB = /^(search|list|get|fetch|read|query|find|retrieve|lookup|describe|show|view|count|whoami)$/

/**
 * Tool without side effects? The server's `readOnlyHint` annotation decides. Without an annotation: no word of the name
 * is a write verb, and a read verb comes first, after a brand prefix, or last ("search_issues", "linear_list_projects",
 * "microsoft_docs_search"). When in doubt, the tool counts as a write.
 */
export function isReadOnlyTool(t: { name: string; annotations?: { readOnlyHint?: unknown } | null }): boolean {
  if (typeof t.annotations?.readOnlyHint === "boolean") return t.annotations.readOnlyHint
  const words = t.name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[_\-.:\s]+/)
    .filter(Boolean)
  if (!words.length || words.some((w) => WRITE_VERB.test(w))) return false
  return READ_VERB.test(words[0]) || READ_VERB.test(words[1] ?? "") || READ_VERB.test(words[words.length - 1])
}

/** A connector's tools visible to agents under the rule the admin chose. */
export function toolsForAgents(defs: McpToolDef[], mode: McpAgentsMode): McpToolDef[] {
  if (mode === "off") return []
  return mode === "all" ? defs : defs.filter((d) => d.read_only)
}

/** Result of a `tools/call` → text for the agent (text, text resources, mentions of binary content). */
export function callResultText(result: unknown, maxChars = 40_000): { text: string; is_error: boolean } {
  const r = (result ?? {}) as { content?: unknown; structuredContent?: unknown; isError?: unknown }
  const parts: string[] = []
  for (const c of Array.isArray(r.content) ? r.content : []) {
    const b = c as { type?: string; text?: unknown; resource?: { uri?: string; text?: unknown; mimeType?: string }; uri?: string; name?: string; mimeType?: string }
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text)
    else if (b.type === "resource" && b.resource) parts.push(typeof b.resource.text === "string" ? b.resource.text : `[resource ${b.resource.uri ?? ""} (${b.resource.mimeType ?? "binary"})]`)
    else if (b.type === "resource_link") parts.push(`[link ${b.name ?? ""} ${b.uri ?? ""}]`.trim())
    else if (b.type === "image" || b.type === "audio") parts.push(`[${b.type} ${b.mimeType ?? ""} not passed on]`.trim())
  }
  if (!parts.length && r.structuredContent !== undefined) parts.push(JSON.stringify(r.structuredContent))
  const text = parts.join("\n\n").trim() || "(empty response)"
  return { text: text.length > maxChars ? `${text.slice(0, maxChars)}\n… (truncated at ${maxChars} characters)` : text, is_error: r.isError === true }
}

/** Interval between two automatic imports (Claude reads the tool: paid calls, so spaced out). */
export const MCP_IMPORT_INTERVAL_MS = 6 * 60 * 60_000

export function mcpImportDue(c: McpConnectorConfig | undefined, now = Date.now()): boolean {
  if (!c?.enabled || !c.import?.enabled || !hasAccess(c)) return false
  const last = c.import.last_run
  return !last || now - Date.parse(last.at) >= MCP_IMPORT_INTERVAL_MS
}

/** Tool name accepted by the Claude API (^[a-zA-Z0-9_-]{1,64}$), unique in the list. */
export function claudeToolName(name: string, taken: Set<string>): string {
  const base = name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 60) || "tool"
  let out = base
  for (let i = 2; taken.has(out); i++) out = `${base.slice(0, 57)}_${i}`
  taken.add(out)
  return out
}
