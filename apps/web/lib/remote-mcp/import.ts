// Importing an MCP connector's content into the brain: Claude explores the tool with its read-only tools only (search,
// lists, reading recent pages or issues), then returns lasting knowledge (decisions, procedures, facts about projects
// and customers) through `save_knowledge`. It enters through ingestItems, like a connector sync: secrets redacted,
// duplicates skipped, filed in the cortexes the connector is allowed to (automatic classification among them).
// Tool loop run by hand: the tools come from a remote server (raw JSON schemas), with a cap on turns, calls and time
// to fit in a serverless function.

import { createHash } from "node:crypto"
import type Anthropic from "@anthropic-ai/sdk"
import {
  KNOWLEDGE_KINDS,
  callResultText,
  claudeToolName,
  classifyZones,
  connectorZones,
  extractEntities,
  keywordsOf,
  truncate,
  type KnowledgeItemInput,
  type KnowledgeKind,
  type McpConnectorConfig,
  type McpToolDef,
  type Zone,
} from "@brain/core"
import { EXTRACT_MODEL } from "@brain/core/claude"

/** What the import needs, injectable for tests (simulated Claude, in-memory tools and brain). */
export type ImportDeps = {
  claude: Pick<Anthropic, "beta">
  /** The connector's read-only tools. */
  tools: McpToolDef[]
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>
  zones: Zone[]
  org: { name: string; description?: string }
  /** Last successful import: Claude focuses on what changed since. */
  since?: string
  now?: () => number
}

export const IMPORT_LIMITS = { turns: 12, calls: 30, items: 40, deadlineMs: 100_000, resultChars: 12_000 }

const SAVE_TOOL = "save_knowledge"

type SavedItem = { title: string; body: string; kind: KnowledgeKind; zone?: string; url?: string; updated_at?: string; keywords?: string[] }

type ImportedConnector = Pick<McpConnectorConfig, "id" | "name" | "zones" | "zone">

/**
 * Zones the import may file into: those the connector is allowed to (all when it is open to every cortex). Throws when
 * none of its cortexes exists any more, rather than spreading its content to the others.
 */
export function importZones(c: Pick<McpConnectorConfig, "zones" | "zone">, zones: Zone[]): Zone[] {
  const allowed = connectorZones(c)
  if (!allowed.length) return zones
  const kept = zones.filter((z) => allowed.includes(z.id))
  if (!kept.length) throw new Error("the cortexes this connector is allowed to no longer exist: choose others")
  return kept
}

function systemPrompt(c: Pick<McpConnectorConfig, "name">, d: ImportDeps): string {
  const zones = d.zones.map((z) => `- ${z.id}: ${z.name}${z.description ? ` — ${z.description}` : ""}`).join("\n")
  return [
    `You feed the company brain of ${d.org.name}${d.org.description ? ` (${d.org.description.trim()})` : ""} from ${c.name}, connected by an admin.`,
    `Explore ${c.name} with the tools provided (read-only): start with what was created or changed ${d.since ? `since ${d.since.slice(0, 10)}` : "recently"}, then read the items worth it.`,
    `Keep only lasting knowledge useful to a colleague: decisions and their reason, procedures, facts about projects, customers and tools, open questions, important tasks.`,
    `Each piece of knowledge: a short, precise title, 1 to 5 self-contained sentences (who, what, why), in English, the source link if you have it, and its search keywords. No sensitive personal data, no secrets (passwords, keys, tokens), no small talk.`,
    `Save them with ${SAVE_TOOL} (in batches), at most ${IMPORT_LIMITS.items} in total. Pick the closest zone among:\n${zones || "- general"}`,
    `You have about ${IMPORT_LIMITS.calls} tool calls: be selective. When you are done, answer in one sentence.`,
  ].join("\n\n")
}

const SAVE_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      maxItems: 20,
      items: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short, precise title (under 120 characters)." },
          body: { type: "string", description: "1 to 5 self-contained sentences, with the why." },
          kind: { type: "string", enum: [...KNOWLEDGE_KINDS] },
          zone: { type: "string", description: "Zone id." },
          url: { type: "string", description: "Link to the source, if known." },
          updated_at: { type: "string", description: "Last change date of the source (ISO), if known." },
          keywords: {
            type: "array",
            items: { type: "string" },
            maxItems: 14,
            description: "6 to 14 search terms a colleague might type that the title and body do not contain: other words, the question it answers, the French for the key terms. Never a fact or name not in the item.",
          },
        },
        required: ["title", "body", "kind"],
        additionalProperties: false,
      },
    },
  },
  required: ["items"],
  additionalProperties: false,
} as const

function readSaved(input: unknown): SavedItem[] {
  const items = (input as { items?: unknown })?.items
  if (!Array.isArray(items)) return []
  const out: SavedItem[] = []
  for (const raw of items) {
    const i = raw as Record<string, unknown>
    if (typeof i?.title !== "string" || typeof i.body !== "string" || !i.title.trim() || !i.body.trim()) continue
    const kind = (KNOWLEDGE_KINDS as readonly string[]).includes(String(i.kind)) ? (i.kind as KnowledgeKind) : "fact"
    out.push({
      title: i.title.trim(),
      body: i.body.trim(),
      kind,
      zone: typeof i.zone === "string" ? i.zone : undefined,
      url: typeof i.url === "string" && /^https?:\/\//.test(i.url) ? i.url : undefined,
      updated_at: typeof i.updated_at === "string" && Number.isFinite(Date.parse(i.updated_at)) ? new Date(i.updated_at).toISOString() : undefined,
      ...keywordsOf(i.keywords, i.title),
    })
  }
  return out
}

/** Brain knowledge for an item Claude kept, filed in one of `zones` (those the connector may file into). */
export function toItem(c: Pick<McpConnectorConfig, "id" | "name">, s: SavedItem, zones: Zone[], now: number): KnowledgeItemInput {
  const title = truncate(s.title, 140)
  const body = truncate(s.body, 4000)
  const asked = s.zone && zones.some((z) => z.id === s.zone) ? s.zone : undefined
  const zone = asked ?? classifyZones(`${title} ${body}`, zones, 1)[0] ?? zones[0]?.id ?? "general"
  const ref = createHash("sha256").update(s.url ?? title.toLowerCase()).digest("hex").slice(0, 16)
  return {
    zone,
    kind: s.kind,
    title,
    body,
    entities: extractEntities(`${title}\n${body}`),
    source: { app: c.name, tool: "connector", at: s.updated_at ?? new Date(now).toISOString(), session_id: `mcp:${c.id}:${ref}`, screenpipe_ref: s.url },
    confidence: 0.7,
    ...(s.keywords?.length ? { keywords: s.keywords } : {}),
  }
}

export type ImportOutcome = { items: KnowledgeItemInput[]; calls: number; turns: number }

/** Exploration loop: Claude calls the read-only tools and returns its knowledge through save_knowledge. */
export async function exploreConnector(c: ImportedConnector, deps: ImportDeps): Promise<ImportOutcome> {
  const d = { ...deps, zones: importZones(c, deps.zones) }
  const now = d.now ?? Date.now
  const deadline = now() + IMPORT_LIMITS.deadlineMs
  if (!d.tools.length) throw new Error("no read-only tool on this server: nothing to explore")
  const taken = new Set<string>([SAVE_TOOL])
  const byClaudeName = new Map<string, string>()
  const tools: Anthropic.Beta.BetaToolUnion[] = d.tools.map((t) => {
    const name = claudeToolName(t.name, taken)
    byClaudeName.set(name, t.name)
    return { name, description: truncate(t.description ?? t.title ?? t.name, 1000), input_schema: t.input_schema as Anthropic.Beta.BetaTool["input_schema"] }
  })
  tools.push({ name: SAVE_TOOL, description: "Saves lasting knowledge in the company brain.", input_schema: SAVE_SCHEMA as unknown as Anthropic.Beta.BetaTool["input_schema"] })

  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: `Import into the brain what matters in ${c.name}.` }]
  const saved: SavedItem[] = []
  let calls = 0
  let turns = 0
  while (turns < IMPORT_LIMITS.turns && now() < deadline) {
    turns++
    const response = await d.claude.beta.messages.create({
      model: EXTRACT_MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium" },
      system: systemPrompt(c, d),
      tools,
      messages,
    })
    if (response.stop_reason === "refusal") throw new Error("Claude declined this exploration")
    // Full content sent back as is (thinking blocks included): the history is never edited.
    messages.push({ role: "assistant", content: response.content })
    if (response.stop_reason === "pause_turn") continue
    const uses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use")
    if (response.stop_reason !== "tool_use" || !uses.length) break
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = []
    for (const u of uses) {
      if (u.name === SAVE_TOOL) {
        const got = readSaved(u.input).slice(0, IMPORT_LIMITS.items - saved.length)
        saved.push(...got)
        results.push({ type: "tool_result", tool_use_id: u.id, content: `${got.length} item(s) saved, ${saved.length}/${IMPORT_LIMITS.items} in total.` })
        continue
      }
      const real = byClaudeName.get(u.name)
      if (!real || calls >= IMPORT_LIMITS.calls || now() >= deadline) {
        results.push({ type: "tool_result", tool_use_id: u.id, is_error: true, content: real ? "No calls left: save what you have with save_knowledge, then finish." : "Unknown tool." })
        continue
      }
      calls++
      try {
        const r = callResultText(await d.callTool(real, (u.input ?? {}) as Record<string, unknown>), IMPORT_LIMITS.resultChars)
        results.push({ type: "tool_result", tool_use_id: u.id, content: r.text, ...(r.is_error ? { is_error: true } : {}) })
      } catch (err) {
        results.push({ type: "tool_result", tool_use_id: u.id, is_error: true, content: truncate(err instanceof Error ? err.message : String(err), 500) })
      }
    }
    // All the results in a single user message.
    messages.push({ role: "user", content: results })
    if (saved.length >= IMPORT_LIMITS.items) break
  }
  return { items: saved.map((s) => toItem(c, s, d.zones, now())), calls, turns }
}
