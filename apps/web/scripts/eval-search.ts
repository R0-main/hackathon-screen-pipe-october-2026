// Évaluation de la recherche sur l'entreprise de démo Butine : npm run eval (après npm run seed).
// Pour chaque question, on attend qu'une connaissance donnée (reconnue par un morceau de son titre) sorte dans les
// 3 premiers résultats. Affiche précision@1, succès@3 et MRR, avec ou sans embeddings selon la configuration.
// Ajouter un cas : une ligne dans CASES. Un cas qui régresse se voit tout de suite.

import { hybridSearch } from "../lib/brain"
import { getEmbeddings } from "../lib/embeddings"
import { getStore, runInOrg } from "../lib/store"

type Case = { query: string; expect: string; zones?: string[] }

/** Formulations volontairement différentes des titres (synonymes, anglais, fautes légères). */
export const CASES: Case[] = [
  { query: "comment déployer en production ?", expect: "Déployer Butine en production" },
  { query: "how do we ship a release", expect: "Déployer Butine en production" },
  { query: "mise en prod", expect: "Déployer Butine en production" },
  { query: "rapprochement Qonto", expect: "Rapprochement bancaire quotidien" },
  { query: "reconciliation bancaire", expect: "Rapprochement bancaire quotidien" },
  { query: "clôture mensuelle export cabinet", expect: "Clôture mensuelle" },
  { query: "quand déclarer la TVA", expect: "Déclarer la TVA" },
  { query: "abonnements stripe billing", expect: "Stripe Billing" },
  { query: "webhook invoice.paid", expect: "webhook Stripe" },
  { query: "restaurer une sauvegarde", expect: "Restaurer une sauvegarde Supabase" },
  { query: "backup restore staging", expect: "Restaurer une sauvegarde Supabase" },
  { query: "dérive des balances par grand froid", expect: "nuit de gel" },
  { query: "isolation des données par apiculteur", expect: "RLS Supabase" },
  { query: "prix par ruche", expect: "4 € par ruche" },
  { query: "pricing mensuel", expect: "4 € par ruche" },
  { query: "pipeline commercial octobre", expect: "Pipeline d'octobre" },
  { query: "Miellerie Roussel export des pesées", expect: "Miellerie Roussel" },
  { query: "balance muette qui n'envoie plus rien", expect: "Réveiller une balance" },
  { query: "fausses alertes essaimage à la récolte", expect: "fausses alertes d'essaimage" },
  { query: "burn et runway", expect: "Burn mensuel" },
  { query: "objectif fin d'année ruches", expect: "4 500 ruches" },
  { query: "notes de frais", expect: "Swile" },
  { query: "mémoire tampon hors réseau", expect: "le réseau LoRa tombe" },
  { query: "frelon asiatique", expect: "frelon" },
  { query: "recruter un dev embarqué", expect: "embarqué" },
  { query: "congrès Miel & Ruches leads", expect: "40 % des leads" },
]

async function main() {
  const store = getStore()
  const profiles = await store.listProfiles()
  const admin = profiles.find((p) => p.role === "admin")
  if (!admin) throw new Error("Aucun admin : lancez d'abord npm run seed.")
  const zones = (await store.listZones()).map((z) => z.id)
  const provider = getEmbeddings()
  console.log(`Recherche : lexical + synonymes${provider ? ` + embeddings (${provider.id}, ${provider.model})` : " (sans embeddings : VOYAGE_API_KEY ou BRAIN_EMBEDDING_URL absent)"}`)
  console.log("")
  let p1 = 0
  let s3 = 0
  let mrr = 0
  const failures: string[] = []
  await runInOrg(admin.org_id, async () => {
    for (const c of CASES) {
      const results = await hybridSearch(c.query, c.zones ?? zones, 5)
      const rank = results.findIndex((r) => r.title.toLowerCase().includes(c.expect.toLowerCase()))
      if (rank === 0) p1++
      if (rank >= 0 && rank < 3) s3++
      if (rank >= 0) mrr += 1 / (rank + 1)
      const mark = rank === 0 ? "✓" : rank >= 0 && rank < 3 ? "~" : "✗"
      console.log(`${mark} ${c.query.padEnd(44)} → ${rank >= 0 ? `rang ${rank + 1}` : "absent "}  (${c.expect})`)
      if (rank < 0 || rank >= 3) failures.push(`${c.query} : ${results.map((r) => r.title).slice(0, 3).join(" | ") || "aucun résultat"}`)
    }
  })
  const n = CASES.length
  console.log("")
  console.log(`précision@1 ${((p1 / n) * 100).toFixed(0)} %   succès@3 ${((s3 / n) * 100).toFixed(0)} %   MRR ${(mrr / n).toFixed(2)}   (${n} questions)`)
  if (failures.length) {
    console.log("")
    console.log("À regarder :")
    for (const f of failures) console.log(`  - ${f}`)
  }
  const s = store as { end?: () => Promise<void> }
  if (typeof s.end === "function") await s.end()
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
