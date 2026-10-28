// Embeddings (semantic search), optional: without a configured provider, search stays lexical.
//
// Providers, in priority order:
// - VOYAGE_API_KEY: Voyage AI (https://api.voyageai.com/v1/embeddings), model BRAIN_EMBEDDING_MODEL (default voyage-4);
//   a Voyage key put in BRAIN_EMBEDDING_URL works too: a value that is no http(s) address is taken as one;
// - BRAIN_EMBEDDING_URL (+ BRAIN_EMBEDDING_KEY): any endpoint compatible with OpenAI's `/v1/embeddings`
//   (OpenAI, Mistral, Ollama locally with nomic-embed-text, LM Studio…), model BRAIN_EMBEDDING_MODEL.
// Vectors are stored as is (array of floats) and compared by cosine on the server: no pgvector extension required.

import { cosine } from "@brain/core"
import type { BrainStore } from "./store/types"

export type EmbeddingKind = "query" | "document"

export type EmbeddingProvider = {
  id: "voyage" | "openai"
  model: string
  embed(texts: string[], kind: EmbeddingKind): Promise<number[][]>
}

const TIMEOUT_MS = 20_000
/** Size of the batches sent to the provider (Voyage accepts 128 texts, OpenAI 2048; we stay careful). */
export const EMBED_BATCH = 64
/** Beyond this, a text is truncated before sending (knowledge items are short, this is a safety bound). */
const MAX_CHARS = 6000

const g = globalThis as unknown as { __brainEmbedding?: EmbeddingProvider | null; __brainQueryCache?: Map<string, number[]> }

/** Voyage model when BRAIN_EMBEDDING_MODEL is not set. On the evaluation (141 questions), voyage-4 finds the answer
 * first 83% of the time, voyage-4-lite 80%, voyage-4-large 84%; the three share one vector space. */
export const DEFAULT_VOYAGE_MODEL = "voyage-4"

const isAddress = (v: string) => /^https?:\/\//i.test(v)

/** The provider the environment configures, or null. Exported for the tests; the app goes through getEmbeddings. */
/** The Voyage key: VOYAGE_API_KEY, or one filled in BRAIN_EMBEDDING_URL (never called as an address, it would end up
 * in the error logs). Shared with the reranker. */
export function voyageKeyFromEnv(env: Record<string, string | undefined> = process.env): string | undefined {
  const endpoint = env.BRAIN_EMBEDDING_URL?.trim()
  return env.VOYAGE_API_KEY?.trim() || (endpoint && !isAddress(endpoint) ? endpoint : undefined)
}

export function providerFromEnv(env: Record<string, string | undefined> = process.env): EmbeddingProvider | null {
  const endpoint = env.BRAIN_EMBEDDING_URL?.trim()
  const voyage = voyageKeyFromEnv(env)
  if (voyage) {
    const model = env.BRAIN_EMBEDDING_MODEL || DEFAULT_VOYAGE_MODEL
    return {
      id: "voyage",
      model,
      embed: (texts, kind) =>
        post("https://api.voyageai.com/v1/embeddings", voyage, { input: texts.map(clip), model, input_type: kind, truncation: true }),
    }
  }
  if (endpoint && isAddress(endpoint)) {
    const model = env.BRAIN_EMBEDDING_MODEL || "text-embedding-3-small"
    const key = env.BRAIN_EMBEDDING_KEY || ""
    return { id: "openai", model, embed: (texts) => post(endpoint.replace(/\/+$/, ""), key, { input: texts.map(clip), model }) }
  }
  return null
}

function clip(s: string): string {
  return s.length > MAX_CHARS ? s.slice(0, MAX_CHARS) : s
}

async function post(url: string, key: string, body: unknown): Promise<number[][]> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`embeddings: ${res.status} ${(await res.text()).slice(0, 200)}`)
  const data = (await res.json()) as { data?: { index?: number; embedding?: number[] }[] }
  const rows = (data.data ?? []).slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
  const out = rows.map((r) => r.embedding ?? [])
  if (out.length !== (body as { input: string[] }).input.length || out.some((v) => v.length === 0)) throw new Error("embeddings: incomplete response")
  return out
}

/** The configured provider, or null (lexical search only). */
export function getEmbeddings(): EmbeddingProvider | null {
  if (g.__brainEmbedding === undefined) g.__brainEmbedding = providerFromEnv()
  return g.__brainEmbedding
}

/** Embedded text of a knowledge item: title, body, entities. */
export function embeddingText(item: { title: string; body: string; entities?: { name: string }[] }): string {
  return [item.title, item.body, (item.entities ?? []).map((e) => e.name).join(", ")].filter(Boolean).join("\n")
}

/** Vectors of several items, in batches; null if there is no provider. A provider error propagates. */
export async function embedDocuments(texts: string[]): Promise<number[][] | null> {
  const p = getEmbeddings()
  if (!p || texts.length === 0) return p ? [] : null
  const out: number[][] = []
  for (let i = 0; i < texts.length; i += EMBED_BATCH) out.push(...(await p.embed(texts.slice(i, i + EMBED_BATCH), "document")))
  return out
}

const QUERY_CACHE_MAX = 500

/** Vector of a query (cached: the dashboard and the MCP often ask the same questions); null without a provider or on failure. */
export async function embedQuery(query: string): Promise<number[] | null> {
  const p = getEmbeddings()
  if (!p) return null
  const cache = (g.__brainQueryCache ??= new Map())
  const key = `${p.id}:${p.model}:${query.trim().toLowerCase()}`
  const hit = cache.get(key)
  if (hit) return hit
  try {
    const [vec] = await p.embed([query], "query")
    cache.set(key, vec)
    if (cache.size > QUERY_CACHE_MAX) cache.delete(cache.keys().next().value as string)
    return vec
  } catch (err) {
    console.error("[embeddings]", err instanceof Error ? err.message : err)
    return null
  }
}

/**
 * Vectors of many queries in a few requests (`batch` per request), into the cache embedQuery reads. For the
 * evaluation, which asks ~170 questions in a row: one request per question would exceed a provider's rate limit
 * (Voyage without a payment method: 3 requests a minute). Returns how many queries were embedded.
 */
export async function primeQueryCache(queries: string[], batch = 128): Promise<number> {
  const p = getEmbeddings()
  if (!p) return 0
  const cache = (g.__brainQueryCache ??= new Map())
  const keyOf = (q: string) => `${p.id}:${p.model}:${q.trim().toLowerCase()}`
  const todo = [...new Map(queries.filter((q) => !cache.has(keyOf(q))).map((q) => [keyOf(q), q])).values()]
  for (let i = 0; i < todo.length; i += batch) {
    const part = todo.slice(i, i + batch)
    const vectors = await p.embed(part.map(clip), "query")
    part.forEach((q, n) => cache.set(keyOf(q), vectors[n]))
  }
  return todo.length
}

/** Ranks the candidates by cosine similarity with the query (closest first), above a threshold. */
export function rankBySimilarity<T extends { embedding?: number[] | null }>(query: number[], candidates: T[], opts: { minScore?: number; limit?: number } = {}): (T & { similarity: number })[] {
  const min = opts.minScore ?? 0.3
  return candidates
    .filter((c): c is T & { embedding: number[] } => Array.isArray(c.embedding) && c.embedding.length === query.length)
    .map((c) => ({ ...c, similarity: cosine(query, c.embedding) }))
    .filter((c) => c.similarity >= min)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, opts.limit ?? 50)
}

/**
 * Knowledge that came in before embeddings were set up (or under another model): one batch of it gets its vectors
 * with each ingestion, so semantic search catches up on its own, without npm run embed. Returns how many.
 */
export async function backfillEmbeddings(
  store: Pick<BrainStore, "listItemsWithoutEmbedding" | "setEmbeddings">,
  provider: EmbeddingProvider | null = getEmbeddings(),
  limit = EMBED_BATCH,
): Promise<number> {
  if (!provider) return 0
  const old = await store.listItemsWithoutEmbedding(provider.model, limit)
  if (old.length === 0) return 0
  const vectors = await provider.embed(old.map((it) => clip(embeddingText(it))), "document")
  await store.setEmbeddings(old.map((it, n) => ({ id: it.id, embedding: vectors[n], model: provider.model })))
  return old.length
}
