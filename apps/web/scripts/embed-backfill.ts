// Calcule les vecteurs sémantiques des connaissances qui n'en ont pas (ou d'un autre modèle) : npm run embed
// Nécessite un fournisseur (VOYAGE_API_KEY, ou BRAIN_EMBEDDING_URL) ; en Postgres, la migration 20261017000006.
// Entreprise de la base par défaut ; BRAIN_ORG_ID=<uuid> pour une entreprise créée depuis /creer.

import { EMBED_BATCH, embedDocuments, embeddingText, getEmbeddings } from "../lib/embeddings"
import { getRootStore, storeForOrg } from "../lib/store"

async function main() {
  const provider = getEmbeddings()
  if (!provider) throw new Error("Aucun fournisseur d'embeddings : définissez VOYAGE_API_KEY ou BRAIN_EMBEDDING_URL.")
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
    console.log(`· ${total} connaissances vectorisées (${provider.model})`)
  }
  console.log(`✓ terminé : ${total} connaissance(s) vectorisée(s).`)
  const s = root as { end?: () => Promise<void> }
  if (typeof s.end === "function") await s.end()
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
