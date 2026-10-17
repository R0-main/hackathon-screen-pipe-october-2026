import { test } from "node:test"
import assert from "node:assert/strict"
import { applyAutomationReviews, buildAutomationReviewInput, buildAutomationReviewPrompt, type AutomationCandidate } from "./index"

const cand = (n: number, zone = "compta"): AutomationCandidate => ({
  key: `heuristic:u${n}:fp${n}`,
  user_id: "u-jm",
  zone,
  title: `Automatiser « prompt ${n} »`,
  description: "Texte de l'heuristique.",
  schedule: "Du lundi au vendredi à 08h55",
  evidence: { occurrences: 9, days: 7, sample: `rapprochement Qonto ${n}` },
  minutes_saved_per_week: 60,
  source: "heuristic",
})

test("matière de la revue : personne, zone par son nom, prompt, connaissances de la zone", () => {
  const input = buildAutomationReviewInput({
    companyName: "Fournil",
    candidates: [cand(1), cand(2, "dev")],
    zones: [{ id: "compta", name: "Compta" }, { id: "dev", name: "Dev" }],
    profiles: [{ id: "u-jm", name: "Jean-Marc Dubois" }],
    items: [{ zone: "compta", title: "Clôture mensuelle : J+5" }, { zone: "sales", title: "Hors sujet" }],
  })
  assert.deepEqual(input.candidates[0], { ref: 1, person: "Jean-Marc Dubois", zone: "Compta", schedule: "Du lundi au vendredi à 08h55", sample: "rapprochement Qonto 1", occurrences: 9, days: 7 })
  assert.deepEqual(input.context, [{ zone: "Compta", titles: ["Clôture mensuelle : J+5"] }, { zone: "Dev", titles: [] }])
  const prompt = buildAutomationReviewPrompt(input)
  assert.match(prompt, /#1 — Jean-Marc Dubois, zone Compta : « rapprochement Qonto 1 » — 9 fois sur 7 jours, du lundi au vendredi à 08h55/)
  assert.match(prompt, /Compta :\n- Clôture mensuelle : J\+5/)
})

test("avis appliqués : réécrit, écarte, ignore les numéros inconnus, ne touche jamais aux faits", () => {
  const out = applyAutomationReviews(
    [cand(1), cand(2), cand(3)],
    [
      { ref: 1, keep: true, title: "  Préparer chaque matin\nle rapprochement  ", description: "Chaque jour ouvré à 8 h 55, Claude prépare le rapprochement." },
      { ref: 2, keep: false, title: "", description: "" },
      { ref: 9, keep: false, title: "", description: "" },
      { ref: 1, keep: false, title: "doublon ignoré", description: "" },
    ],
  )
  assert.deepEqual(out.map((c) => c.key), ["heuristic:u1:fp1", "heuristic:u3:fp3"])
  assert.equal(out[0].title, "Préparer chaque matin le rapprochement")
  assert.equal(out[0].description, "Chaque jour ouvré à 8 h 55, Claude prépare le rapprochement.")
  assert.deepEqual([out[0].schedule, out[0].minutes_saved_per_week, out[0].evidence, out[0].user_id], [cand(1).schedule, 60, cand(1).evidence, "u-jm"])
  assert.equal(out[1].title, cand(3).title, "sans avis, le texte de l'heuristique reste")
  assert.equal(applyAutomationReviews([cand(1)], [{ ref: 1, keep: true, title: " ", description: "" }])[0].title, cand(1).title, "un avis vide ne vide pas la suggestion")
})
