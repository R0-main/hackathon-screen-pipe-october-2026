// Outils MCP du cerveau, partagés par le serveur MCP du poste (brain.mjs mcp, stdio) et l'endpoint MCP du cerveau
// (/api/mcp/<entreprise>/<jeton>, HTTP) : mêmes noms, mêmes descriptions, mêmes réponses en markdown. Chacun fournit
// l'accès à l'API (HTTP pour le poste, appels internes pour le cerveau).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { AgentName, Entity, KnowledgeItemInput, KnowledgeKind, Profile, Zone } from "./types"
import { KNOWLEDGE_KINDS } from "./types"
import { DEFAULT_ZONES, classifyZones } from "./zones"
import { extractEntities, type ZoneHint } from "./distill"
import { redactText } from "./privacy"
import { normalize, truncate } from "./text"

// --- Réponses de l'API lues par les outils ---------------------------------------------------------------------------

export type ApiZone = Zone & { readable: boolean; count?: number }

export type WhoAmI = {
  /** `id` : absent d'un cerveau plus ancien. */
  org: { id?: string; name: string; description: string }
  profile: Profile
  access: { isAdmin: boolean; readable: string[]; writable: string[] }
  context: {
    person: Profile
    zones: { zone: string; weight: number }[]
    entities: { type: string; name: string; count: number; zones: string[] }[]
    frequent_prompts: { summary: string; count: number; last: string }[]
    items: ApiItem[]
    decisions: ApiItem[]
    procedures: ApiItem[]
  } | null
}

export type ApiItem = {
  id: string
  zone: string
  kind: KnowledgeKind
  title: string
  body: string
  entities: Entity[]
  source: { app: string; tool: string; at: string }
  confidence: number
  created_at: string
  author_id: string
  author?: string
  score?: number
}

export type QueryResult = {
  query: string
  zones_searched: string[]
  zones_hit: string[]
  zones_restricted: string[]
  items: ApiItem[]
}

export type ZoneSummary = {
  zone: Zone
  status: {
    summary: string
    objectives: string[]
    progress: string
    next_steps: string[]
    who_did_what: { person: string; did: string }[]
  } | null
  items: ApiItem[]
  entities: { type: string; name: string; count: number }[]
  tasks: { id: string; title: string; status: string; assignee?: string }[]
}

export type CompanyStatusResult = {
  headline: string
  zones: { zone: string; summary: string; objectives: string[]; progress: string; next_steps: string[]; who_did_what: { person: string; did: string }[] }[]
  generated_at: string
  generator: string
} | null

/**
 * Réponse de POST /api/ingest. `skipped` : items déjà reçus (même auteur, zone, titre et contenu sur 30 jours), ignorés.
 * `zones` : zones où au moins un item a été inséré. `per_zone` (facultatif) : nombre d'items insérés par zone.
 */
export type IngestResult = { inserted: number; skipped?: number; ids: string[]; zones: string[]; per_zone?: Record<string, number> }

/** Ce dont les outils ont besoin : les routes de l'API du cerveau, avec les droits du jeton de la personne. */
/** Outils des connecteurs MCP de l'entreprise ouverts aux agents (GET /api/connected-tools). */
export type ConnectedTools = {
  connectors: { id: string; name: string; mode: "read" | "all" | "off"; tools: { name: string; title?: string; description?: string; input_schema: Record<string, unknown>; read_only: boolean }[] }[]
}

export type ConnectedCall = { text: string; is_error: boolean }

export interface BrainToolsApi {
  whoami(): Promise<WhoAmI>
  zones(): Promise<ApiZone[]>
  zone(id: string): Promise<ZoneSummary>
  status(): Promise<CompanyStatusResult>
  query(input: { query: string; zones?: string[]; limit?: number; agent?: AgentName }): Promise<QueryResult>
  ingest(items: KnowledgeItemInput[], agent?: AgentName): Promise<IngestResult>
  /** Outils des connecteurs (Notion, Linear, GitHub…) que l'admin a ouverts aux agents. */
  connectedTools?(input: { connector?: string; query?: string }): Promise<ConnectedTools>
  callConnectedTool?(input: { connector: string; tool: string; arguments: Record<string, unknown> }): Promise<ConnectedCall>
}

/** Liste lisible par le modèle : un connecteur par section, un outil par ligne, schéma d'entrée en JSON compact. */
export function formatConnectedTools(r: ConnectedTools, withSchemas: boolean): string {
  const usable = r.connectors.filter((c) => c.tools.length)
  if (!usable.length)
    return r.connectors.length
      ? "Aucun outil ne correspond : essayez sans `query`, ou un autre connecteur."
      : "Aucun connecteur n'est ouvert aux agents dans cette entreprise (un admin les branche dans Connecteurs)."
  return usable
    .map((c) => {
      const head = `## ${c.name} (\`connector: "${c.id}"\`) — ${c.mode === "all" ? "lecture et écriture" : "lecture seule"}`
      const lines = c.tools.map((t) => {
        const desc = truncate((t.description ?? t.title ?? "").replace(/\s+/g, " "), withSchemas ? 400 : 160)
        const schema = withSchemas ? `\n  arguments : ${truncate(JSON.stringify(t.input_schema), 1500)}` : ""
        return `- \`${t.name}\`${t.read_only ? "" : " (modifie des données)"} : ${desc}${schema}`
      })
      return [head, ...lines].join("\n")
    })
    .join("\n\n")
}

// --- Mise en forme (markdown, en français) ---------------------------------------------------------------------------


const KIND_LABELS: Record<string, string> = { fact: "fait", decision: "décision", task: "tâche", procedure: "procédure", question: "question" }

export type ZoneNamer = (id: string) => string

export function frDate(iso: string | undefined): string {
  if (!iso) return "?"
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Europe/Paris" })
}

function itemBlock(i: ApiItem, n: number, zoneName: ZoneNamer): string {
  const meta = [
    `Zone : ${zoneName(i.zone)}`,
    `Type : ${KIND_LABELS[i.kind] ?? i.kind}`,
    `Par : ${i.author ?? "?"}`,
    `Date : ${frDate(i.source?.at ?? i.created_at)}`,
    i.source?.tool ? `Source : ${i.source.tool}` : "",
  ]
    .filter(Boolean)
    .join(" · ")
  const ents = i.entities?.length ? `\nEntités : ${i.entities.map((e) => e.name).join(", ")}` : ""
  return `### ${n}. ${i.title}\n${meta}\n\n${i.body.trim()}${ents}`
}

export function formatQuery(r: QueryResult, zoneName: ZoneNamer): string {
  const searched = r.zones_searched.length ? r.zones_searched.map(zoneName).join(", ") : "aucune"
  const restricted = r.zones_restricted?.length
    ? "\n\nNote : des zones auxquelles vous n'avez pas accès pourraient en savoir plus (demandez à un admin ou à la personne concernée)."
    : ""
  if (!r.items.length) {
    return (
      `Aucune connaissance trouvée dans le cerveau pour « ${r.query} » (zones consultées : ${searched}).\n` +
      `Essayez d'autres mots-clés (nom de client, d'outil, de projet) ou list_zones pour voir les domaines disponibles.${restricted}`
    )
  }
  const head = `## Cerveau d'entreprise — « ${r.query} »\n${r.items.length} résultat${r.items.length > 1 ? "s" : ""} (zones consultées : ${searched})`
  return `${head}\n\n${r.items.map((i, n) => itemBlock(i, n + 1, zoneName)).join("\n\n---\n\n")}${restricted}`
}

export function formatZones(zones: ApiZone[]): string {
  const lines = zones
    .sort((a, b) => a.position - b.position)
    .map((z) => `- **${z.name}** (\`${z.id}\`) : ${z.description}${z.readable ? ` — accessible, ${z.count ?? 0} connaissance${(z.count ?? 0) > 1 ? "s" : ""}` : " — non accessible"}`)
  return `## Zones du cerveau\n${lines.join("\n")}\n\nUtilisez l'identifiant entre backticks avec get_zone_summary ou dans le filtre zones de search_brain.`
}

export function formatZoneSummary(s: ZoneSummary): string {
  const parts = [`## Zone ${s.zone.name} (\`${s.zone.id}\`)`, s.zone.description]
  if (s.status) {
    parts.push(`### État\n${s.status.summary}\nAvancement : ${s.status.progress}`)
    if (s.status.objectives.length) parts.push(`Objectifs :\n${s.status.objectives.map((o) => `- ${o}`).join("\n")}`)
    if (s.status.next_steps.length) parts.push(`Prochaines étapes :\n${s.status.next_steps.map((o) => `- ${o}`).join("\n")}`)
    if (s.status.who_did_what.length) parts.push(`Qui a fait quoi :\n${s.status.who_did_what.map((w) => `- ${w.person} : ${w.did}`).join("\n")}`)
  }
  const recent = s.items.slice(0, 12)
  parts.push(
    recent.length
      ? `### Connaissances récentes\n${recent.map((i) => `- [${KIND_LABELS[i.kind] ?? i.kind}] ${i.title} — ${i.author ?? "?"}, ${frDate(i.source?.at ?? i.created_at)}`).join("\n")}`
      : "### Connaissances récentes\n(aucune pour l'instant)",
  )
  const open = s.tasks.filter((t) => t.status !== "done").slice(0, 10)
  if (open.length) parts.push(`### Tâches ouvertes\n${open.map((t) => `- ${t.title}${t.assignee ? ` (${t.assignee})` : ""}`).join("\n")}`)
  if (s.entities.length) parts.push(`### Entités les plus citées\n${s.entities.slice(0, 12).map((e) => `${e.name} (${e.type}, ${e.count})`).join(", ")}`)
  return parts.join("\n\n")
}

export function formatWhoami(w: WhoAmI, zoneName: ZoneNamer): string {
  const p = w.profile
  const parts = [
    `## ${p.name}${p.title ? ` — ${p.title}` : ""} (${w.org.name})`,
    `Rôle : ${p.role === "admin" ? "admin" : "membre"} · Zones lisibles : ${w.access.readable.map(zoneName).join(", ") || "aucune"} · Zones en écriture : ${w.access.writable.map(zoneName).join(", ") || "aucune"}`,
  ]
  const c = w.context
  if (c) {
    if (c.zones.length) parts.push(`### Zones les plus utilisées par ce poste\n${c.zones.slice(0, 6).map((z) => `- ${zoneName(z.zone)} (poids ${z.weight})`).join("\n")}`)
    if (c.entities.length) parts.push(`### Entités principales\n${c.entities.slice(0, 12).map((e) => `${e.name} (${e.type}, ${e.count})`).join(", ")}`)
    const prompts = dedupePrompts(c.frequent_prompts)
    if (prompts.length) parts.push(`### Prompts fréquents\n${prompts.map((f) => `- « ${f.summary} » (${f.count} fois, dernier le ${frDate(f.last)})`).join("\n")}`)
    if (c.decisions.length) parts.push(`### Décisions récentes\n${c.decisions.slice(0, 8).map((i) => `- ${i.title} (${zoneName(i.zone)}, ${frDate(i.created_at)})`).join("\n")}`)
    if (c.procedures.length) parts.push(`### Procédures\n${c.procedures.slice(0, 8).map((i) => `- ${i.title} (${zoneName(i.zone)})`).join("\n")}`)
    parts.push("Utile pour une passation : search_brain permet ensuite d'ouvrir le détail de chaque sujet.")
  }
  return parts.join("\n\n")
}

function dedupePrompts(list: { summary: string; count: number; last: string }[]) {
  const seen = new Map<string, { summary: string; count: number; last: string }>()
  for (const f of list) {
    const k = f.summary.trim().toLowerCase()
    const prev = seen.get(k)
    if (!prev) seen.set(k, { ...f })
    else {
      prev.count = Math.max(prev.count, f.count)
      if (f.last > prev.last) prev.last = f.last
    }
  }
  return [...seen.values()].slice(0, 8)
}

export function formatStatus(s: CompanyStatusResult, zoneName: ZoneNamer): string {
  if (!s || !s.headline) return "L'état de l'entreprise n'a pas encore été généré (un admin peut le rafraîchir depuis le dashboard, ou avec `brain.mjs refresh-status`)."
  const zones = (s.zones ?? []).map((z) => {
    const lines = [`### ${zoneName(z.zone)}`, z.summary, `Avancement : ${z.progress}`]
    if (z.objectives.length) lines.push(`Objectifs : ${z.objectives.join(" ; ")}`)
    if (z.next_steps.length) lines.push(`Prochaines étapes : ${z.next_steps.join(" ; ")}`)
    if (z.who_did_what.length) lines.push(`Qui a fait quoi : ${z.who_did_what.map((w) => `${w.person} — ${w.did}`).join(" ; ")}`)
    return lines.join("\n")
  })
  return `## Où en est la boîte ?\n${s.headline}\n\n${zones.join("\n\n")}\n\n(généré le ${frDate(s.generated_at)}, ${s.generator === "claude" ? "par Claude" : "automatiquement"})`
}

// --- Serveur MCP -----------------------------------------------------------------------------------------------------

/** Zones connues d'une entreprise (noms lisibles, classification de remember) et droits du poste. */
export type ZoneCache = {
  updated_at?: string
  zones?: (Pick<Zone, "id" | "name" | "description" | "keywords"> & { readable: boolean })[]
  whoami?: { readable: string[]; writable: string[] }
}

/** L'entreprise visée par un appel d'outil. `key` identifie son cache de zones ; `header` précède chaque réponse. */
export type BrainMcpTarget = { api: BrainToolsApi; key: string; header?: string; cache?: () => ZoneCache | null }

export type BrainMcpOptions = {
  version?: string
  /** Consigne du serveur (quelle entreprise, quand l'interroger). */
  instructions?: string
  /** Description du paramètre `company` (poste branché sur plusieurs entreprises) ; absent : pas de paramètre. */
  companyParam?: string
  /** L'entreprise d'un appel (`company` demandée, sinon celle par défaut) ; lève une erreur si elle est inconnue. */
  open: (company?: string) => BrainMcpTarget
  /** Masquage du texte enregistré par remember (par défaut redactText) : le poste y ajoute ses propres secrets. */
  clean?: (text: string) => string
  /** `source.app` des connaissances enregistrées par remember. */
  sourceApp?: string
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean }

const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] })
const fail = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true })

function zoneHints(cache: ZoneCache | null): ZoneHint[] {
  return cache?.zones?.length ? cache.zones : DEFAULT_ZONES
}

function zoneName(cache: ZoneCache | null, id: string): string {
  return cache?.zones?.find((z) => z.id === id)?.name ?? DEFAULT_ZONES.find((z) => z.id === id)?.name ?? id
}

/** Le serveur MCP « company-brain » et ses six outils, sur l'entreprise que donne `open`. */
export function createBrainMcpServer(opts: BrainMcpOptions): McpServer {
  const server = new McpServer({ name: "company-brain", version: opts.version ?? "0.1.0" }, opts.instructions ? { instructions: opts.instructions } : undefined)
  // Zones de chaque entreprise, par clé : partent du cache fourni, complétées au premier appel.
  const caches = new Map<string, ZoneCache | null>()

  type Ctx = { api: BrainToolsApi; key: string; header: string }
  const open = (wanted?: string): Ctx => {
    const t = opts.open(wanted)
    if (!caches.has(t.key)) caches.set(t.key, t.cache?.() ?? null)
    return { api: t.api, key: t.key, header: t.header ?? "" }
  }
  const cacheOf = (c: Ctx) => caches.get(c.key) ?? null
  const keepZones = (c: Ctx, zones: ApiZone[]) =>
    caches.set(c.key, {
      ...(cacheOf(c) ?? { updated_at: new Date().toISOString() }),
      zones: zones.map((z) => ({ id: z.id, name: z.name, description: z.description, keywords: z.keywords, readable: z.readable })),
    })
  const namer = (c: Ctx) => (id: string) => zoneName(cacheOf(c), id)
  /** Accepte un identifiant de zone ou son nom (« Compta », « compta »…). */
  const resolveZone = (c: Ctx, z: string): string => {
    const n = normalize(z.trim())
    const found = cacheOf(c)?.zones?.find((x) => x.id === z || normalize(x.id) === n || normalize(x.name) === n)
    return found?.id ?? z.trim()
  }
  const guard = async (company: string | undefined, fn: (c: Ctx) => Promise<string>): Promise<ToolResult> => {
    try {
      const c = open(company)
      return ok(c.header + (await fn(c)))
    } catch (err) {
      return fail(`Erreur du cerveau d'entreprise : ${(err as Error).message}`)
    }
  }
  // Rafraîchit le cache des zones au premier appel si besoin (noms lisibles, classification).
  const ensureZones = async (c: Ctx) => {
    if (cacheOf(c)?.zones?.length) return
    try {
      keepZones(c, await c.api.zones())
    } catch {
      // pas grave : on affichera les identifiants
    }
  }
  // Paramètre `company`, seulement si le poste a plusieurs entreprises (sinon rien à choisir). Typé comme toujours
  // présent : il est facultatif, les outils le reçoivent `undefined` quand il est absent du schéma.
  const companyParam = (opts.companyParam ? { company: z.string().max(120).optional().describe(opts.companyParam) } : {}) as {
    company: z.ZodOptional<z.ZodString>
  }

  server.registerTool(
    "search_brain",
    {
      title: "Chercher dans le cerveau d'entreprise",
      description:
        "Cherche dans le cerveau partagé de l'entreprise : décisions, procédures (déploiement, clôture, support…), faits sur les clients, " +
        "projets et outils, tâches et questions ouvertes, alimentés par les sessions IA de toute l'équipe. À utiliser AVANT de deviner " +
        "dès qu'une question touche au contexte de l'entreprise (« comment on déploie ? », « qu'a-t-on décidé pour X ? », « qui gère le client Y ? »). " +
        "Seules les zones auxquelles l'utilisateur a accès sont consultées.",
      inputSchema: {
        query: z.string().min(1).max(500).describe("La question ou les mots-clés, en langage naturel (ex. « déployer en production »)."),
        zones: z.array(z.string()).max(20).optional().describe("Optionnel : limiter à certaines zones (identifiants de list_zones, ex. [\"dev\"])."),
        limit: z.number().int().min(1).max(50).optional().describe("Nombre maximum de résultats (8 par défaut)."),
        ...companyParam,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, zones, limit, company }) =>
      guard(company, async (c) => {
        await ensureZones(c)
        const r = await c.api.query({ query, zones: zones?.map((x) => resolveZone(c, x)), limit, agent: "mcp" })
        return formatQuery(r, namer(c))
      }),
  )

  server.registerTool(
    "get_zone_summary",
    {
      title: "Résumé d'une zone",
      description:
        "Donne l'état d'une zone de connaissance de l'entreprise (dev, produit, sales, compta…) : résumé, objectifs, prochaines étapes, " +
        "qui a fait quoi, connaissances récentes, tâches ouvertes et entités clés. Utile pour se mettre à jour sur un domaine.",
      inputSchema: { zone: z.string().min(1).max(64).describe("Identifiant ou nom de la zone (voir list_zones), ex. « dev »."), ...companyParam },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ zone, company }) =>
      guard(company, async (c) => {
        await ensureZones(c)
        return formatZoneSummary(await c.api.zone(resolveZone(c, zone)))
      }),
  )

  server.registerTool(
    "list_zones",
    {
      title: "Lister les zones",
      description: "Liste les zones de connaissance de l'entreprise (identifiant, description, nombre de connaissances) et indique celles auxquelles l'utilisateur a accès.",
      inputSchema: { ...companyParam },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ company }) =>
      guard(company, async (c) => {
        const zones = await c.api.zones()
        keepZones(c, zones)
        return formatZones(zones)
      }),
  )

  server.registerTool(
    "whoami_context",
    {
      title: "Contexte de mon poste",
      description:
        "Décrit le poste de l'utilisateur connecté : rôle, zones accessibles, zones et entités qu'il utilise le plus, prompts fréquents, " +
        "décisions et procédures récentes. Utile pour une passation de poste, un remplacement, ou pour adapter une réponse au rôle de l'utilisateur.",
      inputSchema: { ...companyParam },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ company }) =>
      guard(company, async (c) => {
        await ensureZones(c)
        return formatWhoami(await c.api.whoami(), namer(c))
      }),
  )

  server.registerTool(
    "company_status",
    {
      title: "Où en est l'entreprise ?",
      description: "Résumé de l'état de l'entreprise par zone : objectifs, avancement, prochaines étapes et qui a fait quoi (limité aux zones accessibles).",
      inputSchema: { ...companyParam },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ company }) =>
      guard(company, async (c) => {
        await ensureZones(c)
        return formatStatus(await c.api.status(), namer(c))
      }),
  )

  server.registerTool(
    "remember",
    {
      title: "Enregistrer dans le cerveau",
      description:
        "Enregistre une connaissance réutilisable dans le cerveau de l'entreprise : une décision prise (et pourquoi), une procédure qui marche, " +
        "un fait durable sur un client/projet/outil, une tâche à faire ou une question ouverte. À utiliser quand l'utilisateur le demande " +
        "ou quand une décision importante vient d'être prise. Jamais de secrets ni de données personnelles (ils sont masqués de toute façon).",
      inputSchema: {
        title: z.string().min(3).max(200).describe("Titre court et précis (≤ 120 caractères)."),
        body: z.string().min(1).max(4000).describe("1 à 5 phrases compréhensibles par un collègue, avec le pourquoi."),
        kind: z.enum(KNOWLEDGE_KINDS).describe("fact | decision | task | procedure | question"),
        zone: z.string().max(64).optional().describe("Optionnel : identifiant de zone ; sinon classée automatiquement (la réponse indique la zone retenue)."),
        ...companyParam,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ title, body, kind, zone, company }) =>
      guard(company, async (c) => {
        await ensureZones(c)
        const cache = cacheOf(c)
        const name = namer(c)
        const hints = zoneHints(cache)
        const zoneIds = new Set(hints.map((z) => z.id))
        const asked = zone ? resolveZone(c, zone) : undefined
        const classified = classifyZones(`${title} ${body}`, hints, 1)[0]
        const chosen = (asked && zoneIds.has(asked) ? asked : undefined) ?? classified ?? cache?.whoami?.writable[0] ?? hints[0]?.id ?? "general"
        const how =
          asked && chosen === asked
            ? "zone demandée"
            : `zone choisie automatiquement d'après le contenu${asked ? ` (« ${zone} » n'existe pas)` : ""} ; précisez \`zone\` pour en choisir une autre`
        const clean = (t: string) => (opts.clean ?? ((x: string) => redactText(x)))(t).trim()
        const cleanTitle = truncate(clean(title), 140)
        const cleanBody = truncate(clean(body), 4000)
        const item: KnowledgeItemInput = {
          zone: chosen,
          kind,
          title: cleanTitle,
          body: cleanBody,
          entities: extractEntities(`${cleanTitle}\n${cleanBody}`),
          source: { app: opts.sourceApp ?? "claude-code", tool: "agent", at: new Date().toISOString() },
          confidence: 0.8,
        }
        const r = await c.api.ingest([item], "mcp")
        const where = r.zones[0] ?? chosen
        const label = `${name(where)} (\`${where}\`)`
        if (!r.inserted && r.skipped) {
          return `Déjà dans le cerveau : une connaissance avec le même titre et le même contenu existe déjà dans la zone ${label} (« ${cleanTitle} »). Rien de nouveau n'a été enregistré.`
        }
        const readable = cache?.zones?.find((z) => z.id === where)?.readable ?? cache?.whoami?.readable.includes(where)
        const readableIds = cache?.zones?.length ? cache.zones.filter((z) => z.readable).map((z) => z.id) : (cache?.whoami?.readable ?? [])
        const mine = readableIds.map(name).join(", ")
        const visibility =
          readable === false
            ? "Attention : cette zone ne fait pas partie de vos zones en lecture. Seules les personnes qui y ont accès la verront ; " +
              "comme c'est vous qui l'avez enregistrée, vous la retrouvez dans vos propres recherches et dans « Mon contexte » (où vous pouvez la supprimer). " +
              `Pour la ranger ailleurs, rappelez remember avec \`zone\`${mine ? ` (vos zones : ${mine})` : ""}.`
            : "Elle est maintenant trouvable par search_brain pour les personnes ayant accès à cette zone."
        return `Connaissance enregistrée dans la zone ${label} — ${how}${where !== chosen ? ` ; le cerveau l'a rangée ici plutôt que dans « ${name(chosen)} »` : ""}.\n« ${cleanTitle} » (${kind}). ${visibility}`
      }),
  )

  server.registerTool(
    "connected_tools",
    {
      title: "Outils des connecteurs de l'entreprise",
      description:
        "Liste les outils des outils de l'entreprise branchés au cerveau (Notion, Linear, GitHub, Jira, Slack, Stripe…) que vous " +
        "pouvez utiliser : chercher une page ou un ticket, lire un document, et, si l'admin l'a permis, créer ou modifier. " +
        "À appeler quand une demande porte sur le contenu de ces outils, puis use_connected_tool. Filtrez par `connector` ou `query` ; " +
        "les schémas d'arguments sont donnés quand la liste est filtrée.",
      inputSchema: {
        connector: z.string().max(80).optional().describe("Optionnel : identifiant ou nom du connecteur (ex. \"notion\", \"linear\")."),
        query: z.string().max(200).optional().describe("Optionnel : mot-clé dans le nom ou la description de l'outil (ex. « search », « issue »)."),
        ...companyParam,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ connector, query, company }) =>
      guard(company, async (c) => {
        if (!c.api.connectedTools) return "Ce cerveau ne propose pas encore les outils des connecteurs."
        const r = await c.api.connectedTools({ connector, query })
        return formatConnectedTools(r, Boolean(connector || query) || r.connectors.reduce((n, x) => n + x.tools.length, 0) <= 15)
      }),
  )

  server.registerTool(
    "use_connected_tool",
    {
      title: "Utiliser un outil d'un connecteur",
      description:
        "Appelle un outil d'un connecteur de l'entreprise (listé par connected_tools) avec le compte branché par l'admin, et renvoie " +
        "sa réponse. Les outils qui modifient des données ne passent que si l'admin les a ouverts aux agents.",
      inputSchema: {
        connector: z.string().min(1).max(80).describe("Identifiant du connecteur, tel que donné par connected_tools (ex. \"notion\")."),
        tool: z.string().min(1).max(200).describe("Nom exact de l'outil (ex. \"search\")."),
        arguments: z.record(z.string(), z.unknown()).optional().describe("Arguments de l'outil, selon son schéma (objet JSON)."),
        ...companyParam,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ connector, tool, arguments: args, company }) => {
      try {
        const c = open(company)
        if (!c.api.callConnectedTool) return fail("Ce cerveau ne propose pas encore les outils des connecteurs.")
        const r = await c.api.callConnectedTool({ connector, tool, arguments: args ?? {} })
        const text = c.header + (opts.clean ?? ((x: string) => x))(r.text)
        return r.is_error ? fail(text) : ok(text)
      } catch (err) {
        return fail(`Erreur du cerveau d'entreprise : ${(err as Error).message}`)
      }
    },
  )

  return server
}
