import { test } from "node:test"
import assert from "node:assert/strict"
import { DEFAULT_ZONES, classifyZones, detectAutomations, planSchedule, promptFingerprint, scoreZones, slugify, tokenize, type AgentEvent } from "./index"
import { normalizeOnboardingZones, synthesizeOnboarding } from "./claude"

test("zones : la particule « -ci » n'est pas le sigle CI", () => {
  assert.deepEqual(tokenize("ce mois-ci, ci-joint, ci-dessous"), ["mois", "joint", "dessous"])
  assert.ok(tokenize("la CI est cassée").includes("ci"), "le sigle seul reste un mot (recherche)")
  assert.deepEqual(classifyZones("Quel est le montant des factures impayées ce mois-ci ?", DEFAULT_ZONES, 2), ["compta"])
  assert.deepEqual(classifyZones("Envoie la facture ci-jointe au client", DEFAULT_ZONES, 2).includes("dev"), false)
  // Zones déjà stockées avec l'ancien mot-clé « ci » : la particule ne compte toujours pas.
  const stored = [
    { id: "dev", name: "Dev", keywords: ["ci", "code"] },
    { id: "compta", name: "Compta", keywords: ["facture", "factures"] },
  ]
  assert.deepEqual(classifyZones("Les factures impayées de ce mois-ci", stored, 2), ["compta"])
})

test("zones : départage explicite des égalités", () => {
  const text = "corriger l'erreur sur la facture"
  assert.deepEqual(scoreZones(text, DEFAULT_ZONES).map((s) => s.score), [1, 1])
  assert.equal(classifyZones(text, DEFAULT_ZONES, 1, { prefer: ["compta"] })[0], "compta")
  assert.equal(classifyZones(text, DEFAULT_ZONES, 1, { prefer: [undefined, "dev"] })[0], "dev")
  assert.equal(slugify("Service_client"), "service-client")
  assert.equal(slugify("a".repeat(31) + " b"), "a".repeat(31), "pas de tiret final après coupe")
})

test("automatisation : le créneau proposé suit le rythme réel (hebdo, deux fois par semaine, quotidien)", () => {
  let id = 0
  const mk = (iso: string, text = "Fais le point hebdo des ventes"): AgentEvent => ({
    id: ++id, org_id: "o", user_id: "u1", agent: "claude-code", type: "query", zones: ["sales"], summary: text,
    fingerprint: promptFingerprint(text), at: new Date(iso).toISOString(),
  })
  const people = [{ id: "u1", name: "Sarah" }]
  // Une fois par semaine, mais pas toujours le même jour (lun 5, mar 13, mer 21 octobre).
  const sparse = detectAutomations(["2026-10-05T07:00:00Z", "2026-10-13T07:02:00Z", "2026-10-21T07:01:00Z"].map((s) => mk(s)), people, { now: new Date("2026-10-21T12:00:00Z") })
  assert.equal(sparse.length, 1)
  assert.equal(sparse[0].schedule, "Chaque lundi à 08h56")
  assert.match(sparse[0].description, /environ une fois par semaine/)
  assert.doesNotMatch(sparse[0].description, /presque chaque jour|lundi au vendredi/)
  assert.equal(sparse[0].minutes_saved_per_week, 12)
  // Toujours le même jour.
  const weekly = detectAutomations(["2026-10-05T07:00:00Z", "2026-10-12T07:02:00Z", "2026-10-19T07:01:00Z"].map((s) => mk(s)), people, { now: new Date("2026-10-19T12:00:00Z") })
  assert.equal(weekly[0].schedule, "Chaque lundi à 08h56")
  assert.match(weekly[0].description, /chaque lundi/)
  // Lundi et jeudi pendant deux semaines.
  const twice = ["2026-10-05T07:00:00Z", "2026-10-08T07:01:00Z", "2026-10-12T07:00:00Z", "2026-10-15T07:02:00Z"].map((s) => mk(s))
  const t = detectAutomations(twice, people, { now: new Date("2026-10-16T12:00:00Z") })
  assert.equal(t[0].schedule, "Chaque lundi et jeudi à 08h56")
  assert.match(t[0].description, /environ 2 fois par semaine/)
  assert.equal(t[0].minutes_saved_per_week, 24)
  // Tous les jours ouvrés.
  const daily = ["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16"].map((d) => mk(`${d}T07:00:00Z`))
  const d = detectAutomations(daily, people, { now: new Date("2026-10-16T12:00:00Z") })
  assert.equal(d[0].schedule, "Du lundi au vendredi à 08h55")
  assert.match(d[0].description, /presque chaque jour/)
  assert.equal(d[0].minutes_saved_per_week, 60)
  assert.equal(planSchedule([{ weekday: 1, e: { at: "2026-10-05T07:00:00Z" } }, { weekday: 3, e: { at: "2026-10-28T07:00:00Z" } }], "09h00").runsPerWeek, 1)
})

test("onboarding : les items suivent le renommage des identifiants de zone", async () => {
  const fake = {
    beta: {
      messages: {
        parse: async () => ({
          stop_reason: "end_turn",
          parsed_output: {
            company_name: "Fournil",
            description: "Boulangeries",
            zones: [
              { id: "direction", name: "Direction", description: "", keywords: ["strategie"] },
              { id: "service_client", name: "Service client", description: "", keywords: ["sav", "ticket"] },
              { id: "RH_Recrutement", name: "RH", description: "", keywords: ["recrutement"] },
            ],
            items: [
              { zone: "service_client", kind: "procedure", title: "Les invendus sont repris le lendemain avant 10h", body: "Procédure de reprise.", entities: [], confidence: 0.8 },
              { zone: "RH_Recrutement", kind: "fact", title: "La période d'essai des boulangers est de deux mois", body: "Règle des contrats.", entities: [], confidence: 0.8 },
              { zone: "Service client", kind: "fact", title: "Le SAV répond sous 24 h", body: "Engagement affiché.", entities: [], confidence: 0.7 },
            ],
          },
        }),
      },
    },
  }
  const draft = await synthesizeOnboarding(fake as never, { answers: [], pages: [], existingZones: [] })
  assert.ok(draft)
  assert.deepEqual(draft.zones.map((z) => z.id), ["direction", "service-client", "rh-recrutement"])
  assert.deepEqual(draft.items.map((i) => i.zone), ["service-client", "rh-recrutement", "service-client"])
  // Doublons après normalisation : identifiants distincts, et un nom ne masque pas l'identifiant d'une autre zone.
  const { zones, zoneId } = normalizeOnboardingZones([
    { id: "ventes", name: "Sales" },
    { id: "Ventes", name: "Commerce" },
    { id: "sales", name: "Partenariats" },
  ])
  assert.deepEqual(zones.map((z) => z.id), ["ventes", "ventes-2", "sales"])
  assert.equal(zoneId("sales"), "sales")
  assert.equal(zoneId("Commerce"), "ventes-2")
})

test("zones (2e passe) : le sigle CI reste un signal Dev, la particule « -ci » non", () => {
  // Zones déjà stockées en production : « ci » et « pr » dans Dev, ni « gitlab » ni « cicd ».
  const stored = DEFAULT_ZONES.map((z) =>
    z.id === "dev" ? { ...z, keywords: [...z.keywords.filter((k) => !["ci", "cicd", "github", "gitlab"].includes(k)), "ci", "pr"] } : z,
  )
  // [texte, première zone attendue] ; hors Dev, « dev » ne doit apparaître nulle part. Zones par défaut puis stockées.
  const cases: [string, string][] = [
    ["Le pipeline CI/CD échoue", "dev"],
    ["Pourquoi la CI est lente ?", "dev"],
    ["gitlab-ci.yml ne passe pas", "dev"],
    ["La CI-CD de GitHub est rouge", "dev"],
    ["Le job .github-ci casse sur main", "dev"],
    ["Quel est le montant des factures impayées ce mois-ci ?", "compta"],
    ["Envoie la facture ci-jointe au client", "sales"],
    ["Voir le devis ci-dessous", "sales"],
    ["Comme ci comme ça, le devis du client", "sales"],
  ]
  for (const zones of [DEFAULT_ZONES, stored]) {
    const wrong = cases
      .map(([t, want]) => ({ t, want, got: classifyZones(t, zones, 2) }))
      .filter(({ want, got }) => got[0] !== want || (want !== "dev" && got.includes("dev")))
    assert.deepEqual(wrong, [], zones === stored ? "zones stockées" : "zones par défaut")
  }
  assert.deepEqual(tokenize("gitlab-ci.yml"), ["gitlab", "ci", "yml"])
  assert.deepEqual(tokenize("ci-joint ce mois-ci"), ["joint", "mois"])
  assert.ok(tokenize("CI/CD").includes("cicd"))
})
