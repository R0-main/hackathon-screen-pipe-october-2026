// Évaluation de la recherche sur l'entreprise de démo Fournil : npm run eval (après npm run seed).
// Pour chaque question, on attend qu'une connaissance donnée (reconnue par un morceau de son titre) sorte dans les
// 3 premiers résultats. Affiche précision@1, succès@3 et MRR, avec ou sans embeddings selon la configuration.
// Ajouter un cas : une ligne dans CASES. Un cas qui régresse se voit tout de suite.

import { hybridSearch } from "../lib/brain"
import { getEmbeddings } from "../lib/embeddings"
import { getStore, runInOrg } from "../lib/store"

type Case = { query: string; expect: string; zones?: string[] }

/** Formulations volontairement différentes des titres (synonymes, anglais, fautes légères). */
export const CASES: Case[] = [
  { query: "comment déployer en production ?", expect: "Déployer Fournil en production" },
  { query: "how do we ship a release", expect: "Déployer Fournil en production" },
  { query: "mise en prod", expect: "Déployer Fournil en production" },
  { query: "rapprochement Qonto", expect: "Rapprochement bancaire quotidien" },
  { query: "reconciliation bancaire", expect: "Rapprochement bancaire quotidien" },
  { query: "clôture mensuelle export cabinet", expect: "Clôture mensuelle" },
  { query: "quand déclarer la TVA", expect: "Déclarer la TVA" },
  { query: "abonnements stripe billing", expect: "Stripe Billing" },
  { query: "webhook invoice.paid", expect: "webhook Stripe" },
  { query: "restaurer une sauvegarde", expect: "Restaurer une sauvegarde Supabase" },
  { query: "backup restore staging", expect: "Restaurer une sauvegarde Supabase" },
  { query: "terminaux sumup se déconnectent", expect: "SumUp" },
  { query: "isolation des données par boulangerie", expect: "RLS Supabase" },
  { query: "prix par boutique", expect: "49 €" },
  { query: "pricing mensuel", expect: "49 €" },
  { query: "pipeline commercial octobre", expect: "Pipeline d'octobre" },
  { query: "La Mie Dorée export comptable", expect: "La Mie Dorée" },
  { query: "imprimante de tickets en panne", expect: "imprimante de tickets" },
  { query: "burn et runway", expect: "Burn mensuel" },
  { query: "objectif fin d'année clients", expect: "120 boulangeries" },
  { query: "notes de frais", expect: "Swile" },
  { query: "offline first PWA caisse", expect: "offline-first" },
  { query: "recruter un dev mobile", expect: "développeur·se mobile" },
  { query: "salon Europain leads", expect: "Europain" },
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
