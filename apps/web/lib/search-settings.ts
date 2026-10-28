// A company's search settings (Settings page): what the brain uses to search and what agents receive. Stored in
// the company's settings; the deployment decides what exists (VOYAGE_API_KEY, BRAIN_RERANK_MODEL, a Claude key), the
// company can only turn it off for itself. Missing or unreadable: the defaults, which are the behavior before the page.

import { z } from "zod"
import { getEmbeddings } from "./embeddings"
import { getReranker } from "./rerank"
import { getStore, type BrainStore } from "./store"

const SETTING = "search-settings"

export const AgentsFormatSchema = z.object({
  /** Results of a search_brain call when the agent does not ask for a number. */
  limit: z.number().int().min(3).max(20),
  /** compact: the 3 best in full, the others in one line (get_knowledge reads them); full: every result in full. */
  detail: z.enum(["compact", "full"]),
  /** Matching documents listed under the results, at most. */
  documents: z.number().int().min(0).max(5),
})

export const SearchSettingsSchema = z.object({
  /** Search by meaning with the deployment's embeddings: knowledge and questions are sent to its provider. */
  semantic: z.boolean(),
  /** The deployment's reranker rereads the best candidates with the question. */
  rerank: z.boolean(),
  /** The server writes the keywords of knowledge that arrives without any, with the company's Claude. */
  serverKeywords: z.boolean(),
  agents: AgentsFormatSchema,
})

export type SearchSettings = z.infer<typeof SearchSettingsSchema>
export type AgentsFormat = SearchSettings["agents"]

export const DEFAULT_SEARCH_SETTINGS: SearchSettings = {
  semantic: true,
  rerank: true,
  serverKeywords: true,
  agents: { limit: 8, detail: "compact", documents: 2 },
}

/** What an admin changes: any part, the rest stays. */
export const SearchSettingsPatchSchema = SearchSettingsSchema.omit({ agents: true })
  .partial()
  .extend({ agents: AgentsFormatSchema.partial().optional() })
  .strict()

export type SearchSettingsPatch = z.infer<typeof SearchSettingsPatchSchema>

type Stored = SearchSettings & { updated_at?: string; updated_by?: string }

/** The company's settings, the defaults filling what is missing (a setting added later, or nothing saved yet). */
export async function getSearchSettings(store: BrainStore = getStore()): Promise<SearchSettings & { updated_at?: string; updated_by?: string }> {
  const raw = await store.getOrgSetting(SETTING)
  if (!raw) return DEFAULT_SEARCH_SETTINGS
  try {
    const s = JSON.parse(raw) as Partial<Stored>
    const merged = { ...DEFAULT_SEARCH_SETTINGS, ...s, agents: { ...DEFAULT_SEARCH_SETTINGS.agents, ...(s.agents ?? {}) } }
    const ok = SearchSettingsSchema.safeParse(merged)
    return ok.success ? { ...ok.data, updated_at: s.updated_at, updated_by: s.updated_by } : DEFAULT_SEARCH_SETTINGS
  } catch {
    return DEFAULT_SEARCH_SETTINGS
  }
}

export async function setSearchSettings(store: BrainStore, patch: SearchSettingsPatch, updatedBy: string) {
  const current = await getSearchSettings(store)
  const next: Stored = {
    semantic: patch.semantic ?? current.semantic,
    rerank: patch.rerank ?? current.rerank,
    serverKeywords: patch.serverKeywords ?? current.serverKeywords,
    agents: { ...current.agents, ...(patch.agents ?? {}) },
    updated_at: new Date().toISOString(),
    updated_by: updatedBy,
  }
  await store.setOrgSetting(SETTING, JSON.stringify(next))
  return next
}

/** What the brain uses for this company's searches: the deployment's providers, unless the company turned them off. */
export async function searchTools(store: BrainStore = getStore()) {
  const s = await getSearchSettings(store)
  return { embeddings: s.semantic ? getEmbeddings() : null, reranker: s.rerank ? getReranker() : null, settings: s }
}
