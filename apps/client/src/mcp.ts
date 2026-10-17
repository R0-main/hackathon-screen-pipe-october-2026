// Serveur MCP stdio « company-brain » : les agents de l'employé lisent (et enrichissent) le cerveau.
// Rien ne doit être écrit sur stdout en dehors du transport : les journaux vont sur stderr.
// Poste branché sur plusieurs entreprises : chaque outil prend `company` (par défaut la première) ; le nom et la
// description de chacune, dans les instructions du serveur et la description du paramètre, guident le choix du modèle.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { KNOWLEDGE_KINDS, classifyZones, extractEntities, normalize, redactText, truncate, type KnowledgeItemInput } from "@brain/core"
import { BrainApi, type ApiZone } from "./api"
import { zoneHints, zoneName } from "./cache"
import { companyLabel, describeCompanies, pickCompany } from "./companies"
import { companiesOf, loadCache, loadConfig, selfCommand, type Cache, type Company } from "./config"
import { formatQuery, formatStatus, formatWhoami, formatZoneSummary, formatZones } from "./format"
import { maskOwnSecrets, ownSecrets } from "./secrets"

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean }

const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] })
const fail = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true })

/** Consigne du serveur quand le poste a plusieurs entreprises : laquelle interroger, et quand en changer. */
export function companiesInstructions(list: Company[]): string {
  return (
    `Ce poste est branché sur ${list.length} entreprises, chacune avec son propre cerveau. Les outils interrogent la première par défaut ; ` +
    "passez `company` (nom ou numéro) seulement quand la demande porte sur une autre entreprise, d'après son nom ou sa description. " +
    "Chaque réponse commence par l'entreprise qui a répondu.\n" +
    describeCompanies(list)
  )
}

/** Ce qu'un appel d'outil vise : l'API de l'entreprise choisie, et la clé de son cache de zones. */
type Ctx = { api: BrainApi; key: string; header: string }

export function createBrainMcpServer(version = "0.1.0"): McpServer {
  // Les entreprises connues au démarrage décrivent les outils ; chaque appel relit la config (entreprise ajoutée entre-temps).
  const startCfg = loadConfig()
  const known = startCfg ? companiesOf(startCfg) : []
  const multi = known.length > 1
  const server = new McpServer({ name: "company-brain", version }, multi ? { instructions: companiesInstructions(known) } : undefined)
  // Zones de chaque entreprise (noms lisibles, classification), par jeton : la première part du cache du poste.
  const caches = new Map<string, Cache | null>()

  const open = (wanted?: string): Ctx => {
    const cfg = loadConfig()
    if (!cfg) throw new Error(`Client du cerveau non configuré : lancez \`${selfCommand()} init --url <url> --token <jeton>\`.`)
    const list = companiesOf(cfg)
    const company = pickCompany(list, wanted)
    if (!caches.has(company.token)) caches.set(company.token, company.token === cfg.token ? loadCache() : null)
    // Plusieurs entreprises : chaque réponse dit laquelle a répondu.
    const header = list.length > 1 ? `Entreprise : ${companyLabel(company)}\n\n` : ""
    return { api: new BrainApi(company.url, company.token, 20000), key: company.token, header }
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
  const companyParam = (
    multi
      ? {
          company: z
            .string()
            .max(120)
            .optional()
            .describe(
              `Entreprise à interroger, par nom ou numéro ; par défaut la première (« ${companyLabel(known[0])} »). À préciser seulement quand ` +
                `la demande porte sur une autre entreprise du poste :\n${describeCompanies(known)}`,
            ),
        }
      : {}
  ) as { company: z.ZodOptional<z.ZodString> }

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
        // Secrets du poste (jeton du cerveau, jetons Screenpipe / Claude Code, clé API) masqués tels quels.
        const secrets = ownSecrets(loadConfig())
        const clean = (t: string) => maskOwnSecrets(redactText(t, { literals: secrets }), secrets).text.trim()
        const cleanTitle = truncate(clean(title), 140)
        const cleanBody = truncate(clean(body), 4000)
        const item: KnowledgeItemInput = {
          zone: chosen,
          kind,
          title: cleanTitle,
          body: cleanBody,
          entities: extractEntities(`${cleanTitle}\n${cleanBody}`),
          source: { app: "claude-code", tool: "agent", at: new Date().toISOString() },
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

  return server
}

export async function runMcpServer(version?: string) {
  // Garde-fou : tout console.log accidentel part sur stderr pour ne pas corrompre le protocole.
  console.log = (...args: unknown[]) => console.error(...args)
  const server = createBrainMcpServer(version)
  await server.connect(new StdioServerTransport())
  console.error("[company-brain] serveur MCP prêt (stdio)")
}
