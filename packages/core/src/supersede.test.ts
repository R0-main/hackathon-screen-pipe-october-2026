import { test } from "node:test"
import assert from "node:assert/strict"
import { heuristicSupersedes, supersedeCandidates, type SupersedeComparable } from "./index"

let n = 0
function item(title: string, body: string, opts: Partial<SupersedeComparable> & { daysAgo?: number; tools?: string[] } = {}): SupersedeComparable {
  const at = new Date(Date.now() - (opts.daysAgo ?? 0) * 86400_000).toISOString()
  return {
    id: opts.id ?? `i${++n}`,
    zone: opts.zone ?? "compta",
    kind: opts.kind ?? "decision",
    title,
    body,
    entities: opts.entities ?? (opts.tools ?? []).map((name) => ({ type: "tool" as const, name })),
    source: { app: "Terminal", tool: "claude-code", at },
    created_at: at,
    ...(opts.superseded_by ? { superseded_by: opts.superseded_by } : {}),
  }
}

const stripe = item("On utilise Stripe pour les paiements en ligne", "Stripe gère le paiement des précommandes.", { daysAgo: 20, tools: ["Stripe"] })
const mollie = item("On passe de Stripe à Mollie pour les paiements", "Mollie prend moins de commission sur les cartes européennes.", { tools: ["Stripe", "Mollie"] })

test("remplacement : une décision qui change d'outil remplace l'ancienne (heuristique)", () => {
  assert.deepEqual(supersedeCandidates(mollie, [stripe]).map((c) => c.id), [stripe.id])
  assert.ok(heuristicSupersedes(mollie, stripe))
})

test("remplacement : candidates seulement plus anciennes, même zone, même type, encore d'actualité", () => {
  const pool = [
    stripe,
    { ...stripe, id: "autre-zone", zone: "dev" },
    { ...stripe, id: "autre-type", kind: "task" as const },
    { ...stripe, id: "deja-remplacee", superseded_by: "x" },
    { ...stripe, id: "plus-recente", source: { ...stripe.source, at: new Date(Date.now() + 86400_000).toISOString() } },
    item("Le loyer du local passe à 1 800 €", "Bail renouvelé.", { daysAgo: 5 }),
  ]
  assert.deepEqual(supersedeCandidates(mollie, pool).map((c) => c.id), [stripe.id])
  // Une tâche ne « remplace » rien.
  assert.deepEqual(supersedeCandidates({ ...mollie, kind: "task" }, pool), [])
})

test("remplacement : une précision, un autre sujet ou un même titre sur un autre fait ne remplacent pas", () => {
  const deploy = item("Déploiement en staging avant la production", "Chaque mise en ligne passe par staging.", { zone: "dev", kind: "procedure", daysAgo: 10 })
  const e2e = item("Désormais les tests e2e tournent avant le déploiement en staging", "Playwright sur la CI.", { zone: "dev", kind: "procedure" })
  assert.ok(!heuristicSupersedes(e2e, deploy), "un ajout à la procédure n'est pas un remplacement")
  const qontoTitle = item("Outils compta", "On a décidé de passer à Pennylane.", { kind: "fact", daysAgo: 1 })
  const sameTitleOtherFact = item("Outils compta", "On garde Qonto pour la trésorerie.", { kind: "fact" })
  assert.ok(!heuristicSupersedes(sameTitleOtherFact, qontoTitle), "même titre, autre fait : gardés tous les deux")
  const closing = item("Procédure de clôture mensuelle", "Exporter les relevés Qonto le 3, rapprocher dans Pennylane, envoyer au comptable le 5.", { kind: "procedure", daysAgo: 30 })
  const closing2 = item("Procédure de clôture mensuelle", "Exporter les relevés Qonto le 2, rapprocher dans Pennylane, envoyer au comptable le 4.", { kind: "procedure" })
  assert.ok(heuristicSupersedes(closing2, closing), "même procédure mise à jour : remplacée")
  assert.ok(!heuristicSupersedes(closing, { ...closing, id: "copie" }), "contenu identique : rien de nouveau")
})
