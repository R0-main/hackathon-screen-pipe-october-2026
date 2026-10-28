// The Settings page's data: the company's search settings, what the deployment offers, the state of the index and of
// the keywords, what an agent reads per search, the month's searches, and what leaves the company. Admins change the
// settings; members read them.

import { agentFormat, formatQuery, type ApiItem, type QueryResult } from "@brain/core/mcp"
import type { Viewer } from "./auth"
import { claudeKeyInfo, type ClaudeKeyInfo } from "./claude-key"
import { EMBED_BATCH, backfillEmbeddings, getEmbeddings } from "./embeddings"
import { isDemoCompany } from "./demo-mode"
import { getReranker } from "./rerank"
import { getSearchSettings, searchTools, type SearchSettings } from "./search-settings"
import { getStore, isStoreSetupError } from "./store"

/** Characters per token, for the estimate of what an agent reads (English and French prose). */
const CHARS_PER_TOKEN = 4
/** Knowledge the estimate is made from: the most recent, the closest to what a search returns. */
const ESTIMATE_SAMPLE = 40

export type SettingsOverview = {
  settings: SearchSettings & { updated_at?: string; updated_by?: string }
  /** An admin of a real company; not a member, nor anyone on the public demo (its settings are read-only). */
  can_edit: boolean
  demo: boolean
  /** What the deployment offers; the company's settings can only turn it off. */
  deployment: { embeddings: { provider: string; model: string } | null; reranker: { model: string } | null }
  /** Admins: the key's last characters and its date; members: where Claude comes from. */
  claude: ClaudeKeyInfo
  /** Current knowledge, and how much of it has vectors of the deployment's model (null without semantic search). */
  index: { model: string; total: number; missing: number } | null
  keywords: { total: number; missing: number }
  /** Tokens an agent reads per search_brain answer, estimated from the company's own knowledge. */
  tokens: { compact: number; full: number; sample: number }
  usage: { month: string; agent_searches: number }
  /** Who receives what, given the settings. */
  leaves: { who: string; what: string }[]
}

export async function settingsOverview(viewer: Viewer): Promise<SettingsOverview> {
  const store = getStore()
  const admin = viewer.real.role === "admin"
  const demo = await isDemoCompany(viewer.real.org_id)
  const [settings, key, items, zones, profiles, tools] = await Promise.all([
    getSearchSettings(store),
    claudeKeyInfo(store),
    store.listItems({ limit: 100_000, excludeSuperseded: true }),
    store.listZones(),
    store.listProfiles(),
    searchTools(store),
  ])
  const embeddings = getEmbeddings()
  const reranker = getReranker()

  let index: SettingsOverview["index"] = null
  if (embeddings) {
    const missing = await store.listItemsWithoutEmbedding(embeddings.model, 100_000).then(
      (l) => l.length,
      (err) => (isStoreSetupError(err) ? items.length : Promise.reject(err)),
    )
    index = { model: embeddings.model, total: items.length, missing }
  }

  const names = new Map(profiles.map((p) => [p.id, p.name]))
  const zoneName = new Map(zones.map((z) => [z.id, z.name]))
  const sample: ApiItem[] = items.slice(0, ESTIMATE_SAMPLE).map((i) => ({ ...i, author: names.get(i.author_id) ?? "?" }))
  const tokens = { compact: 0, full: 0, sample: sample.length }
  if (sample.length) {
    // The company's number of results, taken from its recent knowledge in turn.
    const picked = Array.from({ length: settings.agents.limit }, (_, n) => sample[n % sample.length])
    const result: QueryResult = { query: "how do we …", zones_searched: zones.map((z) => z.id), zones_hit: [], zones_restricted: [], items: picked, documents: [] }
    const count = (detail: "compact" | "full") =>
      Math.round(formatQuery(result, (id) => zoneName.get(id) ?? id, agentFormat(detail, settings.agents)).length / CHARS_PER_TOKEN)
    tokens.compact = count("compact")
    tokens.full = count("full")
  }

  const now = new Date()
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString()
  const searches = await store.listEvents({ sinceIso: monthStart, type: "query", limit: 100_000 })

  const leaves: SettingsOverview["leaves"] = []
  if (key.source)
    leaves.push({
      who: "Anthropic (Claude)",
      what: `the knowledge read for the company summary, moderation and connector imports${settings.serverKeywords ? ", and the knowledge that gets keywords" : ""}`,
    })
  if (tools.embeddings) leaves.push({ who: providerName(tools.embeddings.id), what: "every knowledge item's text, to index it, and each search's question" })
  if (tools.reranker) leaves.push({ who: "Voyage AI (reranking)", what: "each search's question and its 20 best candidates" })

  return {
    settings,
    can_edit: admin && !demo,
    demo,
    deployment: { embeddings: embeddings ? { provider: providerName(embeddings.id), model: embeddings.model } : null, reranker: reranker ? { model: reranker.model } : null },
    claude: admin ? key : { source: key.source },
    index,
    keywords: { total: items.length, missing: items.filter((i) => !i.keywords?.length).length },
    tokens,
    usage: { month: monthStart.slice(0, 7), agent_searches: searches.filter((e) => e.agent === "mcp").length },
    leaves,
  }
}

function providerName(id: string): string {
  return id === "voyage" ? "Voyage AI (embeddings)" : "the embeddings endpoint"
}

/** Settings, "Index the rest": vectors for the knowledge that has none of the model, for about `budgetMs`. */
export async function catchUpIndex(budgetMs = 20_000): Promise<{ added: number } | null> {
  const { embeddings } = await searchTools()
  if (!embeddings) return null
  const deadline = Date.now() + budgetMs
  let added = 0
  while (Date.now() < deadline) {
    const n = await backfillEmbeddings(getStore(), embeddings, EMBED_BATCH)
    added += n
    if (n < EMBED_BATCH) break
  }
  return { added }
}
