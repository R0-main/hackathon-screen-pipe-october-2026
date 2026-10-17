// Import du contenu d'un connecteur MCP dans le cerveau : Claude explore l'outil avec ses seuls outils en lecture seule
// (recherche, listes, lecture de pages ou de tickets récents), puis rend des connaissances durables (décisions,
// procédures, faits sur les projets et les clients) via `save_knowledge`. Elles entrent par ingestItems, comme une
// synchro de connecteur : masquage des secrets, doublons écartés, zone du connecteur ou classement automatique.
// Boucle d'outils menée à la main : les outils viennent d'un serveur distant (schémas JSON bruts), avec un plafond de
// tours, d'appels et de durée pour tenir dans une fonction serverless.

import { createHash } from "node:crypto"
import type Anthropic from "@anthropic-ai/sdk"
import {
  KNOWLEDGE_KINDS,
  callResultText,
  claudeToolName,
  classifyZones,
  extractEntities,
  truncate,
  type KnowledgeItemInput,
  type KnowledgeKind,
  type McpConnectorConfig,
  type McpToolDef,
  type Zone,
} from "@brain/core"
import { EXTRACT_MODEL } from "@brain/core/claude"

/** Ce dont l'import a besoin, injectable pour les tests (Claude simulé, outils et cerveau en mémoire). */
export type ImportDeps = {
  claude: Pick<Anthropic, "beta">
  /** Outils en lecture seule du connecteur. */
  tools: McpToolDef[]
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>
  zones: Zone[]
  org: { name: string; description?: string }
  /** Dernier import réussi : Claude se concentre sur ce qui a changé depuis. */
  since?: string
  now?: () => number
}

export const IMPORT_LIMITS = { turns: 12, calls: 30, items: 40, deadlineMs: 100_000, resultChars: 12_000 }

const SAVE_TOOL = "save_knowledge"

type SavedItem = { title: string; body: string; kind: KnowledgeKind; zone?: string; url?: string; updated_at?: string }

function systemPrompt(c: Pick<McpConnectorConfig, "name">, d: ImportDeps): string {
  const zones = d.zones.map((z) => `- ${z.id} : ${z.name}${z.description ? ` — ${z.description}` : ""}`).join("\n")
  return [
    `Tu alimentes le cerveau d'entreprise de ${d.org.name}${d.org.description ? ` (${d.org.description.trim()})` : ""} à partir de ${c.name}, branché par un admin.`,
    `Explore ${c.name} avec les outils fournis (lecture seule) : commence par ce qui a été créé ou modifié ${d.since ? `depuis le ${d.since.slice(0, 10)}` : "récemment"}, puis lis les éléments qui en valent la peine.`,
    `Retiens seulement des connaissances durables et utiles à un collègue : décisions et leur raison, procédures, faits sur les projets, les clients et les outils, questions ouvertes, tâches importantes.`,
    `Chaque connaissance : un titre court et précis, 1 à 5 phrases autonomes (qui, quoi, pourquoi), en français, le lien source si tu l'as. Pas de données personnelles sensibles, pas de secrets (mots de passe, clés, jetons), pas de bavardage.`,
    `Enregistre-les avec ${SAVE_TOOL} (par lots), au plus ${IMPORT_LIMITS.items} au total. Choisis la zone la plus proche parmi :\n${zones || "- general"}`,
    `Tu disposes d'environ ${IMPORT_LIMITS.calls} appels d'outils : sois sélectif. Quand c'est fait, réponds en une phrase.`,
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
          title: { type: "string", description: "Titre court et précis (moins de 120 caractères)." },
          body: { type: "string", description: "1 à 5 phrases autonomes, avec le pourquoi." },
          kind: { type: "string", enum: [...KNOWLEDGE_KINDS] },
          zone: { type: "string", description: "Identifiant de zone." },
          url: { type: "string", description: "Lien vers la source, si connu." },
          updated_at: { type: "string", description: "Date de dernière modification de la source (ISO), si connue." },
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
    })
  }
  return out
}

/** Connaissance du cerveau pour un élément retenu par Claude. */
export function toItem(c: Pick<McpConnectorConfig, "id" | "name" | "zone">, s: SavedItem, zones: Zone[], now: number): KnowledgeItemInput {
  const title = truncate(s.title, 140)
  const body = truncate(s.body, 4000)
  const fixed = c.zone && zones.some((z) => z.id === c.zone) ? c.zone : undefined
  const asked = s.zone && zones.some((z) => z.id === s.zone) ? s.zone : undefined
  const zone = fixed ?? asked ?? classifyZones(`${title} ${body}`, zones, 1)[0] ?? zones[0]?.id ?? "general"
  const ref = createHash("sha256").update(s.url ?? title.toLowerCase()).digest("hex").slice(0, 16)
  return {
    zone,
    kind: s.kind,
    title,
    body,
    entities: extractEntities(`${title}\n${body}`),
    source: { app: c.name, tool: "connector", at: s.updated_at ?? new Date(now).toISOString(), session_id: `mcp:${c.id}:${ref}`, screenpipe_ref: s.url },
    confidence: 0.7,
  }
}

export type ImportOutcome = { items: KnowledgeItemInput[]; calls: number; turns: number }

/** Boucle d'exploration : Claude appelle les outils en lecture seule et rend ses connaissances par save_knowledge. */
export async function exploreConnector(c: Pick<McpConnectorConfig, "id" | "name" | "zone">, d: ImportDeps): Promise<ImportOutcome> {
  const now = d.now ?? Date.now
  const deadline = now() + IMPORT_LIMITS.deadlineMs
  if (!d.tools.length) throw new Error("aucun outil en lecture seule sur ce serveur : rien à explorer")
  const taken = new Set<string>([SAVE_TOOL])
  const byClaudeName = new Map<string, string>()
  const tools: Anthropic.Beta.BetaToolUnion[] = d.tools.map((t) => {
    const name = claudeToolName(t.name, taken)
    byClaudeName.set(name, t.name)
    return { name, description: truncate(t.description ?? t.title ?? t.name, 1000), input_schema: t.input_schema as Anthropic.Beta.BetaTool["input_schema"] }
  })
  tools.push({ name: SAVE_TOOL, description: "Enregistre des connaissances durables dans le cerveau d'entreprise.", input_schema: SAVE_SCHEMA as unknown as Anthropic.Beta.BetaTool["input_schema"] })

  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: `Importe dans le cerveau ce qui compte dans ${c.name}.` }]
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
    if (response.stop_reason === "refusal") throw new Error("Claude a refusé cette exploration")
    // Contenu complet renvoyé tel quel (blocs de réflexion compris) : l'historique ne se modifie pas.
    messages.push({ role: "assistant", content: response.content })
    if (response.stop_reason === "pause_turn") continue
    const uses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use")
    if (response.stop_reason !== "tool_use" || !uses.length) break
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = []
    for (const u of uses) {
      if (u.name === SAVE_TOOL) {
        const got = readSaved(u.input).slice(0, IMPORT_LIMITS.items - saved.length)
        saved.push(...got)
        results.push({ type: "tool_result", tool_use_id: u.id, content: `${got.length} connaissance(s) enregistrée(s), ${saved.length}/${IMPORT_LIMITS.items} au total.` })
        continue
      }
      const real = byClaudeName.get(u.name)
      if (!real || calls >= IMPORT_LIMITS.calls || now() >= deadline) {
        results.push({ type: "tool_result", tool_use_id: u.id, is_error: true, content: real ? "Plus d'appels disponibles : enregistre ce que tu as avec save_knowledge puis termine." : "Outil inconnu." })
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
    // Tous les résultats dans un seul message utilisateur.
    messages.push({ role: "user", content: results })
    if (saved.length >= IMPORT_LIMITS.items) break
  }
  return { items: saved.map((s) => toItem(c, s, d.zones, now())), calls, turns }
}
