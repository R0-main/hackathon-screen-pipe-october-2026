import { test } from "node:test"
import assert from "node:assert/strict"
import { DEFAULT_VOYAGE_MODEL, providerFromEnv } from "../lib/embeddings"
import type { NewItem } from "../lib/store/types"

test("embeddings: Voyage from VOYAGE_API_KEY, voyage-4 by default", () => {
  const p = providerFromEnv({ VOYAGE_API_KEY: "pa-test" })
  assert.equal(p?.id, "voyage")
  assert.equal(p?.model, DEFAULT_VOYAGE_MODEL)
  assert.equal(providerFromEnv({ VOYAGE_API_KEY: "pa-test", BRAIN_EMBEDDING_MODEL: "voyage-4-large" })?.model, "voyage-4-large")
})

test("embeddings: a Voyage key put in BRAIN_EMBEDDING_URL is taken as one, never called as an address", () => {
  const p = providerFromEnv({ BRAIN_EMBEDDING_URL: " pa-test " })
  assert.equal(p?.id, "voyage")
  assert.equal(p?.model, DEFAULT_VOYAGE_MODEL)
})

test("embeddings: a real address in BRAIN_EMBEDDING_URL stays an OpenAI-compatible endpoint; nothing set, no provider", () => {
  const p = providerFromEnv({ BRAIN_EMBEDDING_URL: "http://localhost:11434/v1/embeddings", BRAIN_EMBEDDING_MODEL: "nomic-embed-text" })
  assert.equal(p?.id, "openai")
  assert.equal(p?.model, "nomic-embed-text")
  assert.equal(providerFromEnv({}), null)
})

test("embeddings: knowledge from before embeddings catches up one batch at a time", async () => {
  const fs = await import("node:fs")
  const os = await import("node:os")
  const path = await import("node:path")
  const { FileStore } = await import("../lib/store/file")
  const store = new FileStore(fs.mkdtempSync(path.join(os.tmpdir(), "brain-embed-")))
  const item = (title: string): NewItem => ({
    zone: "dev", kind: "fact", title, body: `${title}.`, entities: [], author_id: "u1",
    source: { app: "Terminal", tool: "claude-code", at: new Date().toISOString() }, confidence: 0.8,
  })
  await store.insertItems([item("One"), item("Two"), item("Three")])
  const calls: number[] = []
  const fake = { id: "voyage" as const, model: "voyage-4-lite", embed: async (texts: string[]) => (calls.push(texts.length), texts.map(() => [1, 0, 0])) }
  const { backfillEmbeddings } = await import("../lib/embeddings")
  assert.equal(await backfillEmbeddings(store, fake, 2), 2)
  assert.equal(await backfillEmbeddings(store, fake, 2), 1)
  assert.equal(await backfillEmbeddings(store, fake, 2), 0, "nothing left: no call to the provider")
  assert.deepEqual(calls, [2, 1])
  assert.equal(await backfillEmbeddings(store, null), 0, "no provider, nothing to do")
})

test("rerank: off without BRAIN_RERANK_MODEL; reorders the first results by relevance; keeps the order on an error", async () => {
  const { rerankerFromEnv, rerankItems } = await import("../lib/rerank")
  assert.equal(rerankerFromEnv({ VOYAGE_API_KEY: "pa-test" }), null)
  assert.equal(rerankerFromEnv({ BRAIN_EMBEDDING_URL: "pa-test", BRAIN_RERANK_MODEL: "rerank-3" })?.model, "rerank-3")
  const items = ["deploy", "backup", "pricing"].map((title) => ({ id: title, title, body: "" }))
  const fake = { model: "rerank-3", rerank: async (_q: string, docs: string[]) => docs.map((d) => (d.startsWith("backup") ? 0.9 : 0.1)) }
  const out = await rerankItems("restore the database", items, fake)
  assert.deepEqual(out.map((i) => i.id), ["backup", "deploy", "pricing"])
  assert.equal(out[0].relevance, 0.9)
  const broken = { model: "rerank-3", rerank: async () => Promise.reject(new Error("down")) }
  assert.deepEqual((await rerankItems("x", items, broken)).map((i) => i.id), ["deploy", "backup", "pricing"])
})
