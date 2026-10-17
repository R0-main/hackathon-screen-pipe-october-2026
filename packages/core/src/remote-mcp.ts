// Connecteurs MCP distants (Streamable HTTP) : le catalogue des serveurs officiels et la partie pure de l'autorisation
// OAuth du protocole MCP (spec 2025-06-18) — lecture de WWW-Authenticate, adresses de découverte (RFC 9728, RFC 8414,
// OpenID), URL d'autorisation PKCE, réponses de jeton, messages JSON-RPC reçus en SSE. Pas de réseau ni de crypto ici
// (module importé aussi par le navigateur) : les appels sont dans apps/web/lib/remote-mcp.

export type McpCategory = "productivity" | "dev" | "crm" | "finance" | "design" | "communication" | "automation" | "knowledge"

export const MCP_CATEGORIES: readonly McpCategory[] = ["productivity", "dev", "crm", "finance", "design", "communication", "automation", "knowledge"]

/**
 * Comment on obtient un accès :
 * - `dynamic` : OAuth avec enregistrement dynamique du client (RFC 7591) — un clic, redirection vers la page de connexion ;
 * - `manual` : OAuth, mais le fournisseur exige une application déclarée à la main (client_id / secret) ;
 * - `none` : serveur public, sans connexion.
 */
export type McpAuthKind = "dynamic" | "manual" | "none"

export type McpCatalogEntry = {
  id: string
  name: string
  url: string
  category: McpCategory
  auth: McpAuthKind
  /** Clé du logo (components/mcp-logos.tsx) ; sans logo connu : monogramme à la couleur de la marque. */
  logo?: string
  /** Couleur de marque (monogramme et repli). */
  color: string
  description: { fr: string; en: string }
  /** Où déclarer l'application OAuth (auth `manual`). */
  setup_url?: string
  /** Le serveur accepte aussi un jeton personnel en Bearer (ex. GitHub). */
  token_ok?: boolean
}

const e = (
  id: string,
  name: string,
  url: string,
  category: McpCategory,
  auth: McpAuthKind,
  color: string,
  fr: string,
  en: string,
  extra: Partial<Pick<McpCatalogEntry, "logo" | "setup_url" | "token_ok">> = {},
): McpCatalogEntry => ({ id, name, url, category, auth, color, description: { fr, en }, logo: id, ...extra })

/**
 * Serveurs MCP distants officiels, vérifiés en direct (octobre 2026) : 401 + métadonnées RFC 9728, serveur
 * d'autorisation avec PKCE S256, et enregistrement dynamique pour les `dynamic`. Ordre : par catégorie puis nom.
 */
export const MCP_CATALOG: readonly McpCatalogEntry[] = [
  // Productivité
  e("notion", "Notion", "https://mcp.notion.com/mcp", "productivity", "dynamic", "#000000", "Pages, bases de données et wikis de l'espace.", "Pages, databases and wikis of the workspace."),
  e("asana", "Asana", "https://mcp.asana.com/v2/mcp", "productivity", "manual", "#F06A6A", "Projets, tâches et objectifs.", "Projects, tasks and goals.", { setup_url: "https://app.asana.com/0/my-apps" }),
  e("monday", "monday.com", "https://mcp.monday.com/mcp", "productivity", "dynamic", "#6161FF", "Tableaux, éléments et mises à jour.", "Boards, items and updates."),
  e("clickup", "ClickUp", "https://mcp.clickup.com/mcp", "productivity", "dynamic", "#7B68EE", "Tâches, documents et espaces.", "Tasks, docs and spaces."),
  e("todoist", "Todoist", "https://ai.todoist.net/mcp", "productivity", "dynamic", "#E44332", "Tâches et projets personnels ou d'équipe.", "Personal and team tasks and projects."),
  e("airtable", "Airtable", "https://mcp.airtable.com/mcp", "productivity", "dynamic", "#18BFFF", "Bases, tables et enregistrements.", "Bases, tables and records."),
  e("miro", "Miro", "https://mcp.miro.com", "productivity", "dynamic", "#050038", "Tableaux blancs et ateliers.", "Whiteboards and workshops."),
  e("box", "Box", "https://mcp.box.com", "productivity", "manual", "#0061D5", "Fichiers et dossiers partagés.", "Shared files and folders.", { setup_url: "https://app.box.com/developers/console" }),
  e("dropbox", "Dropbox", "https://mcp.dropbox.com/mcp", "productivity", "dynamic", "#0061FF", "Fichiers et dossiers.", "Files and folders."),
  e("google-drive", "Google Drive", "https://drivemcp.googleapis.com/mcp/v1", "productivity", "manual", "#4285F4", "Documents, feuilles et présentations.", "Docs, sheets and slides.", { logo: "googledrive", setup_url: "https://console.cloud.google.com/apis/credentials" }),
  // Développement
  e("linear", "Linear", "https://mcp.linear.app/mcp", "dev", "dynamic", "#5E6AD2", "Issues, projets et cycles.", "Issues, projects and cycles."),
  e("github", "GitHub", "https://api.githubcopilot.com/mcp/", "dev", "manual", "#181717", "Dépôts, issues et pull requests.", "Repositories, issues and pull requests.", { setup_url: "https://github.com/settings/developers", token_ok: true }),
  e("gitlab", "GitLab", "https://gitlab.com/api/v4/mcp", "dev", "dynamic", "#FC6D26", "Projets, issues et merge requests.", "Projects, issues and merge requests."),
  e("atlassian", "Jira & Confluence", "https://mcp.atlassian.com/v1/mcp", "dev", "dynamic", "#0052CC", "Tickets Jira et pages Confluence (Atlassian Cloud).", "Jira tickets and Confluence pages (Atlassian Cloud)."),
  e("sentry", "Sentry", "https://mcp.sentry.dev/mcp", "dev", "dynamic", "#362D59", "Erreurs, incidents et performances.", "Errors, issues and performance."),
  e("pagerduty", "PagerDuty", "https://mcp.pagerduty.com/mcp", "dev", "manual", "#06AC38", "Incidents, astreintes et services.", "Incidents, on-call and services.", { setup_url: "https://support.pagerduty.com/main/docs/oauth-2-functionality" }),
  e("vercel", "Vercel", "https://mcp.vercel.com", "dev", "dynamic", "#000000", "Projets, déploiements et journaux.", "Projects, deployments and logs."),
  e("netlify", "Netlify", "https://netlify-mcp.netlify.app/mcp", "dev", "dynamic", "#00C7B7", "Sites et déploiements.", "Sites and deploys."),
  e("cloudflare", "Cloudflare Workers", "https://bindings.mcp.cloudflare.com/mcp", "dev", "dynamic", "#F38020", "Workers, KV, R2 et D1 du compte.", "Account Workers, KV, R2 and D1."),
  e("supabase", "Supabase", "https://mcp.supabase.com/mcp", "dev", "dynamic", "#3FCF8E", "Projets, base Postgres et fonctions.", "Projects, Postgres database and functions."),
  e("neon", "Neon", "https://mcp.neon.tech/mcp", "dev", "dynamic", "#34D59A", "Bases Postgres serverless et branches.", "Serverless Postgres databases and branches."),
  e("sanity", "Sanity", "https://mcp.sanity.io", "dev", "dynamic", "#0D0E12", "Contenus et schémas du CMS.", "CMS content and schemas."),
  e("huggingface", "Hugging Face", "https://huggingface.co/mcp", "dev", "dynamic", "#FFD21E", "Modèles, jeux de données et Spaces.", "Models, datasets and Spaces."),
  // CRM et support
  e("hubspot", "HubSpot", "https://mcp.hubspot.com", "crm", "manual", "#FF7A59", "Contacts, entreprises et transactions.", "Contacts, companies and deals.", { setup_url: "https://developers.hubspot.com/docs/apps/developer-platform/build-apps/integrate-with-the-remote-hubspot-mcp-server" }),
  e("attio", "Attio", "https://mcp.attio.com/mcp", "crm", "dynamic", "#000000", "Contacts, entreprises et listes du CRM.", "CRM people, companies and lists."),
  e("close", "Close", "https://mcp.close.com/mcp", "crm", "dynamic", "#1A73E8", "Leads, opportunités et activités commerciales.", "Leads, opportunities and sales activities."),
  e("intercom", "Intercom", "https://mcp.intercom.com/mcp", "crm", "dynamic", "#000000", "Conversations et contacts du support.", "Support conversations and contacts."),
  // Finance
  e("stripe", "Stripe", "https://mcp.stripe.com", "finance", "dynamic", "#635BFF", "Clients, paiements, abonnements et factures.", "Customers, payments, subscriptions and invoices."),
  e("paypal", "PayPal", "https://mcp.paypal.com/mcp", "finance", "dynamic", "#002991", "Transactions, factures et litiges.", "Transactions, invoices and disputes."),
  e("square", "Square", "https://mcp.squareup.com/mcp", "finance", "dynamic", "#3E4348", "Ventes, catalogue et clients.", "Sales, catalog and customers."),
  e("qonto", "Qonto", "https://mcp.qonto.com/mcp", "finance", "dynamic", "#6B5AED", "Comptes, transactions et justificatifs.", "Accounts, transactions and receipts."),
  e("pennylane", "Pennylane", "https://mcp.pennylane.com/mcp", "finance", "dynamic", "#00A887", "Comptabilité, factures et trésorerie.", "Accounting, invoices and cash."),
  e("ramp", "Ramp", "https://mcp.ramp.com/mcp", "finance", "dynamic", "#000000", "Dépenses, cartes et remboursements.", "Spend, cards and reimbursements."),
  // Design et sites
  e("figma", "Figma", "https://mcp.figma.com/mcp", "design", "dynamic", "#F24E1E", "Fichiers de design, composants et variables.", "Design files, components and variables."),
  e("canva", "Canva", "https://mcp.canva.com/mcp", "design", "dynamic", "#00C4CC", "Designs et modèles.", "Designs and templates."),
  e("webflow", "Webflow", "https://mcp.webflow.com/mcp", "design", "dynamic", "#146EF5", "Sites, pages et collections CMS.", "Sites, pages and CMS collections."),
  e("wix", "Wix", "https://mcp.wix.com/mcp", "design", "dynamic", "#0C6EFC", "Sites, boutique et réservations.", "Sites, store and bookings."),
  // Communication
  e("slack", "Slack", "https://mcp.slack.com/mcp", "communication", "manual", "#4A154B", "Canaux, messages et fils.", "Channels, messages and threads.", { setup_url: "https://api.slack.com/apps" }),
  e("gmail", "Gmail", "https://gmailmcp.googleapis.com/mcp/v1", "communication", "manual", "#EA4335", "E-mails et fils de discussion.", "Emails and threads.", { setup_url: "https://console.cloud.google.com/apis/credentials" }),
  e("google-calendar", "Google Calendar", "https://calendarmcp.googleapis.com/mcp/v1", "communication", "manual", "#4285F4", "Événements et disponibilités.", "Events and availability.", { logo: "googlecalendar", setup_url: "https://console.cloud.google.com/apis/credentials" }),
  // Automatisation
  e("zapier", "Zapier", "https://mcp.zapier.com/api/mcp/mcp", "automation", "dynamic", "#FF4F00", "Des milliers d'applications via vos actions Zapier.", "Thousands of apps through your Zapier actions."),
  e("jotform", "Jotform", "https://mcp.jotform.com", "automation", "dynamic", "#FF6100", "Formulaires et réponses.", "Forms and submissions."),
  // Documentation publique
  e("cloudflare-docs", "Cloudflare Docs", "https://docs.mcp.cloudflare.com/mcp", "knowledge", "none", "#F38020", "Documentation Cloudflare, sans compte.", "Cloudflare documentation, no account needed.", { logo: "cloudflare" }),
  e("microsoft-learn", "Microsoft Learn", "https://learn.microsoft.com/api/mcp", "knowledge", "none", "#0078D4", "Documentation Microsoft et Azure, sans compte.", "Microsoft and Azure docs, no account needed."),
]

export function catalogEntry(id: string): McpCatalogEntry | undefined {
  return MCP_CATALOG.find((c) => c.id === id)
}

// ---------------------------------------------------------------------------------------------------------------------
// Configuration enregistrée (réglages de l'entreprise) et vue publique

export type McpTokens = { access_token: string; refresh_token?: string; token_type?: string; scope?: string; expires_at?: number }

export type McpClient = {
  client_id: string
  client_secret?: string
  /** Méthode d'authentification au point de jeton : none, client_secret_post, client_secret_basic. */
  auth_method?: string
  /** Client obtenu par enregistrement dynamique (refait si l'adresse de retour change). */
  dynamic?: boolean
  redirect_uri?: string
}

/** Métadonnées découvertes (mises en cache avec le connecteur). */
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

/** Pages où revenir après la connexion chez le fournisseur : la page Connecteurs, ou la création d'entreprise (étape 8). */
export const MCP_RETURN_PAGES = { connecteurs: "/connecteurs", creer: "/creer?brouillon=1" } as const
export type McpReturn = keyof typeof MCP_RETURN_PAGES

export function isMcpReturn(v: unknown): v is McpReturn {
  return typeof v === "string" && Object.hasOwn(MCP_RETURN_PAGES, v)
}

export type McpPending = { state: string; verifier: string; redirect_uri: string; by: string; created_at: number; return_to?: McpReturn }

export type McpConnectorConfig = {
  id: string
  /** Entrée du catalogue ; absente : serveur ajouté à la main. */
  catalog_id?: string
  name: string
  url: string
  auth: McpAuthKind | "token"
  enabled: boolean
  added_at: string
  client?: McpClient
  oauth?: McpOAuthMeta
  tokens?: McpTokens
  /** Jeton personnel (auth `token`, ou serveur qui l'accepte). */
  token?: string
  pending?: McpPending
  last_check?: McpCheck
}

export type McpConnectorsConfig = Record<string, McpConnectorConfig>

export type McpStatus = "connected" | "needs_auth" | "error"

/** Ce que reçoit le dashboard : jamais de jeton, de secret ni de vérificateur PKCE. */
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
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Adresses et découverte

/** Adresse de serveur MCP acceptable : https (http seulement pour localhost, en développement), sans identifiants. */
export function validateMcpUrl(raw: string, opts: { allowHttp?: boolean } = {}): { url: string } | { error: string } {
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    return { error: "adresse invalide" }
  }
  if (u.protocol !== "https:" && !(opts.allowHttp && u.protocol === "http:")) return { error: "le serveur doit être en https" }
  if (u.username || u.password) return { error: "identifiants dans l'adresse refusés" }
  u.hash = ""
  return { url: u.toString() }
}

/** Identifiant de ressource canonique (RFC 8707, spec MCP) : sans fragment ni « / » final seul (URL met déjà schéma et hôte en minuscules). */
export function canonicalResource(raw: string): string {
  const u = new URL(raw)
  const path = u.pathname === "/" && !u.search ? "" : u.pathname
  return `${u.protocol}//${u.host}${path}${u.search}`
}

/** Paramètres d'un en-tête `WWW-Authenticate: Bearer resource_metadata="…", scope="…", error="…"`. */
export function parseWwwAuthenticate(header: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  const bearer = header.match(/Bearer\s+(.*)$/i)?.[1] ?? ""
  for (const m of bearer.matchAll(/([a-zA-Z_][\w-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g)) out[m[1].toLowerCase()] = m[2] !== undefined ? m[2].replace(/\\(.)/g, "$1") : m[3]
  return out
}

/** Adresses des métadonnées de ressource protégée (RFC 9728) à essayer : avec le chemin du serveur, puis à la racine. */
export function protectedResourceUrls(serverUrl: string): string[] {
  const u = new URL(serverUrl)
  const path = u.pathname.replace(/\/+$/, "")
  const urls = path ? [`${u.origin}/.well-known/oauth-protected-resource${path}`] : []
  urls.push(`${u.origin}/.well-known/oauth-protected-resource`)
  return urls
}

/** Adresses des métadonnées du serveur d'autorisation (RFC 8414 puis OpenID Connect, avec insertion du chemin). */
export function authServerMetadataUrls(issuer: string): string[] {
  const u = new URL(issuer)
  const path = u.pathname.replace(/\/+$/, "")
  if (!path) return [`${u.origin}/.well-known/oauth-authorization-server`, `${u.origin}/.well-known/openid-configuration`]
  return [`${u.origin}/.well-known/oauth-authorization-server${path}`, `${u.origin}/.well-known/openid-configuration${path}`, `${u.origin}${path}/.well-known/openid-configuration`]
}

type Json = Record<string, unknown>
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined)
const strs = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined)

/** Métadonnées du serveur d'autorisation → ce dont on a besoin ; null si les points d'accès manquent ou PKCE S256 absent. */
export function readAuthServerMetadata(json: Json, resource: string, scopes?: string[]): McpOAuthMeta | null {
  const authorization_endpoint = str(json.authorization_endpoint)
  const token_endpoint = str(json.token_endpoint)
  if (!authorization_endpoint || !token_endpoint) return null
  const methods = strs(json.code_challenge_methods_supported)
  // La spec MCP exige PKCE ; un serveur qui annonce ses méthodes sans S256 est refusé (sans annonce : on tente).
  if (methods && methods.length && !methods.includes("S256")) return null
  return {
    issuer: str(json.issuer) ?? new URL(authorization_endpoint).origin,
    authorization_endpoint,
    token_endpoint,
    registration_endpoint: str(json.registration_endpoint),
    // Pas de repli sur scopes_supported du serveur d'autorisation : il liste souvent tout ce qu'il sait faire (openid…).
    scopes,
    resource,
    token_auth_methods: strs(json.token_endpoint_auth_methods_supported),
  }
}

/** Méthode d'authentification du client au point de jeton. */
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

/** Réponse du point de jeton (JSON, ou formulaire chez certains fournisseurs) → jetons ; lève si erreur OAuth. */
export function parseTokenResponse(body: string, contentType: string, now = Date.now()): McpTokens {
  let data: Json = {}
  if (/json/i.test(contentType) || /^\s*\{/.test(body)) {
    try {
      data = JSON.parse(body) as Json
    } catch {
      throw new Error("réponse du serveur d'autorisation illisible")
    }
  } else data = Object.fromEntries(new URLSearchParams(body))
  if (str(data.error)) throw new Error(`${data.error}${str(data.error_description) ? ` : ${data.error_description}` : ""}`)
  const access_token = str(data.access_token)
  if (!access_token) throw new Error("aucun jeton d'accès dans la réponse")
  const expiresIn = Number(data.expires_in)
  return {
    access_token,
    refresh_token: str(data.refresh_token),
    token_type: str(data.token_type),
    scope: str(data.scope),
    expires_at: Number.isFinite(expiresIn) && expiresIn > 0 ? now + expiresIn * 1000 : undefined,
  }
}

/** Le jeton expire dans moins d'une minute (à rafraîchir avant l'appel). */
export function tokenExpiring(t: McpTokens | undefined, now = Date.now()): boolean {
  return Boolean(t?.expires_at && t.expires_at - now < 60_000)
}

// ---------------------------------------------------------------------------------------------------------------------
// JSON-RPC sur Streamable HTTP

export type JsonRpcMessage = { jsonrpc: "2.0"; id?: string | number | null; method?: string; result?: unknown; error?: { code: number; message: string } }

/** Messages d'un flux SSE (`data:` d'un même événement concaténés) ; le texte peut être coupé à la fin. */
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
      // événement incomplet (fin de tampon) ou non JSON
    }
  }
  return out
}

/** La réponse à la requête `id` dans un corps JSON ou SSE, si elle est arrivée. */
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
