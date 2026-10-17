// Computes the semantic vectors of knowledge items that have none (or one from another model): npm run embed
// Needs a provider (VOYAGE_API_KEY, or BRAIN_EMBEDDING_URL); on Postgres, migration 20261017000006.
// The database's default company; BRAIN_ORG_ID=<uuid> for a company created from /create.

import { EMBED_BATCH, embedDocuments, embeddingText, getEmbeddings } from "../lib/embeddings"
import { getRootStore, storeForOrg } from "../lib/store"

async function main() {
  const provider = getEmbeddings()
  if (!provider) throw new Error("No embeddings provider: set VOYAGE_API_KEY or BRAIN_EMBEDDING_URL.")
  const root = getRootStore()
  const store = process.env.BRAIN_ORG_ID ? storeForOrg(process.env.BRAIN_ORG_ID) : root
  let total = 0
  for (;;) {
    const items = await store.listItemsWithoutEmbedding(provider.model, EMBED_BATCH)
    if (items.length === 0) break
    const vectors = await embedDocuments(items.map(embeddingText))
    if (!vectors) break
    await store.setEmbeddings(items.map((it, n) => ({ id: it.id, embedding: vectors[n], model: provider.model })))
    total += items.length
    console.log(`· ${total} knowledge items embedded (${provider.model})`)
  }
  console.log(`✓ done: ${total} knowledge item(s) embedded.`)
  const s = root as { end?: () => Promise<void> }
  if (typeof s.end === "function") await s.end()
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
