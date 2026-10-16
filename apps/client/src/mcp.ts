// Serveur MCP stdio « company-brain » : les agents de l'employé lisent (et enrichissent) le cerveau.
// Rien ne doit être écrit sur stdout en dehors du transport : les journaux vont sur stderr.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { KNOWLEDGE_KINDS, classifyZones, extractEntities, normalize, redactText, truncate, type KnowledgeItemInput } from "@brain/core"
import { BrainApi } from "./api"
import { zoneHints, zoneName } from "./cache"
import { loadCache, loadConfig, selfScript, type Cache } from "./config"
import { formatQuery, formatStatus, formatWhoami, formatZoneSummary, formatZones } from "./format"

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean }

const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] })
const fail = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true })

export function createBrainMcpServer(version = "0.1.0"): McpServer {
  const server = new McpServer({ name: "company-brain", version })
  let cache: Cache | null = loadCache()

  const api = (): BrainApi => {
    const cfg = loadConfig()
    if (!cfg) throw new Error(`Client du cerveau non configuré : lancez \`node ${selfScript()} init --url <url> --token <jeton>\`.`)
    return new BrainApi(cfg.url, cfg.token, 20000)
  }
  const name = (id: string) => zoneName(cache, id)
  /** Accepte un identifiant de zone ou son nom (« Compta », « compta »…). */
  const resolveZone = (z: string): string => {
    const n = normalize(z.trim())
    const found = cache?.zones?.find((x) => x.id === z || normalize(x.id) === n || normalize(x.name) === n)
    return found?.id ?? z.trim()
  }
  const guard = async (fn: () => Promise<string>): Promise<ToolResult> => {
    try {
      return ok(await fn())
    } catch (err) {
      return fail(`Erreur du cerveau d'entreprise : ${(err as Error).message}`)
    }
  }
  // Rafraîchit le cache des zones au premier appel si besoin (noms lisibles, classification).
  const ensureZones = async (a: BrainApi) => {
    if (cache?.zones?.length) return
    try {
      const zones = await a.zones()
      cache = { ...(cache ?? { updated_at: new Date().toISOString() }), zones: zones.map((z) => ({ id: z.id, name: z.name, description: z.description, keywords: z.keywords, readable: z.readable })) }
    } catch {
      // pas grave : on affichera les identifiants
    }
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
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, zones, limit }) =>
      guard(async () => {
        const a = api()
        await ensureZones(a)
        const r = await a.query({ query, zones: zones?.map(resolveZone), limit, agent: "mcp" })
        return formatQuery(r, name)
      }),
  )

  server.registerTool(
    "get_zone_summary",
    {
      title: "Résumé d'une zone",
      description:
        "Donne l'état d'une zone de connaissance de l'entreprise (dev, produit, sales, compta…) : résumé, objectifs, prochaines étapes, " +
        "qui a fait quoi, connaissances récentes, tâches ouvertes et entités clés. Utile pour se mettre à jour sur un domaine.",
      inputSchema: { zone: z.string().min(1).max(64).describe("Identifiant ou nom de la zone (voir list_zones), ex. « dev »." ) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ zone }) =>
      guard(async () => {
        const a = api()
        await ensureZones(a)
        return formatZoneSummary(await a.zone(resolveZone(zone)))
      }),
  )

  server.registerTool(
    "list_zones",
    {
      title: "Lister les zones",
      description: "Liste les zones de connaissance de l'entreprise (identifiant, description, nombre de connaissances) et indique celles auxquelles l'utilisateur a accès.",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () =>
      guard(async () => {
        const zones = await api().zones()
        cache = { ...(cache ?? { updated_at: new Date().toISOString() }), zones: zones.map((z) => ({ id: z.id, name: z.name, description: z.description, keywords: z.keywords, readable: z.readable })) }
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
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () =>
      guard(async () => {
        const a = api()
        await ensureZones(a)
        return formatWhoami(await a.whoami(), name)
      }),
  )

  server.registerTool(
    "company_status",
    {
      title: "Où en est l'entreprise ?",
      description: "Résumé de l'état de l'entreprise par zone : objectifs, avancement, prochaines étapes et qui a fait quoi (limité aux zones accessibles).",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () =>
      guard(async () => {
        const a = api()
        await ensureZones(a)
        return formatStatus(await a.status(), name)
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
        zone: z.string().max(64).optional().describe("Optionnel : identifiant de zone ; sinon classée automatiquement."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ title, body, kind, zone }) =>
      guard(async () => {
        const a = api()
        await ensureZones(a)
        const hints = zoneHints(cache)
        const known = new Set(hints.map((z) => z.id))
        const asked = zone ? resolveZone(zone) : undefined
        const chosen =
          (asked && known.has(asked) ? asked : undefined) ??
          classifyZones(`${title} ${body}`, hints, 1)[0] ??
          cache?.whoami?.writable[0] ??
          hints[0]?.id ??
          "general"
        const cleanTitle = truncate(redactText(title).trim(), 140)
        const cleanBody = truncate(redactText(body).trim(), 4000)
        const item: KnowledgeItemInput = {
          zone: chosen,
          kind,
          title: cleanTitle,
          body: cleanBody,
          entities: extractEntities(`${cleanTitle}\n${cleanBody}`),
          source: { app: "claude-code", tool: "agent", at: new Date().toISOString() },
          confidence: 0.8,
        }
        const r = await a.ingest([item], "mcp")
        const where = r.zones[0] ?? chosen
        return `Connaissance enregistrée dans la zone ${name(where)} : « ${cleanTitle} » (${kind}). Elle est maintenant trouvable par search_brain pour les personnes ayant accès à cette zone.`
      }),
  )

  return server
}

export async function runMcpServer(version?: string) {
  // Garde-fou : tout console.log accidentel part sur stderr pour ne pas corrompre le protocole.
  console.log = (...args: unknown[]) => console.error(...args)
  const server = createBrainMcpServer(version)
  await server.connect(new StdioServerTransport())
  console.error("[company-brain] serveur MCP prêt (stdio)")
}
