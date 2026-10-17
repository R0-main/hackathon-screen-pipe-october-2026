import { test } from "node:test"
import assert from "node:assert/strict"
import { cosine, expandQuery, jaccard, likeness, matchStrength, rrf, strongEnough } from "./search"

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

test("matchStrength : un synonyme qui n'attrape qu'un mot isolé du corps ne suffit pas", () => {
  const { tokens, added } = expandQuery("déployer en production")
  const q = [...tokens, ...added]
  const compta = { title: "Clôture mensuelle : export Pennylane avant le 5 pour le cabinet Durand", body: "L'expert-comptable (cabinet Durand) produit la situation mensuelle sous 10 jours à partir de cet export.", entities: [{ name: "Pennylane" }] }
  const s = matchStrength(q, compta)
  assert.equal(s.title, 0)
  assert.equal(s.total, 1, "« prod » attrape « produit » dans le corps, et rien d'autre")
  assert.equal(strongEnough(s), false)
  const dev = { title: "Déployer Fournil en production", body: "1. Merger sur main. 2. Tagger. 3. Surveiller Sentry.", entities: [{ name: "Vercel" }] }
  assert.equal(strongEnough(matchStrength(q, dev)), true)
  const release = matchStrength([...expandQuery("how do we ship a release").tokens, ...expandQuery("how do we ship a release").added], dev)
  assert.ok(release.title >= 1, "« release » étend à « deployer », trouvé dans le titre")
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
