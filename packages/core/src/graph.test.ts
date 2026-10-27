import { test } from "node:test"
import assert from "node:assert/strict"
import { GRAPH_DEFAULTS, GRAPH_TYPE_WEIGHTS, entityKey, entityWeight, graphNeighbors, graphSlots } from "./index"

const item = (id: string, entities: [type: "client" | "project" | "tool" | "person" | "doc", name: string][]) => ({
  id,
  title: `Item ${id}`,
  entities: entities.map(([type, name]) => ({ type, name })),
})

test("entityKey: type and normalized name, the same whatever the case or accents", () => {
  assert.equal(entityKey({ type: "client", name: "Kalia Santé" }), "client:kalia sante")
  assert.equal(entityKey({ type: "client", name: "KALIA SANTÉ" }), entityKey({ type: "client", name: "Kalia Santé" }), "same key as the stores' norm_name: lowercase, without accents")
})

test("entityWeight: rarer entities link harder; a person or a tool says less than a customer or a project", () => {
  assert.equal(entityWeight("client", 1), 0, "an entity cited by the result alone links nothing")
  assert.ok(entityWeight("client", 2) > entityWeight("client", 6))
  assert.ok(entityWeight("project", 3) > entityWeight("tool", 3))
  assert.ok(entityWeight("tool", 3) > entityWeight("person", 3))
})

test("graphNeighbors: one hop from the best results, strongest ties first, explained", () => {
  const deploy = item("deploy", [["tool", "Vercel"], ["tool", "Supabase"], ["project", "Black Friday"]])
  const migration = item("migration", [["tool", "Vercel"], ["tool", "Supabase"], ["project", "Black Friday"]])
  const backup = item("backup", [["tool", "Supabase"]])
  const unrelated = item("unrelated", [["client", "Kalia Santé"]])
  const degree = { [entityKey({ type: "tool", name: "Vercel" })]: 2, [entityKey({ type: "tool", name: "Supabase" })]: 3, [entityKey({ type: "project", name: "Black Friday" })]: 2 }
  const hits = graphNeighbors([deploy], [deploy, migration, backup, unrelated], degree)
  assert.deepEqual(hits.map((h) => h.id), ["migration", "backup"], "the seed is never returned, an item sharing nothing never comes")
  assert.ok(hits[0].score > hits[1].score, "three shared entities beat one")
  assert.equal(hits[0].via.from.id, "deploy")
  assert.equal(hits[0].via.entity.name, "Black Friday", "the explanation keeps the strongest link (a project, cited twice)")
})

test("graphNeighbors: the first seed weighs most; weak, distant ties fall under the threshold", () => {
  const a = item("a", [["project", "B2B leasing"]])
  const b = item("b", [["project", "Returns"]])
  const c = item("c", [["project", "Laptops"]])
  const nearA = item("nearA", [["project", "B2B leasing"]])
  const nearC = item("nearC", [["project", "Laptops"]])
  const degree = { "project:b2b leasing": 2, "project:returns": 2, "project:laptops": 2 }
  const hits = graphNeighbors([a, b, c], [nearA, nearC], degree)
  assert.deepEqual(hits.map((h) => h.id), ["nearA"], "a link from the third result alone is too weak")
  assert.equal(graphNeighbors([a, b, c], [nearA, nearC], degree, { minScore: 0 }).length, 2)
})

test("graphNeighbors: a hub links nothing; ties through several seeds add up", () => {
  const seeds = [item("s1", [["tool", "Claude"], ["client", "Groupe Vallière"]]), item("s2", [["client", "Groupe Vallière"]])]
  const viaHub = item("viaHub", [["tool", "Claude"]])
  const viaBoth = item("viaBoth", [["client", "Groupe Vallière"]])
  const degree = { "tool:claude": 120, "client:groupe valliere": 5 }
  const hits = graphNeighbors(seeds, [viaHub, viaBoth], degree)
  assert.deepEqual(hits.map((h) => h.id), ["viaBoth"], "an entity cited by 120 items is a hub, skipped")
  assert.equal(hits[0].score, Math.round((entityWeight("client", 5) * 1.5) * 100) / 100, "seed 1 (weight 1) plus seed 2 (weight 1/2)")
})

test("graphNeighbors: people mostly strengthen a link; one person in common never makes one", () => {
  const lone = item("lone", [["person", "Sarah Cohen"]])
  const seeds = [item("s1", [["person", "Sarah Cohen"]]), item("s2", [["person", "Sarah Cohen"]]), item("s3", [["person", "Sarah Cohen"]])]
  assert.equal(graphNeighbors(seeds, [lone], { "person:sarah cohen": 4 }).length, 0, "even through every seed")
  assert.ok(GRAPH_DEFAULTS.minScore > (GRAPH_TYPE_WEIGHTS.person * (1 + 1 / 2 + 1 / 3)) / Math.log2(3), "whatever the degree (2 at least)")

  const seed = item("seed", [["person", "Hugo Bernard"], ["person", "Léo Petit"], ["project", "Laptops"]])
  const sameTeam = item("sameTeam", [["person", "Hugo Bernard"], ["person", "Léo Petit"]])
  const sameProject = item("sameProject", [["project", "Laptops"], ["person", "Hugo Bernard"]])
  const degree = { "person:hugo bernard": 3, "person:leo petit": 2, "project:laptops": 2 }
  const hits = graphNeighbors([seed], [sameTeam, sameProject], degree)
  assert.deepEqual(hits.map((h) => h.id), ["sameProject"], "two people in common with the first result, nothing else: no link")
  assert.equal(hits[0].via.entity.name, "Laptops")
  assert.ok(hits[0].score > entityWeight("project", 2), "the person in common strengthens the project's link")
})

test("graphSlots: a quarter of the results or the empty places, none in a short list", () => {
  assert.equal(graphSlots(8), 2)
  assert.equal(graphSlots(5), 1)
  assert.equal(graphSlots(3), 0)
  assert.equal(graphSlots(20), 5)
  assert.equal(graphSlots(8, 5), 3, "the places the direct results leave empty")
  assert.equal(graphSlots(8, 7), 2)
  assert.equal(graphSlots(3, 0), 0, "a short list stays without neighbors")
})
