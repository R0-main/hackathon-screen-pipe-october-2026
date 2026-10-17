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
const ZONES = [zone("leadership", "Leadership"), zone("finance", "Finance", 1), zone("dev", "Dev", 2)]

const item = (n: number, zone: string, author = "u-claire"): KnowledgeItem => ({
  id: `item-${n}`,
  org_id: "org",
  author_id: author,
  zone,
  kind: "fact",
  title: `Item ${n}`,
  body: `Content ${n}`,
  entities: [],
  source: { app: "Terminal", tool: "claude-code", at: "2026-10-16T09:00:00Z" },
  confidence: 0.8,
  created_at: "2026-10-16T09:00:00Z",
})

const ITEMS = [
  ...[1, 2, 3].map((n) => item(n, "leadership")),
  item(4, "finance", "u-jm"),
  item(5, "leadership"),
  item(6, "dev", "u-hugo"),
]
const input = () => buildNewZonesInput({ companyName: "Fournil", zones: ZONES, items: ITEMS })
const legal = { name: "Legal", description: "Contracts, terms, compliance.", keywords: ["Contract", "Terms", "gdpr", "contract", "x"], items: [1, 2, 3, 4] }

test("numbers the items and makes them readable for Claude", () => {
  const i = input()
  assert.deepEqual(i.items.map((x) => x.ref), [1, 2, 3, 4, 5, 6])
  const prompt = buildNewZonesPrompt(i)
  assert.match(prompt, /- finance: Finance — Zone Finance\./)
  assert.match(prompt, /#4 \[finance\] fact — Item 4: Content 4/)
  const many = buildNewZonesInput({ companyName: "F", zones: ZONES, items: Array.from({ length: NEW_ZONES_MAX_ITEMS + 5 }, (_, n) => item(n, "dev")) })
  assert.equal(many.items.length, NEW_ZONES_MAX_ITEMS)
})

test("creates the proposed zone, with its items and their original zone", () => {
  const [plan, ...rest] = planNewZones([legal], input(), ZONES)
  assert.equal(rest.length, 0)
  assert.deepEqual(plan.zone, { id: "legal", name: "Legal", description: "Contracts, terms, compliance.", keywords: ["contract", "terms", "gdpr"] })
  assert.deepEqual(
    plan.items.map((i) => `${i.id}<${i.from}`),
    ["item-1<leadership", "item-2<leadership", "item-3<leadership", "item-4<finance"],
  )
})

test("drops proposals that are too thin, invented numbers and duplicates of an existing zone", () => {
  assert.deepEqual(planNewZones([{ ...legal, items: [1, 2, 3] }], input(), ZONES), [], "3 items are not enough")
  assert.deepEqual(planNewZones([{ ...legal, items: [1, 2, 3, 99, 99] }], input(), ZONES), [], "an unknown number does not count")
  assert.deepEqual(planNewZones([{ ...legal, items: [1, 1, 2, 2] }], input(), ZONES), [], "a repeated number only counts once")
  assert.deepEqual(planNewZones([{ ...legal, name: "FINANCE" }], input(), ZONES), [], "same name as an existing zone")
  assert.deepEqual(planNewZones([{ ...legal, name: "Dev!" }], input(), ZONES), [], "same id as an existing zone")
  assert.deepEqual(planNewZones([{ ...legal, name: "   " }], input(), ZONES), [], "empty name")
})

test("an item only goes to one new zone, and at most two zones per run", () => {
  const hr = { name: "HR", description: "Hiring.", keywords: [], items: [1, 2, 3, 5] }
  assert.deepEqual(planNewZones([legal, hr], input(), ZONES).map((p) => p.zone.id), ["legal"], "HR only has 1 item of its own left")
  const big = buildNewZonesInput({ companyName: "F", zones: ZONES, items: Array.from({ length: 12 }, (_, n) => item(n, "leadership")) })
  const three = ["A", "B", "C"].map((name, k) => ({ name, description: "", keywords: [], items: [1, 2, 3, 4].map((r) => r + 4 * k) }))
  assert.deepEqual(planNewZones(three, big, ZONES).map((p) => p.zone.id), ["a", "b"])
  assert.deepEqual(planNewZones([three[0], { ...three[1], name: "a" }], big, ZONES).map((p) => p.zone.id), ["a"], "not the same zone twice")
})

test("no more zones beyond the cap", () => {
  const full = Array.from({ length: MAX_ZONES }, (_, n) => zone(`z${n}`, `Zone ${n}`, n))
  assert.deepEqual(planNewZones([legal], input(), full), [])
  assert.equal(planNewZones([legal, { ...legal, name: "HR", items: [5, 6, 1, 2] }], input(), full.slice(1)).length, 1)
})

test("readers of the new zone: its authors, and whoever read all its original zones", () => {
  const [plan] = planNewZones([legal], input(), ZONES)
  const members = [
    { id: "u-jm", readable: ["finance"] }, // author of #4
    { id: "u-sarah", readable: ["leadership", "finance"] }, // read everything
    { id: "u-ines", readable: ["leadership"] }, // did not read finance
    { id: "u-hugo", readable: ["dev"] },
  ]
  assert.deepEqual(readersOfNewZone(plan, members), ["u-jm", "u-sarah"])
})

test("reads the claude -p answer: envelope, code block, \"#12\" numbers, empty list", () => {
  const body = { zones: [{ name: "Legal", description: "Contracts.", keywords: ["contract", 3], items: ["#1", 2, "3", "x", 4.5] }] }
  const envelope = JSON.stringify({ type: "result", is_error: false, result: "Here you go:\n```json\n" + JSON.stringify(body) + "\n```" })
  assert.deepEqual(parseNewZonesJson(envelope), [{ name: "Legal", description: "Contracts.", keywords: ["contract"], items: [1, 2, 3] }])
  assert.deepEqual(parseNewZonesJson('{"zones":[]}'), [])
  assert.equal(parseNewZonesJson(JSON.stringify({ is_error: true, result: "rate limit" })), null)
  assert.equal(parseNewZonesJson("I don't know."), null)
  const prompt = buildCliNewZonesPrompt(input())
  assert.ok(prompt.startsWith(DISTILL_MARKER) && prompt.includes("#4 [finance]") && prompt.includes('{"zones":[]}'))
})
