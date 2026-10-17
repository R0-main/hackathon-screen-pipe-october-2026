import { test } from "node:test"
import assert from "node:assert/strict"
import {
  DISTILL_MARKER,
  STATUS_SYSTEM,
  StatusPayloadSchema,
  buildCliStatusPrompt,
  buildStatusInput,
  buildStatusPrompt,
  heuristicStatus,
  parseStatusJson,
  type KnowledgeItem,
  type StatusInput,
  type Task,
} from "./index"

const INPUT: StatusInput = {
  company_name: "Fournil",
  generated_for: "2026-10-16",
  zones: [
    { id: "dev", name: "Dev", description: "Code et déploiements" },
    { id: "compta", name: "Compta", description: "Factures et paie" },
  ],
  items: [
    { zone: "dev", kind: "decision", title: "On part sur Stripe Billing", body: "Proration native.", author: "Hugo", created_at: "2026-10-15T09:00:00Z" },
    { zone: "compta", kind: "fact", title: "TVA de septembre : 18 240 €", body: "Déclaration CA3 prête.", author: "Jean-Marc", created_at: "2026-10-14T09:00:00Z" },
  ],
  tasks: [
    { zone: "dev", title: "Migrer le webhook", status: "open", assignee: "Inès" },
    { zone: "compta", title: "Relancer Maison Kayser", status: "done" },
  ],
}

test("statut : le prompt CLI commence par le marqueur, porte la consigne et ne demande que du JSON", () => {
  const p = buildCliStatusPrompt(INPUT)
  assert.ok(p.startsWith(DISTILL_MARKER), "brain-sync ne doit jamais ingérer cette session")
  assert.ok(p.includes(STATUS_SYSTEM))
  assert.match(p, /Réponds UNIQUEMENT avec un objet JSON/)
  assert.match(p, /\{"headline":"…","zones":\[\{"zone":"<id>","summary":"…","objectives":\["…"\],"progress":"…","next_steps":\["…"\],"who_did_what":\[\{"person":"…","did":"…"\}\]\}\]\}/)
  assert.match(p, /identifiant exact \(dev, compta\)/)
  assert.match(p, /Entreprise : Fournil\nDate : 2026-10-16/)
})

test("statut : chaque section de zone ne contient que SES connaissances et SES tâches ; la consigne l'impose", () => {
  const p = buildStatusPrompt(INPUT)
  const dev = p.slice(p.indexOf("## Zone dev"), p.indexOf("## Zone compta"))
  const compta = p.slice(p.indexOf("## Zone compta"))
  assert.ok(dev.includes("Stripe Billing") && dev.includes("Migrer le webhook (Inès)") && dev.includes("par Hugo, 2026-10-15"))
  assert.ok(!dev.includes("TVA") && !dev.includes("Kayser"))
  assert.ok(compta.includes("TVA de septembre") && compta.includes("[fait] Relancer Maison Kayser"))
  assert.ok(!compta.includes("Stripe") && !compta.includes("webhook"))
  assert.match(STATUS_SYSTEM, /UNIQUEMENT sur les connaissances et les tâches listées sous cette zone/)
  assert.match(STATUS_SYSTEM, /headline[^\n]*résumer l'ensemble des zones/)
  assert.match(STATUS_SYSTEM, /genre/)
})

test("statut : buildStatusInput garde 30 jours, 400 connaissances au plus, les plus récentes d'abord, avec les noms", () => {
  const now = new Date("2026-10-16T12:00:00Z")
  const mk = (i: number, daysAgo: number, zone = "dev"): KnowledgeItem => ({
    id: `k${i}`, org_id: "o", author_id: i % 2 ? "u1" : "u2", zone, kind: "fact", title: `Item ${i}`, body: "x".repeat(2000), entities: [],
    source: { app: "t", tool: "claude-code", at: "" }, confidence: 0.6, created_at: new Date(now.getTime() - daysAgo * 86400_000 - i * 1000).toISOString(),
  })
  const items = [...Array.from({ length: 450 }, (_, i) => mk(i, 1)), mk(999, 40), mk(1000, 2, "inconnue")]
  const tasks: Task[] = [{ id: "t", title: "Faire", zone: "dev", assignee_id: "u2", status: "open", created_at: "", updated_at: "" }]
  const input = buildStatusInput({
    companyName: "Fournil", now, items, tasks,
    zones: [{ id: "dev", name: "Dev", description: "" }],
    profiles: [{ id: "u1", name: "Hugo" }, { id: "u2", name: "Inès" }],
  })
  assert.equal(input.generated_for, "2026-10-16")
  assert.equal(input.items.length, 400)
  assert.ok(input.items.every((i, n) => n === 0 || input.items[n - 1].created_at >= i.created_at), "les plus récentes d'abord")
  assert.ok(!input.items.some((i) => i.title === "Item 999" || i.zone === "inconnue"))
  assert.deepEqual([input.items[0].author, input.items[1].author], ["Inès", "Hugo"])
  assert.ok(input.items[0].body.length <= 1200)
  assert.deepEqual(input.tasks, [{ zone: "dev", title: "Faire", status: "open", assignee: "Inès" }])
})

const GOOD = {
  headline: "Semaine chargée : Stripe en cours, TVA prête.",
  zones: [
    { zone: "dev", summary: "Migration Stripe.", objectives: ["Billing en prod"], progress: "1/2", next_steps: ["Webhook"], who_did_what: [{ person: "Hugo", did: "a choisi Stripe" }] },
    { zone: "compta", summary: "TVA prête.", objectives: [], progress: "ok", next_steps: [], who_did_what: [] },
  ],
}

test("statut : parseStatusJson lit le JSON brut, entouré de texte, en bloc de code ou dans l'enveloppe de la CLI", () => {
  const ids = ["dev", "compta"]
  const raw = JSON.stringify(GOOD)
  const variants: [string, string][] = [
    ["brut", raw],
    ["bloc de code", "```json\n" + raw + "\n```"],
    ["texte autour", `Voici le résumé demandé :\n${raw}\nBonne lecture !`],
    ["texte avec accolades avant", `Note {brouillon} : ${raw}`],
    ["enveloppe CLI", JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "```json\n" + raw + "\n```", session_id: "x" })],
    ["virgule finale", raw.replace(/\]\}$/, ",]}")],
  ]
  for (const [name, text] of variants) {
    const r = parseStatusJson(text, ids)
    assert.ok(r, name)
    assert.equal(r.headline, GOOD.headline, name)
    assert.deepEqual(r.zones.map((z) => z.zone), ["dev", "compta"], name)
    assert.ok(StatusPayloadSchema.safeParse({ status: r }).success, `${name} : conforme au schéma de POST /api/status`)
  }
})

test("statut : parseStatusJson écarte les zones inconnues ou en double, complète les champs manquants, null si inutilisable", () => {
  const partial = {
    headline: "  Une   semaine calme.  ",
    zones: [
      { zone: "Dev", summary: 12, objectives: ["Livrer", 3, null, { x: 1 }], who_did_what: [{ person: "Hugo", did: "a livré" }, { person: "", did: "rien" }, "Inès"] },
      { zone: "dev", summary: "doublon" },
      { zone: "marketing", summary: "zone inconnue" },
      { summary: "sans identifiant" },
      "pas un objet",
    ],
  }
  const r = parseStatusJson(JSON.stringify(partial), ["dev", "compta"])
  assert.deepEqual(r, {
    headline: "Une semaine calme.",
    zones: [{ zone: "dev", summary: "", objectives: ["Livrer", "3"], progress: "", next_steps: [], who_did_what: [{ person: "Hugo", did: "a livré" }] }],
  })
  // Inutilisable : rien, du texte, JSON tronqué, pas de headline, enveloppe en erreur.
  const unusable = [
    "",
    "Je ne peux pas répondre à cette demande.",
    JSON.stringify(GOOD).slice(0, 60),
    JSON.stringify({ zones: GOOD.zones }),
    JSON.stringify({ headline: "   ", zones: GOOD.zones }),
    JSON.stringify({ type: "result", is_error: true, result: "Credit balance is too low" }),
    JSON.stringify({ type: "result", is_error: false, result: "Désolé, je n'ai pas de données." }),
  ]
  for (const t of unusable) assert.equal(parseStatusJson(t, ["dev"]), null, t)
  // Longueurs bornées.
  const long = parseStatusJson(JSON.stringify({ headline: "h".repeat(5000), zones: [{ zone: "dev", summary: "s".repeat(5000), next_steps: Array(30).fill("x") }] }), ["dev"])
  assert.ok(long && long.headline.length <= 600 && long.zones[0].summary.length <= 1500 && long.zones[0].next_steps.length <= 10)
})

// --- Troisième passe de revue ------------------------------------------------------------------------------------------

test("statut (3e passe) : un auteur sans profil est « Personne inconnue », sans présumer du genre", () => {
  const now = new Date("2026-10-16T12:00:00Z")
  const item: KnowledgeItem = {
    id: "k", org_id: "o", author_id: "supprime", zone: "dev", kind: "decision", title: "On part sur Stripe Billing", body: "Proration.",
    entities: [], source: { app: "t", tool: "claude-code", at: "" }, confidence: 0.6, created_at: "2026-10-15T09:00:00Z",
  }
  const input = buildStatusInput({ companyName: "Fournil", now, items: [item], tasks: [], zones: [{ id: "dev", name: "Dev", description: "" }], profiles: [] })
  assert.equal(input.items[0].author, "Personne inconnue")
  assert.match(buildStatusPrompt(input), /par Personne inconnue, 2026-10-15/)
  const status = heuristicStatus({
    zones: [{ id: "dev", name: "Dev", description: "", color: "#fff", keywords: [], position: 0 }],
    items: [item], tasks: [], profiles: [], now,
  })
  assert.equal(status.zones[0].who_did_what[0].person, "Personne inconnue")
  assert.ok(!JSON.stringify({ input, status }).includes("Inconnu"), "jamais le masculin « Inconnu »")
})
