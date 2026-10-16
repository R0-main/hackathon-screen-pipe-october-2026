import { test } from "node:test"
import assert from "node:assert/strict"
import { DEFAULT_ZONES, chunkConversation, distillHeuristic, extractEntities, renderConversation, type Conversation, type ConversationMessage } from "./index"

const conv = (messages: ConversationMessage[], extra: Partial<Conversation> = {}): Conversation => ({
  id: "s",
  tool: "claude-code",
  app: "Terminal",
  started_at: "2026-10-16T08:00:00Z",
  ended_at: "2026-10-16T08:30:00Z",
  messages,
  ...extra,
})

/** Plus longue sous-chaîne commune (en caractères) : sert à vérifier qu'aucun texte brut long n'est recopié. */
function longestCommon(a: string, b: string): number {
  let best = 0
  const prev = new Array(b.length + 1).fill(0)
  for (let i = 1; i <= a.length; i++) {
    let diag = 0
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]
      prev[j] = a[i - 1] === b[j - 1] ? diag + 1 : 0
      if (prev[j] > best) best = prev[j]
      diag = tmp
    }
  }
  return best
}

test("heuristique : pas de demande brute ni de longues phrases recopiées, extraits courts et re-masqués", () => {
  const prompt =
    "Je dois migrer la facturation de Fournil vers Stripe Billing avant la fin du mois. Les abonnements annuels des boulangeries " +
    "partenaires doivent garder leur prix actuel jusqu'au renouvellement, et les mensuels basculent tout de suite. Le client " +
    "Maison Kayser a un contrat spécifique avec une remise de 15 % qu'il faut conserver, et on doit prévenir la compta du changement."
  const answer =
    "On part sur Stripe Billing avec des prix annuels distincts pour chaque boulangerie partenaire, parce que la proration native évite de recalculer à la main les remises négociées au cas par cas. " +
    "La remise de Maison Kayser reste un coupon permanent. La clé de test est sk_test_abcdefghij1234567890 dans le .env.\n" +
    "1. Créer les prix annuels\n2. Migrer les clients actifs\n3. Activer le portail client\nTODO: prévenir la compta du changement de facturation"
  const items = distillHeuristic(conv([{ role: "user", text: prompt }, { role: "assistant", text: answer }], { cwd: "/home/hugo/fournil" }), DEFAULT_ZONES)
  assert.ok(items.length >= 3, JSON.stringify(items, null, 1))
  for (const i of items) {
    assert.ok(!i.body.includes("Demande :"), "la demande brute n'est plus recopiée")
    assert.ok(i.title.length <= 140, i.title)
    assert.ok(i.body.length <= 400, `${i.kind} : ${i.body.length} caractères`)
    assert.ok(longestCommon(prompt, `${i.title}\n${i.body}`) <= 120, `${i.kind} recopie la demande : ${i.body}`)
    assert.ok(longestCommon(answer, i.body) <= 240, `${i.kind} recopie la réponse : ${i.body}`)
    assert.ok(!`${i.title} ${i.body}`.includes("sk_test_"), "les extraits sont re-masqués")
  }
  const fact = items.find((i) => i.kind === "fact")
  assert.ok(fact && /^Ce qui en est ressorti \(claude-code, projet fournil\) : /.test(fact.body), fact?.body)
  const procedure = items.find((i) => i.kind === "procedure")
  assert.ok(procedure && procedure.body.split("\n").length <= 8)
})

test("heuristique : rien pour une session personnelle, et les phrases perso d'une session de travail sont ignorées", () => {
  const perso = conv([
    { role: "user", text: "Aide-moi à écrire un mail à mon médecin traitant : je suis en arrêt pour burn-out depuis lundi." },
    { role: "assistant", text: "Voici une proposition de mail pour votre médecin traitant concernant votre arrêt maladie. On garde un ton sobre." },
  ])
  assert.deepEqual(distillHeuristic(perso, DEFAULT_ZONES), [])
  // Un sujet perso glissé dans une session de travail ne doit jamais ressortir dans un item.
  const mixed = conv([
    { role: "user", text: "Corrige le bug du webhook Stripe en production." },
    {
      role: "assistant",
      text: "On garde la vérification de signature sur le endpoint du webhook.\nOn garde aussi la séance chez Netflix pour ce soir.\nTODO: ajouter un test sur le webhook",
    },
  ])
  const items = distillHeuristic(mixed, DEFAULT_ZONES)
  assert.ok(items.some((i) => i.kind === "decision"))
  assert.ok(items.every((i) => !/netflix/i.test(`${i.title} ${i.body}`)), JSON.stringify(items, null, 1))
})

test("heuristique : la zone de la conversation sert de contexte, une égalité ne bascule jamais vers Dev", () => {
  const compta = conv([
    { role: "user", text: "Prépare la déclaration de TVA de septembre à partir de Pennylane et des relevés Qonto" },
    {
      role: "assistant",
      text:
        "La TVA collectée de septembre s'élève à 18 240 €, la déclaration CA3 est prête dans Pennylane.\n" +
        "On a décidé de relancer par email à J+15.\n" +
        "TODO: corriger l'erreur sur la facture Boulangerie Martin\n" +
        "TODO: relancer Maison Kayser pour les 2 virements de ce mois-ci\n" +
        "TODO: corriger le bug de l'endpoint API d'export Pennylane en production",
    },
  ])
  const items = distillHeuristic(compta, DEFAULT_ZONES)
  const zoneOf = (needle: string) => items.find((i) => i.title.includes(needle))?.zone
  assert.equal(zoneOf("Boulangerie Martin"), "compta", "dev 1 / compta 1 : égalité → zone de la conversation")
  assert.equal(zoneOf("Maison Kayser"), "compta", "« ce mois-ci » n'est pas le sigle CI")
  assert.equal(zoneOf("relancer par email"), "compta")
  assert.equal(zoneOf("endpoint API"), "dev", "un indice net (bug, endpoint, api, production) déplace l'item")
  assert.ok(items.filter((i) => i.kind === "fact").every((i) => i.zone === "compta"))
})

test("décisions : ni « retenue à la source », ni une décision encore à prendre", () => {
  const paie = conv([
    { role: "user", text: "Calcule la retenue à la source sur le salaire d'octobre de Léo." },
    {
      role: "assistant",
      text:
        "Le taux de prélèvement retenu par l'administration est de 7,5 %. La retenue à la source s'élève donc à 187 €. " +
        "Il faudra une décision de Claire sur la prime avant la paie. Solution retenue : versement en deux fois.",
    },
  ])
  const items = distillHeuristic(paie, DEFAULT_ZONES)
  const decisions = items.filter((i) => i.kind === "decision")
  assert.deepEqual(decisions.map((i) => i.title), ["Solution retenue : versement en deux fois."], JSON.stringify(items, null, 1))
  assert.ok(items.some((i) => i.kind === "question" && i.title.startsWith("Il faudra une décision de Claire")))
})

test("découpage : une longue session agentique garde ses décisions et tâches finales (segments sans message utilisateur)", () => {
  const filler = "J'ai lu le fichier src/payments/webhook.ts et vérifié la gestion des erreurs du endpoint, la signature est contrôlée correctement. ".repeat(12)
  const longAnswer =
    Array.from({ length: 25 }, (_, i) => `Étape ${i} : ${filler}`).join("\n\n") +
    "\n\nTerminé. On part sur la version 2026-09 de l'API Stripe pour tous les webhooks.\nTODO: mettre à jour la clé de signature en production\nTODO: prévenir le support du changement"
  const c = conv([{ role: "user", text: "Migre le webhook Stripe vers la nouvelle API et corrige les tests" }, { role: "assistant", text: longAnswer }], { id: "long" })
  const chunks = chunkConversation(c)
  assert.ok(chunks.length >= 2)
  assert.equal(chunks.map((ch) => ch.messages.map((m) => m.text).join("")).join("").replace(/\s/g, "").length, (c.messages[0].text + longAnswer).replace(/\s/g, "").length, "rien n'est tronqué")
  assert.ok(chunks.every((ch) => ch.messages.every((m) => m.text.length <= 24000)))
  assert.equal(chunks[0].ask, undefined, "le premier segment contient déjà la demande")
  assert.ok(chunks.slice(1).every((ch) => ch.ask === "Migre le webhook Stripe vers la nouvelle API et corrige les tests"))
  assert.match(renderConversation(chunks[1]), /Demande initiale \(rappel, hors de ce segment\) : Migre le webhook/)
  const items = chunks.flatMap((ch) => distillHeuristic(ch, DEFAULT_ZONES))
  assert.ok(items.some((i) => i.kind === "decision" && i.title.includes("version 2026-09")), JSON.stringify(items.map((i) => i.title)))
  assert.equal(items.filter((i) => i.kind === "task").length, 2)
  // Synchro incrémentale : seulement la fin de la réponse, sans nouveau prompt.
  const tail = distillHeuristic(conv([{ role: "assistant", text: longAnswer.slice(-600) }], { id: "inc" }), DEFAULT_ZONES)
  assert.deepEqual(tail.map((i) => i.kind).sort(), ["decision", "task", "task"])
  // Une conversation courte n'est pas découpée et garde son identifiant.
  const short = chunkConversation(conv([{ role: "user", text: "Salut" }, { role: "assistant", text: "Bonjour" }], { id: "court" }))
  assert.deepEqual(short.map((ch) => [ch.id, ch.ask]), [["court", undefined]])
})

test("outils : les mots courants ne deviennent pas des outils", () => {
  const tools = (t: string) => extractEntities(t).filter((e) => e.type === "tool").map((e) => e.name)
  assert.deepEqual(tools("Fais-moi une vue d'ensemble de la trésorerie du mois"), [])
  assert.deepEqual(tools("Vue d'ensemble de la trésorerie"), [])
  assert.deepEqual(tools("De mon point de vue, on garde le prix actuel"), [])
  assert.deepEqual(tools("Je n'ai aucune notion de la TVA intracommunautaire"), [])
  assert.deepEqual(tools("make sure the build passes. Make sure it is green"), [])
  assert.deepEqual(tools("Envoie le récap à Alan avant midi"), [])
  assert.deepEqual(tools("On documente la procédure dans Notion et on suit les tickets dans Linear"), ["Linear", "Notion"])
  assert.deepEqual(tools("Le front passe en vue.js 3 et le back sur Node 22"), ["Vue", "Node"])
  assert.deepEqual(tools("On a migré la base postgres et le webhook stripe"), ["Stripe", "Postgres"])
  assert.deepEqual(tools("La mutuelle passe chez Alan au 1er janvier"), ["Alan"])
  assert.deepEqual(tools("Le scénario Make relance les factures"), ["Make"])
})
