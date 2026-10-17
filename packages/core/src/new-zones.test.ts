import { test } from "node:test"
import assert from "node:assert/strict"
import {
  DISTILL_MARKER,
  MAX_ZONES,
  NEW_ZONES_MAX_ITEMS,
  buildCliNewZonesPrompt,
  buildNewZonesInput,
  buildNewZonesPrompt,
  parseNewZonesJson,
  planNewZones,
  readersOfNewZone,
  type KnowledgeItem,
  type Zone,
} from "./index"

const zone = (id: string, name: string, position = 0): Zone => ({ id, name, description: `Zone ${name}.`, color: "#2a78d6", keywords: [], position })
const ZONES = [zone("direction", "Direction"), zone("compta", "Compta", 1), zone("dev", "Dev", 2)]

const item = (n: number, zone: string, author = "u-claire"): KnowledgeItem => ({
  id: `item-${n}`,
  org_id: "org",
  author_id: author,
  zone,
  kind: "fact",
  title: `Connaissance ${n}`,
  body: `Contenu ${n}`,
  entities: [],
  source: { app: "Terminal", tool: "claude-code", at: "2026-10-16T09:00:00Z" },
  confidence: 0.8,
  created_at: "2026-10-16T09:00:00Z",
})

const ITEMS = [
  ...[1, 2, 3].map((n) => item(n, "direction")),
  item(4, "compta", "u-jm"),
  item(5, "direction"),
  item(6, "dev", "u-hugo"),
]
const input = () => buildNewZonesInput({ companyName: "Fournil", zones: ZONES, items: ITEMS })
const juridique = { name: "Juridique", description: "Contrats, CGV, conformité.", keywords: ["Contrat", "CGV", "rgpd", "contrat", "x"], items: [1, 2, 3, 4] }

test("numérote les connaissances et les rend lisibles pour Claude", () => {
  const i = input()
  assert.deepEqual(i.items.map((x) => x.ref), [1, 2, 3, 4, 5, 6])
  const prompt = buildNewZonesPrompt(i)
  assert.match(prompt, /- compta : Compta — Zone Compta\./)
  assert.match(prompt, /#4 \[compta\] fact — Connaissance 4 : Contenu 4/)
  const many = buildNewZonesInput({ companyName: "F", zones: ZONES, items: Array.from({ length: NEW_ZONES_MAX_ITEMS + 5 }, (_, n) => item(n, "dev")) })
  assert.equal(many.items.length, NEW_ZONES_MAX_ITEMS)
})

test("crée la zone proposée, avec ses connaissances et leur zone d'origine", () => {
  const [plan, ...rest] = planNewZones([juridique], input(), ZONES)
  assert.equal(rest.length, 0)
  assert.deepEqual(plan.zone, { id: "juridique", name: "Juridique", description: "Contrats, CGV, conformité.", keywords: ["contrat", "cgv", "rgpd"] })
  assert.deepEqual(
    plan.items.map((i) => `${i.id}<${i.from}`),
    ["item-1<direction", "item-2<direction", "item-3<direction", "item-4<compta"],
  )
})

test("écarte les propositions trop maigres, les numéros inventés et les doublons d'une zone existante", () => {
  assert.deepEqual(planNewZones([{ ...juridique, items: [1, 2, 3] }], input(), ZONES), [], "3 connaissances ne suffisent pas")
  assert.deepEqual(planNewZones([{ ...juridique, items: [1, 2, 3, 99, 99] }], input(), ZONES), [], "un numéro inconnu ne compte pas")
  assert.deepEqual(planNewZones([{ ...juridique, items: [1, 1, 2, 2] }], input(), ZONES), [], "un numéro répété ne compte qu'une fois")
  assert.deepEqual(planNewZones([{ ...juridique, name: "COMPTA" }], input(), ZONES), [], "même nom qu'une zone existante")
  assert.deepEqual(planNewZones([{ ...juridique, name: "Dév" }], input(), ZONES), [], "même identifiant qu'une zone existante")
  assert.deepEqual(planNewZones([{ ...juridique, name: "   " }], input(), ZONES), [], "nom vide")
})

test("une connaissance ne part que dans une seule nouvelle zone, et au plus deux zones par passage", () => {
  const rh = { name: "RH", description: "Recrutement.", keywords: [], items: [1, 2, 3, 5] }
  assert.deepEqual(planNewZones([juridique, rh], input(), ZONES).map((p) => p.zone.id), ["juridique"], "RH n'a plus que 1 connaissance à elle")
  const big = buildNewZonesInput({ companyName: "F", zones: ZONES, items: Array.from({ length: 12 }, (_, n) => item(n, "direction")) })
  const three = ["A", "B", "C"].map((name, k) => ({ name, description: "", keywords: [], items: [1, 2, 3, 4].map((r) => r + 4 * k) }))
  assert.deepEqual(planNewZones(three, big, ZONES).map((p) => p.zone.id), ["a", "b"])
  assert.deepEqual(planNewZones([three[0], { ...three[1], name: "a" }], big, ZONES).map((p) => p.zone.id), ["a"], "pas deux fois la même zone")
})

test("plus aucune zone au-delà du plafond", () => {
  const full = Array.from({ length: MAX_ZONES }, (_, n) => zone(`z${n}`, `Zone ${n}`, n))
  assert.deepEqual(planNewZones([juridique], input(), full), [])
  assert.equal(planNewZones([juridique, { ...juridique, name: "RH", items: [5, 6, 1, 2] }], input(), full.slice(1)).length, 1)
})

test("lecteurs de la nouvelle zone : ses auteurs, et qui lisait toutes ses zones d'origine", () => {
  const [plan] = planNewZones([juridique], input(), ZONES)
  const members = [
    { id: "u-jm", readable: ["compta"] }, // auteur de #4
    { id: "u-sarah", readable: ["direction", "compta"] }, // lisait tout
    { id: "u-ines", readable: ["direction"] }, // ne lisait pas la compta
    { id: "u-hugo", readable: ["dev"] },
  ]
  assert.deepEqual(readersOfNewZone(plan, members), ["u-jm", "u-sarah"])
})

test("lit la réponse de claude -p : enveloppe, bloc de code, numéros « #12 », liste vide", () => {
  const body = { zones: [{ name: "Juridique", description: "Contrats.", keywords: ["contrat", 3], items: ["#1", 2, "3", "x", 4.5] }] }
  const envelope = JSON.stringify({ type: "result", is_error: false, result: "Voici :\n```json\n" + JSON.stringify(body) + "\n```" })
  assert.deepEqual(parseNewZonesJson(envelope), [{ name: "Juridique", description: "Contrats.", keywords: ["contrat"], items: [1, 2, 3] }])
  assert.deepEqual(parseNewZonesJson('{"zones":[]}'), [])
  assert.equal(parseNewZonesJson(JSON.stringify({ is_error: true, result: "rate limit" })), null)
  assert.equal(parseNewZonesJson("Je ne sais pas."), null)
  const prompt = buildCliNewZonesPrompt(input())
  assert.ok(prompt.startsWith(DISTILL_MARKER) && prompt.includes("#4 [compta]") && prompt.includes('{"zones":[]}'))
})
