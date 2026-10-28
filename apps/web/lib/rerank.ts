// Reranking (optional): a model rereads the first results of a search with the question and puts them in order of
// relevance. Off unless BRAIN_RERANK_MODEL is set (rerank-3, rerank-3-lite…); it uses the Voyage key of the
// embeddings. On any error, the results keep the search's order.

import { voyageKeyFromEnv } from "./embeddings"

export type Reranker = {
  model: string
  /** One relevance score (0 to 1) per document, in the documents' order. */
  rerank(query: string, documents: string[]): Promise<number[]>
}

const TIMEOUT_MS = 10_000
/** Results reread: beyond them, the search's order stands. */
export const RERANK_CANDIDATES = 20
/** A knowledge item is short; this bounds what is sent per item. */
const MAX_DOC_CHARS = 1500

export function rerankerFromEnv(env: Record<string, string | undefined> = process.env): Reranker | null {
  const model = env.BRAIN_RERANK_MODEL?.trim()
  const key = voyageKeyFromEnv(env)
  if (!model || !key) return null
  return {
    model,
    async rerank(query, documents) {
      const res = await fetch("https://api.voyageai.com/v1/rerank", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ query, documents, model, truncation: true }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (!res.ok) throw Object.assign(new Error(`rerank: ${res.status} ${(await res.text()).slice(0, 200)}`), { status: res.status })
      const data = (await res.json()) as { data?: { index: number; relevance_score: number }[] }
      const scores = new Array<number>(documents.length).fill(0)
      for (const d of data.data ?? []) scores[d.index] = d.relevance_score
      return scores
    },
  }
}

const g = globalThis as unknown as { __brainReranker?: Reranker | null }

export function getReranker(): Reranker | null {
  if (g.__brainReranker === undefined) g.__brainReranker = rerankerFromEnv()
  return g.__brainReranker
}

/** For the evaluation on a rate-limited account: time kept between two calls, and patience on a refusal (429). */
const pacing = { gapMs: 0, last: 0, failures: 0 }
export function paceReranker(gapMs: number) {
  pacing.gapMs = gapMs
}
/** Reranks that failed (the search kept its order): the evaluation reports them, a comparison needs 0. */
export const rerankFailures = () => pacing.failures

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function scoresWithPacing(r: Reranker, query: string, docs: string[]): Promise<number[]> {
  for (let attempt = 0; ; attempt++) {
    if (pacing.gapMs) {
      const left = pacing.last + pacing.gapMs - Date.now()
      if (left > 0) await wait(left)
      pacing.last = Date.now()
    }
    try {
      return await r.rerank(query, docs)
    } catch (err) {
      // Paced (evaluation): a refusal for the rate limit is waited out, a few times. In the app, no waiting.
      if (!pacing.gapMs || (err as { status?: number }).status !== 429 || attempt >= 4) throw err
      await wait(30_000)
    }
  }
}

/**
 * The first RERANK_CANDIDATES items in order of relevance to the query; `relevance` is the model's score (0 to 1).
 * Without a reranker, or on an error, the items as they came.
 */
export async function rerankItems<T extends { title: string; body: string }>(query: string, items: T[], r = getReranker()): Promise<(T & { relevance?: number })[]> {
  if (!r || items.length === 0) return items
  const head = items.slice(0, RERANK_CANDIDATES)
  try {
    const scores = await scoresWithPacing(r, query, head.map((i) => `${i.title}\n${i.body}`.slice(0, MAX_DOC_CHARS)))
    const ordered = head.map((it, n) => ({ ...it, relevance: scores[n] ?? 0 })).sort((a, b) => b.relevance - a.relevance)
    return [...ordered, ...items.slice(RERANK_CANDIDATES)]
  } catch (err) {
    pacing.failures++
    console.error("[rerank]", err instanceof Error ? err.message : err)
    return items
  }
}
