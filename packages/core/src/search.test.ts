import { test } from "node:test"
import assert from "node:assert/strict"
import { cosine, expandQuery, jaccard, likeness, rrf } from "./search"

test("expandQuery : synonymes FR/EN, expressions à plusieurs mots, pas de doublon", () => {
  const { tokens, added } = expandQuery("comment déployer en prod ?")
  assert.deepEqual(tokens, ["comment", "deployer", "prod"])
  for (const t of ["deploy", "mise", "production", "release"]) assert.ok(added.includes(t), `attendu ${t}`)
  assert.ok(!added.includes("deployer"), "un token d'origine n'est pas rajouté")
  const inv = expandQuery("invoice overdue")
  assert.ok(inv.added.includes("facture"))
  assert.deepEqual(expandQuery("xyzzy").added, [])
})

test("jaccard et likeness : doublon, remplacement, sans rapport", () => {
  assert.equal(jaccard(["a", "b"], ["a", "b"]), 1)
  assert.equal(jaccard(["a", "b"], ["c"]), 0)
  const a = { kind: "decision", title: "Les abonnements passent à Stripe Billing", body: "On migre de Checkout vers Billing pour la proration des abonnements." }
  assert.equal(likeness({ ...a, body: `${a.body} ` }, a), "duplicate")
  const revised = { ...a, body: "Finalement on reste sur Checkout : Billing ne gère pas nos remises annuelles." }
  assert.equal(likeness(revised, a), "supersedes")
  assert.equal(likeness({ ...revised, kind: "task" }, { ...a, kind: "task" }), "different")
  assert.equal(likeness({ kind: "fact", title: "Burn mensuel de 62 k€", body: "Runway 14 mois." }, a), "different")
  // Un titre d'un seul mot (« Déploiement ») ne suffit pas à conclure au remplacement.
  assert.equal(likeness({ kind: "procedure", title: "Déploiement", body: "Merger sur main puis tagger" }, { kind: "procedure", title: "Déploiement", body: "Lancer le script de release" }), "different")
})

test("rrf : un résultat présent dans deux listes remonte", () => {
  const out = rrf([
    ["a", "b", "c"],
    ["c", "d"],
  ])
  assert.equal(out[0].id, "c")
  assert.ok(out.find((x) => x.id === "a")!.score > out.find((x) => x.id === "d")!.score)
})

test("cosine", () => {
  assert.ok(Math.abs(cosine([1, 0], [1, 0]) - 1) < 1e-9)
  assert.equal(cosine([1, 0], [0, 1]), 0)
  assert.equal(cosine([1, 0], [1]), 0)
  assert.equal(cosine([0, 0], [1, 1]), 0)
})
