// Embeddings (recherche sémantique), optionnels : sans fournisseur configuré, la recherche reste lexicale.
//
// Fournisseurs, par ordre de priorité :
// - VOYAGE_API_KEY : Voyage AI (https://api.voyageai.com/v1/embeddings), modèle BRAIN_EMBEDDING_MODEL (défaut voyage-3.5-lite) ;
// - BRAIN_EMBEDDING_URL (+ BRAIN_EMBEDDING_KEY) : tout point de terminaison compatible OpenAI `/v1/embeddings`
//   (OpenAI, Mistral, Ollama en local avec nomic-embed-text, LM Studio…), modèle BRAIN_EMBEDDING_MODEL.
// Les vecteurs sont stockés tels quels (tableau de réels) et comparés en cosinus côté serveur : pas d'extension pgvector requise.

import { cosine } from "@brain/core"

export type EmbeddingKind = "query" | "document"

export type EmbeddingProvider = {
  id: "voyage" | "openai"
  model: string
  embed(texts: string[], kind: EmbeddingKind): Promise<number[][]>
}

const TIMEOUT_MS = 20_000
/** Taille des lots envoyés au fournisseur (Voyage accepte 128 textes, OpenAI 2048 ; on reste prudent). */
export const EMBED_BATCH = 64
/** Au-delà, un texte est tronqué avant l'envoi (les connaissances sont courtes, c'est une borne de sécurité). */
const MAX_CHARS = 6000

const g = globalThis as unknown as { __brainEmbedding?: EmbeddingProvider | null; __brainQueryCache?: Map<string, number[]> }

function build(): EmbeddingProvider | null {
  const voyage = process.env.VOYAGE_API_KEY
  if (voyage) {
    const model = process.env.BRAIN_EMBEDDING_MODEL || "voyage-3.5-lite"
    return {
      id: "voyage",
      model,
      embed: (texts, kind) =>
        post("https://api.voyageai.com/v1/embeddings", voyage, { input: texts.map(clip), model, input_type: kind, truncation: true }),
    }
  }
  const url = process.env.BRAIN_EMBEDDING_URL
  if (url) {
    const model = process.env.BRAIN_EMBEDDING_MODEL || "text-embedding-3-small"
    const key = process.env.BRAIN_EMBEDDING_KEY || ""
    return { id: "openai", model, embed: (texts) => post(url.replace(/\/+$/, ""), key, { input: texts.map(clip), model }) }
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
  if (!res.ok) throw new Error(`embeddings : ${res.status} ${(await res.text()).slice(0, 200)}`)
  const data = (await res.json()) as { data?: { index?: number; embedding?: number[] }[] }
  const rows = (data.data ?? []).slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
  const out = rows.map((r) => r.embedding ?? [])
  if (out.length !== (body as { input: string[] }).input.length || out.some((v) => v.length === 0)) throw new Error("embeddings : réponse incomplète")
  return out
}

/** Le fournisseur configuré, ou null (recherche lexicale seule). */
export function getEmbeddings(): EmbeddingProvider | null {
  if (g.__brainEmbedding === undefined) g.__brainEmbedding = build()
  return g.__brainEmbedding
}

/** Texte vectorisé d'une connaissance : titre, corps, entités. */
export function embeddingText(item: { title: string; body: string; entities?: { name: string }[] }): string {
  return [item.title, item.body, (item.entities ?? []).map((e) => e.name).join(", ")].filter(Boolean).join("\n")
}

/** Vecteurs de plusieurs connaissances, par lots ; null si aucun fournisseur. Une erreur du fournisseur remonte. */
export async function embedDocuments(texts: string[]): Promise<number[][] | null> {
  const p = getEmbeddings()
  if (!p || texts.length === 0) return p ? [] : null
  const out: number[][] = []
  for (let i = 0; i < texts.length; i += EMBED_BATCH) out.push(...(await p.embed(texts.slice(i, i + EMBED_BATCH), "document")))
  return out
}

const QUERY_CACHE_MAX = 300

/** Vecteur d'une requête (mis en cache : le dashboard et le MCP reposent souvent les mêmes questions) ; null sans fournisseur ou en cas d'échec. */
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

/** Classe des candidats par similarité cosinus avec la requête (les plus proches d'abord), au-dessus d'un seuil. */
export function rankBySimilarity<T extends { embedding?: number[] | null }>(query: number[], candidates: T[], opts: { minScore?: number; limit?: number } = {}): (T & { similarity: number })[] {
  const min = opts.minScore ?? 0.3
  return candidates
    .filter((c): c is T & { embedding: number[] } => Array.isArray(c.embedding) && c.embedding.length === query.length)
    .map((c) => ({ ...c, similarity: cosine(query, c.embedding) }))
    .filter((c) => c.similarity >= min)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, opts.limit ?? 50)
}
