// "company-brain" stdio MCP server: the employee's agents read (and enrich) the brain.
// Nothing must be written to stdout outside the transport: logs go to stderr.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { KNOWLEDGE_KINDS, classifyZones, extractEntities, normalize, redactText, truncate, type KnowledgeItemInput } from "@brain/core"
import { BrainApi } from "./api"
import { zoneHints, zoneName } from "./cache"
import { loadCache, loadConfig, selfCommand, type Cache } from "./config"
import { formatQuery, formatStatus, formatWhoami, formatZoneSummary, formatZones } from "./format"
import { maskOwnSecrets, ownSecrets } from "./secrets"

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean }

const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] })
const fail = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true })

export function createBrainMcpServer(version = "0.1.0"): McpServer {
  const server = new McpServer({ name: "company-brain", version })
  let cache: Cache | null = loadCache()

  const api = (): BrainApi => {
    const cfg = loadConfig()
    if (!cfg) throw new Error(`Brain client not configured: run \`${selfCommand()} init --url <url> --token <token>\`.`)
    return new BrainApi(cfg.url, cfg.token, 20000)
  }
  const name = (id: string) => zoneName(cache, id)
  /** Accepts a zone id or its name ("Finance", "finance"…). */
  const resolveZone = (z: string): string => {
    const n = normalize(z.trim())
    const found = cache?.zones?.find((x) => x.id === z || normalize(x.id) === n || normalize(x.name) === n)
    return found?.id ?? z.trim()
  }
  const guard = async (fn: () => Promise<string>): Promise<ToolResult> => {
    try {
      return ok(await fn())
    } catch (err) {
      return fail(`Company brain error: ${(err as Error).message}`)
    }
  }
  // Refreshes the zone cache on the first call if needed (readable names, classification).
  const ensureZones = async (a: BrainApi) => {
    if (cache?.zones?.length) return
    try {
      const zones = await a.zones()
      cache = { ...(cache ?? { updated_at: new Date().toISOString() }), zones: zones.map((z) => ({ id: z.id, name: z.name, description: z.description, keywords: z.keywords, readable: z.readable })) }
    } catch {
      // no big deal: the ids will be shown
    }
  }

  server.registerTool(
    "search_brain",
    {
      title: "Search the company brain",
      description:
        "Searches the company's shared brain: decisions, procedures (deployment, closing, support…), facts about customers, " +
        "projects and tools, open tasks and questions, fed by the whole team's AI sessions. Use it BEFORE guessing " +
        "whenever a question touches the company's context (\"how do we deploy?\", \"what did we decide for X?\", \"who handles customer Y?\"). " +
        "Only the zones the user has access to are searched.",
      inputSchema: {
        query: z.string().min(1).max(500).describe("The question or the keywords, in natural language (e.g. \"deploy to production\")."),
        zones: z.array(z.string()).max(20).optional().describe("Optional: limit to some zones (ids from list_zones, e.g. [\"dev\"])."),
        limit: z.number().int().min(1).max(50).optional().describe("Maximum number of results (8 by default)."),
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
      title: "Zone summary",
      description:
        "Gives the state of one of the company's knowledge zones (dev, product, sales, finance…): summary, goals, next steps, " +
        "who did what, recent knowledge, open tasks and key entities. Useful to catch up on an area.",
      inputSchema: { zone: z.string().min(1).max(64).describe("Id or name of the zone (see list_zones), e.g. \"dev\"." ) },
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
      title: "List the zones",
      description: "Lists the company's knowledge zones (id, description, number of knowledge items) and shows those the user has access to.",
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
      title: "My computer's context",
      description:
        "Describes the signed-in user's role: role, accessible zones, the zones and entities they use the most, frequent prompts, " +
        "recent decisions and procedures. Useful for a handover, a replacement, or to adapt an answer to the user's role.",
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
      title: "Where does the company stand?",
      description: "Summary of the company's state per zone: goals, progress, next steps and who did what (limited to accessible zones).",
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
      title: "Save to the brain",
      description:
        "Saves a reusable knowledge item to the company brain: a decision made (and why), a procedure that works, " +
        "a lasting fact about a customer/project/tool, a task to do or an open question. Use it when the user asks for it " +
        "or when an important decision has just been made. Never secrets or personal data (they are redacted anyway).",
      inputSchema: {
        title: z.string().min(3).max(200).describe("Short, precise title (≤ 120 characters)."),
        body: z.string().min(1).max(4000).describe("1 to 5 sentences a colleague can understand, with the why."),
        kind: z.enum(KNOWLEDGE_KINDS).describe("fact | decision | task | procedure | question"),
        zone: z.string().max(64).optional().describe("Optional: zone id; otherwise classified automatically (the answer gives the zone chosen)."),
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
        const classified = classifyZones(`${title} ${body}`, hints, 1)[0]
        const chosen = (asked && known.has(asked) ? asked : undefined) ?? classified ?? cache?.whoami?.writable[0] ?? hints[0]?.id ?? "general"
        const how =
          asked && chosen === asked
            ? "zone requested"
            : `zone chosen automatically from the content${asked ? ` ("${zone}" does not exist)` : ""}; give \`zone\` to choose another one`
        // The computer's secrets (brain token, Screenpipe / Claude Code tokens, API key) redacted as is.
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
        const r = await a.ingest([item], "mcp")
        const where = r.zones[0] ?? chosen
        const label = `${name(where)} (\`${where}\`)`
        if (!r.inserted && r.skipped) {
          return `Already in the brain: a knowledge item with the same title and the same content already exists in the ${label} zone ("${cleanTitle}"). Nothing new was saved.`
        }
        const readable = cache?.zones?.find((z) => z.id === where)?.readable ?? cache?.whoami?.readable.includes(where)
        const readableIds = cache?.zones?.length ? cache.zones.filter((z) => z.readable).map((z) => z.id) : (cache?.whoami?.readable ?? [])
        const mine = readableIds.map(name).join(", ")
        const visibility =
          readable === false
            ? "Note: this zone is not one of your readable zones. Only the people who have access to it will see it; " +
              "since you saved it, you find it in your own searches and in \"My context\" (where you can delete it). " +
              `To file it elsewhere, call remember again with \`zone\`${mine ? ` (your zones: ${mine})` : ""}.`
            : "It can now be found by search_brain for the people who have access to this zone."
        return `Knowledge saved in the ${label} zone — ${how}${where !== chosen ? `; the brain filed it here rather than in "${name(chosen)}"` : ""}.\n"${cleanTitle}" (${kind}). ${visibility}`
      }),
  )

  return server
}

export async function runMcpServer(version?: string) {
  // Safeguard: any accidental console.log goes to stderr so as not to corrupt the protocol.
  console.log = (...args: unknown[]) => console.error(...args)
  const server = createBrainMcpServer(version)
  await server.connect(new StdioServerTransport())
  console.error("[company-brain] MCP server ready (stdio)")
}
