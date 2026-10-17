import { test } from "node:test"
import assert from "node:assert/strict"
import {
  DEFAULT_ZONES,
  MAX_PROMPT_VERBATIM,
  chunkConversation,
  distillHeuristic,
  extractEntities,
  renderConversation,
  type Conversation,
  type ConversationMessage,
} from "./index"

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
    assert.ok(longestCommon(prompt, `${i.title}\n${i.body}`) <= MAX_PROMPT_VERBATIM, `${i.kind} recopie la demande : ${i.body}`)
    assert.ok(longestCommon(answer, i.body) <= 200, `${i.kind} recopie la réponse : ${i.body}`)
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

// --- Deuxième passe de revue -------------------------------------------------------------------------------------------

test("outils (2e passe) : un mot en début de ligne, de titre ou de cellule n'est pas un outil", () => {
  const tools = (t: string) => extractEntities(t).filter((e) => e.type === "tool").map((e) => e.name)
  // [texte, outils attendus] — sonde verify-core/c5.ts
  const cases: [string, string[]][] = [
    ["# Rapport de trésorerie\n\n## Vue d'ensemble\nLa trésorerie est saine.", []],
    ["Voici le point demandé\n\nVue d'ensemble : 3 factures impayées", []],
    ["- Vue d'ensemble des ventes\n- Détail par client", []],
    ["| Vue | Montant |\n|---|---|", []],
    ["| Poste | Vue |\n|---|---|", []],
    ["**Vue d'ensemble** : tout va bien", []],
    ["1. Vue d'ensemble\n2. Détails", []],
    ["En bref, Vue d'ensemble du trimestre", []],
    ["Résumé\nNotion de marge brute : le chiffre d'affaires moins les achats", []],
    ["Plan\nLinear regression sur les ventes", []],
    ["Points clés\nSlack : une marge de 2 jours dans le planning", []],
    ["Contexte\nAlan, le nouveau boulanger, commence lundi; mutuelle à prévoir", []],
    ["Make sure the tests pass\nMake it work", []],
    // vraies mentions
    ["on migre de vue 2 à Vue 3", ["Vue"]],
    ["La doc est dans Notion et les tickets dans Linear", ["Linear", "Notion"]],
    ["Résumé\nLa procédure est dans Notion depuis hier", ["Notion"]],
    ["- on poste l'alerte dans Slack quand le build casse", ["Slack"]],
  ]
  const wrong = cases.map(([t, want]) => [t, tools(t), want] as const).filter(([, got, want]) => JSON.stringify(got) !== JSON.stringify(want))
  assert.deepEqual(wrong, [])
  // Bout en bout : une réponse compta avec un titre « ## Vue d'ensemble » ne tague plus ses items avec l'outil Vue.
  const items = distillHeuristic(
    conv([
      { role: "user", text: "Fais le point sur la trésorerie d'octobre" },
      { role: "assistant", text: "## Vue d'ensemble\nLa trésorerie est de 42 000 €. On garde la réserve de deux mois de charges.\nTODO: relancer les impayés" },
    ]),
    DEFAULT_ZONES,
  )
  assert.ok(items.length > 0 && items.every((i) => !i.entities.some((e) => e.name === "Vue")), JSON.stringify(items.map((i) => i.entities)))
})

test("décisions (2e passe) : libellés de calcul, retenues chiffrées et hypothèses ne sont pas des décisions", () => {
  const decisions = (answer: string) =>
    distillHeuristic(conv([{ role: "user", text: "Point paie d'octobre" }, { role: "assistant", text: answer }]), DEFAULT_ZONES)
      .filter((i) => i.kind === "decision")
      .map((i) => i.title)
  // [réponse, décisions attendues] — sonde verify-core/c6.ts
  const cases: [string, string[]][] = [
    ["Voici le calcul pour octobre :\n- Salaire brut : 2 500 €\n- Taux retenu : 7,5 %\n- Montant retenu : 187 €\nLa retenue s'élève donc à 187 €.", []],
    ["Le taux personnalisé retenu : 7,5 %. La retenue sera prélevée sur la paie.", []],
    ["Sur le salaire d'octobre, on retient 187 € au titre du prélèvement à la source.", []],
    ["Si on garde ce rythme d'heures sup, la paie de novembre sera plus haute.", []],
    ["Si on choisit le taux neutre, la retenue sera de 4 %.", []],
    ["Au cas où on opte pour le versement trimestriel, il faudra prévenir la banque.", []],
    // vraies décisions
    ["On a décidé de garder Stripe pour les paiements en ligne, même si on perd la proration.", ["On a décidé de garder Stripe pour les paiements en ligne, même si on perd la proration."]],
    ["Option retenue : expert-comptable externe.", ["Option retenue : expert-comptable externe."]],
    ["On retient la solution B pour la clôture.", ["On retient la solution B pour la clôture."]],
    ["Choix retenu : Qonto pour les virements.", ["Choix retenu : Qonto pour les virements."]],
  ]
  const wrong = cases.map(([a, want]) => [a, decisions(a), want] as const).filter(([, got, want]) => JSON.stringify(got) !== JSON.stringify(want))
  assert.deepEqual(wrong, [])
})

test("heuristique (2e passe) : aucun passage de plus de 80 caractères de la demande dans un champ envoyé, plus de « Contexte : »", () => {
  const prompt =
    "Le client Boulangerie Martin conteste la facture F-2026-118 de 1 240 € : il dit que la livraison du 3 octobre était incomplète " +
    "et menace de partir chez Maison Kayser si on ne fait pas un geste commercial. On a décidé de lui proposer un avoir de 15 % sur cette " +
    "facture et de garder ses livraisons du matin en priorité. TODO: appeler le gérant de la Boulangerie Martin avant vendredi pour s'excuser du retard."
  const answer =
    "Je te propose de répondre au client Boulangerie Martin en reconnaissant le problème de livraison du 3 octobre et en proposant un avoir " +
    "de 15 % sur la facture F-2026-118, soit 186 € à déduire du prochain règlement. Il faudra aussi vérifier avec l'équipe de livraison ce qui " +
    "s'est passé ce jour-là. On a décidé de garder le client Boulangerie Martin en priorité pour les tournées du matin.\n" +
    "TODO: envoyer l'avoir de 186 € au client Boulangerie Martin avant vendredi\n1. Créer l'avoir\n2. L'envoyer\n3. Prévenir la livraison"
  // La demande arrive aussi par le titre de session et par le rappel d'un segment de fin.
  const variants = [
    conv([{ role: "user", text: prompt }, { role: "assistant", text: answer }], { cwd: "/Users/hugo/fournil" }),
    conv([{ role: "user", text: prompt }, { role: "assistant", text: answer }], { title: prompt }),
    conv([{ role: "assistant", text: answer }], { ask: prompt }),
  ]
  for (const c of variants) {
    const items = distillHeuristic(c, DEFAULT_ZONES)
    assert.ok(items.some((i) => i.kind === "fact") && items.some((i) => i.kind === "decision") && items.some((i) => i.kind === "task"), JSON.stringify(items.map((i) => i.kind)))
    for (const i of items) {
      for (const [field, text] of [["title", i.title], ["body", i.body]] as const) {
        assert.ok(longestCommon(prompt, text) <= MAX_PROMPT_VERBATIM, `${i.kind}.${field} recopie ${longestCommon(prompt, text)} caractères de la demande : ${text}`)
        assert.ok(longestCommon(answer, text) <= 200, `${i.kind}.${field} recopie ${longestCommon(answer, text)} caractères de la réponse`)
      }
      assert.ok(!/Contexte :/.test(i.body), i.body)
    }
  }
  // Les items restent utiles : la décision et la tâche de l'employé sont là, en extrait court.
  const items = distillHeuristic(variants[0], DEFAULT_ZONES)
  assert.ok(items.some((i) => i.kind === "decision" && /avoir de 15 %/.test(i.title)), JSON.stringify(items.map((i) => i.title)))
  assert.ok(items.some((i) => i.kind === "task" && /Boulangerie Martin/.test(i.title)))
  assert.ok(items.every((i) => i.zone === "sales"), JSON.stringify(items.map((i) => i.zone)))
})

test("heuristique (2e passe) : une session santé dictée au milieu d'un mail n'est pas distillée", () => {
  const items = distillHeuristic(
    conv([
      { role: "user", text: "Rédige un mail à mon ostéopathe pour décaler la séance de jeudi : ma hernie discale me bloque." },
      { role: "assistant", text: "Voici un mail pour votre ostéopathe. On a décidé de proposer vendredi 9h comme nouveau créneau." },
    ]),
    DEFAULT_ZONES,
  )
  assert.deepEqual(items, [])
})

// --- Troisième passe de revue ------------------------------------------------------------------------------------------

test("outils (3e passe) : une puce ou un sujet de phrase est un outil sur indice ; un titre, un tiret ou un article, non", () => {
  const tools = (t: string) => extractEntities(t).filter((e) => e.type === "tool").map((e) => e.name)
  // [texte, outils attendus] — sondes r2-verify-core/ent.ts et ent2.ts
  const cases: [string, string[]][] = [
    // vraies mentions : liste d'outils, verbe après le nom, énumération, préposition + article
    ["Outils recommandés :\n- Notion pour la doc\n- Slack pour les alertes\n- Linear pour les tickets", ["Linear", "Notion", "Slack"]],
    ["Pour la doc :\n- Stripe pour les paiements\n- Notion pour la doc", ["Stripe", "Notion"]],
    ["Sentry est déployé en prod", ["Sentry"]],
    ["Notion est notre wiki interne.", ["Notion"]],
    ["On utilise Notion et Slack", ["Notion", "Slack"]],
    ["Poste le récap sur le Slack de l'équipe", ["Slack"]],
    ["Le fichier Excel est prêt", ["Excel"]],
    ["Stack :\n- Vue 3\n- Node 22", ["Vue", "Node"]],
    // titres, tirets, emoji, parenthèses, cellules, articles : des mots courants
    ["## 📊 Vue mensuelle", []],
    ["### 🔎 Vue par client\nMartin : 1 200 €", []],
    ["1️⃣ Vue globale", []],
    ["## 1 – Vue globale", []],
    ["Trésorerie – Vue globale", []],
    ["Tableau de bord — Vue mensuelle des ventes", []],
    ["Trésorerie (Vue mensuelle)", []],
    ["Rappel — Notion de seuil de rentabilité", []],
    ["**📌 Notion de marge** : CA - achats", []],
    ["<td>Notion</td>", []],
    ["La Notion de marge brute est essentielle", []],
    ["Il reste du Slack dans le planning", []],
    ["Planning — Slack de 2 jours", []],
    ["- Vue mensuelle\n- Notion de marge", []],
    ["Léo et Alan ont parlé de la mutuelle d'Alan", []],
  ]
  const wrong = cases.map(([t, want]) => [t, tools(t), want] as const).filter(([, got, want]) => JSON.stringify(got) !== JSON.stringify(want))
  assert.deepEqual(wrong, [])
  // Bout en bout : des titres « ## Trésorerie — Vue mensuelle » ne taguent plus les items avec l'outil Vue.
  const items = distillHeuristic(
    conv([
      { role: "user", text: "Fais le point sur la trésorerie d'octobre et les factures impayées." },
      {
        role: "assistant",
        text: "## Trésorerie — Vue mensuelle\n\nLa trésorerie est de 42 000 €. On a décidé de relancer les factures impayées à J+15.\n\n## Factures — Vue par client\n\n| Client | Montant |\n|---|---|\n| Martin | 1 200 € |",
      },
    ]),
    DEFAULT_ZONES,
  )
  assert.ok(items.length > 0 && items.every((i) => !i.entities.some((e) => e.type === "tool")), JSON.stringify(items.map((i) => i.entities)))
})

test("décisions (3e passe) : « on retient … sur le salaire » est une retenue, « on retient Stripe Billing » une décision", () => {
  const decisions = (answer: string) =>
    distillHeuristic(conv([{ role: "user", text: "Calcule la paie d'octobre de Léo." }, { role: "assistant", text: `Voici le calcul.\n${answer}\nVoilà.` }]), DEFAULT_ZONES)
      .filter((i) => i.kind === "decision")
      .map((i) => i.title)
  // sonde r2-verify-core/dec.ts
  const none = [
    "On retient donc 187 € sur le salaire de Léo.",
    "On retient le prélèvement à la source chaque mois sur le salaire.",
    "Nous retenons la retenue à la source de 7,5 %.",
    "On retient la TVA à 20 % sur la facture.",
    "On retient environ 187 € par mois sur le salaire.",
    "On a retenu 187 € sur la paie d'octobre.",
    "Quand on garde trop de stock, la marge baisse.",
    "Lorsqu'on choisit le taux neutre, l'employeur ne connaît pas les revenus.",
    "Imaginons qu'on garde Stripe : les frais restent à 1,4 %.",
    "On garde un œil sur la trésorerie.",
    "On garde à l'esprit que la TVA baisse en 2027.",
  ]
  const real = [
    "On retient Stripe Billing pour les abonnements.",
    "On part sur Supabase pour la base de données.",
    "On retient la solution B pour la clôture.",
    "Nous avons retenu Qonto pour les virements.",
    "On a décidé de garder Stripe pour les paiements en ligne.",
  ]
  assert.deepEqual(none.filter((s) => decisions(s).length > 0), [])
  assert.deepEqual(real.filter((s) => decisions(s).length !== 1), [])
})

test("heuristique (3e passe) : capture d'écran (OCR) — aucun champ ne recopie plus de 80 caractères du texte capturé", () => {
  // Screenpipe : la demande tapée par l'employé est dans le texte OCR, donc côté « assistant » (sonde r2-verify-core/ocr.ts).
  const prompt =
    "Le client Boulangerie Martin conteste la facture F-2026-118 de 1 240 € car la livraison du 3 octobre est arrivée avec deux " +
    "heures de retard et il menace de passer chez un concurrent. Aide-moi à lui répondre."
  const ocr =
    `Nouvelle conversation\n${prompt}\n` +
    "Je te propose de répondre au client en reconnaissant le retard de livraison du 3 octobre, puis de lui proposer un geste commercial clair et chiffré pour le garder.\n" +
    "On a décidé de proposer un avoir de 15 % sur la facture F-2026-118 au client Boulangerie Martin, à déduire du prochain règlement.\n" +
    "TODO: envoyer l'avoir au client Boulangerie Martin avant vendredi et prévenir l'équipe de livraison du matin\n" +
    "1. Créer l'avoir de 15 % dans Pennylane pour la facture F-2026-118 du client Boulangerie Martin\n2. L'envoyer\n3. Prévenir la livraison"
  const base = { started_at: "2026-10-16T09:00:00Z", ended_at: "2026-10-16T09:05:00Z" }
  const variants: Conversation[] = [
    {
      ...base, id: "screenpipe:1", tool: "claude", app: "Google Chrome", title: "Litige facture Boulangerie Martin - Claude", screenpipe_ref: "1",
      messages: [{ role: "user", text: "Session capturée à l'écran : Google Chrome — Litige facture Boulangerie Martin - Claude" }, { role: "assistant", text: ocr }],
    },
    // Messages structurés d'un assistant web (ChatGPT) : même règle.
    { ...base, id: "web", tool: "chatgpt", app: "Arc", messages: [{ role: "user", text: prompt }, { role: "assistant", text: ocr }] },
  ]
  for (const c of variants) {
    const items = distillHeuristic(c, DEFAULT_ZONES)
    assert.ok(items.some((i) => i.kind === "decision") && items.some((i) => i.kind === "task"), JSON.stringify(items.map((i) => i.kind)))
    for (const i of items) {
      for (const [field, text] of [["title", i.title], ["body", i.body]] as const) {
        const n = longestCommon(ocr.replace(/\s+/g, " "), text.replace(/\s+/g, " "))
        assert.ok(n <= MAX_PROMPT_VERBATIM, `${c.id} ${i.kind}.${field} recopie ${n} caractères du texte capturé : ${text}`)
      }
    }
  }
  // Les journaux Claude Code gardent des extraits de réponse plus longs (200 caractères) : l'assistant n'y recopie pas la demande.
  const cc = distillHeuristic(conv([{ role: "user", text: "Point litige Martin" }, { role: "assistant", text: ocr.split("\n").slice(2).join("\n") }]), DEFAULT_ZONES)
  assert.ok(cc.some((i) => i.kind === "decision" && i.body.length > MAX_PROMPT_VERBATIM + 20), JSON.stringify(cc.map((i) => i.body)))
})
