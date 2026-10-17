import { test } from "node:test"
import assert from "node:assert/strict"
import {
  DEFAULT_ZONES,
  classifyZones,
  detectAutomations,
  distillHeuristic,
  heuristicStatus,
  isAllowedApp,
  promptFingerprint,
  redact,
  type AgentEvent,
  type Conversation,
} from "./index"

test("redact masque secrets et données perso, sans toucher au reste", () => {
  const input = [
    // faux jetons assemblés à l'exécution (protection anti-secrets de GitHub)
    ["clé sk-", "ant-api03-AbCdEfGhIjKlMnOpQrStUv et ghp", "_abcdefghijklmnopqrstuvwxyz0123"].join(""),
    "écris à jean.dupont@exemple.fr ou au 06 12 34 56 78",
    "DATABASE_PASSWORD=hunter2hunter2",
    "postgres://admin:s3cret@db.example.com:5432/app",
    "IBAN FR76 3000 6000 0112 3456 7890 189",
    "carte 4111 1111 1111 1111, timestamp 1697456789123",
    "on part sur Stripe Billing",
  ].join("\n")
  const { text, redactions } = redact(input)
  for (const leaked of ["sk-ant-api03", "ghp_", "jean.dupont@", "06 12 34", "hunter2", "s3cret", "FR76 3000", "4111 1111"]) {
    assert.ok(!text.includes(leaked), `fuite : ${leaked}`)
  }
  assert.ok(text.includes("1697456789123"), "un timestamp n'est pas un numéro de carte (Luhn)")
  assert.ok(text.includes("on part sur Stripe Billing"))
  assert.ok(Object.keys(redactions).length >= 7)
})

test("liste blanche d'apps : sessions IA oui, perso non", () => {
  assert.ok(isAllowedApp("Terminal", "claude — ~/code/fournil"))
  assert.ok(isAllowedApp("Google Chrome", "Claude — Nouvelle conversation"))
  assert.ok(!isAllowedApp("Google Chrome", "Boursorama — Mes comptes"))
  assert.ok(!isAllowedApp("WhatsApp", "Maman"))
  assert.ok(!isAllowedApp("Spotify", ""))
})

test("classification par zone (sans accents, préfixes)", () => {
  assert.deepEqual(classifyZones("Prépare la déclaration de TVA à partir de Pennylane", DEFAULT_ZONES, 1), ["compta"])
  assert.deepEqual(classifyZones("comment déployer en production ?", DEFAULT_ZONES, 1), ["dev"])
  assert.deepEqual(classifyZones("relancer le prospect après la démo", DEFAULT_ZONES, 1), ["sales"])
  assert.deepEqual(classifyZones("bonjour", DEFAULT_ZONES), [])
})

test("empreinte de prompt stable malgré dates et nombres", () => {
  assert.equal(
    promptFingerprint("Rapproche les relevés Qonto d'hier avec les factures"),
    promptFingerprint("rapproche les releves qonto d'hier avec les factures"),
  )
  assert.equal(promptFingerprint("Rapport du 12/10 : 3 écarts"), promptFingerprint("Rapport du 13/10 : 5 écarts"))
})

test("détection d'automatisation : même prompt, même créneau, ≥ 3 jours", () => {
  const fp = promptFingerprint("rapprochement bancaire")
  const base = Date.parse("2026-10-12T07:05:00Z") // 9h05 à Paris
  const ev = (day: number, minutes: number, id: number): AgentEvent => ({
    id, org_id: "o", user_id: "jm", agent: "claude-code", type: "query", zones: ["compta"],
    summary: "Rapprochement bancaire", fingerprint: fp, at: new Date(base + day * 86400_000 + minutes * 60_000).toISOString(),
  })
  const regular = [ev(0, 0, 1), ev(1, 3, 2), ev(2, -2, 3), ev(3, 4, 4)]
  const found = detectAutomations(regular, [{ id: "jm", name: "Jean-Marc" }], { now: new Date(base + 4 * 86400_000) })
  assert.equal(found.length, 1)
  assert.equal(found[0].zone, "compta")
  assert.match(found[0].description, /Jean-Marc/)
  const scattered = [ev(0, 0, 1), ev(1, 300, 2), ev(2, -120, 3), ev(3, 420, 4)]
  assert.equal(detectAutomations(scattered, [], { now: new Date(base + 4 * 86400_000) }).length, 0)
})

test("distillation heuristique : décision, tâche, procédure", () => {
  const conv: Conversation = {
    id: "s1", tool: "claude-code", app: "Terminal", cwd: "/home/hugo/fournil", started_at: "2026-10-16T08:00:00Z", ended_at: "2026-10-16T08:30:00Z",
    messages: [
      { role: "user", text: "Comment on gère les abonnements annuels avec Stripe ? Et on garde combien de temps les anciens prix ?" },
      {
        role: "assistant",
        text: "On part sur Stripe Billing pour gérer la proration.\nÉtapes :\n1. Créer les prix annuels\n2. Migrer les clients\n3. Activer le portail client\nTODO: prévenir la compta du changement",
      },
    ],
  }
  const items = distillHeuristic(conv, DEFAULT_ZONES)
  const kinds = items.map((i) => i.kind)
  assert.ok(kinds.includes("decision"), JSON.stringify(items, null, 1))
  assert.ok(items.filter((i) => i.kind === "decision").every((i) => !i.title.includes("?")), "une question n'est pas une décision")
  assert.ok(kinds.includes("task"))
  assert.ok(kinds.includes("procedure"))
  assert.ok(items.every((i) => i.entities.some((e) => e.name === "Stripe")))
  assert.ok(items.some((i) => i.entities.some((e) => e.type === "project" && e.name === "fournil")))
})

test("résumé d'état heuristique", () => {
  const status = heuristicStatus({ zones: DEFAULT_ZONES, items: [], tasks: [], profiles: [] })
  assert.equal(status.zones.length, DEFAULT_ZONES.length)
  assert.equal(status.generator, "heuristic")
})
