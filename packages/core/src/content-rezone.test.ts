import { test } from "node:test"
import assert from "node:assert/strict"
import { CORE_ZONE, contentText, contentZone, zoneScorer } from "./index"

const zones = [
  { id: "dev", name: "Dev", keywords: ["code", "deploy", "bug", "api", "migration"] },
  { id: "legal", name: "Legal", keywords: ["prefecture", "visa", "residence", "permit", "lawyer", "appeal"] },
  { id: "sales", name: "Sales", keywords: ["job", "interview", "recruiter", "application", "resume", "offer"] },
  { id: "side-project", name: "Side project", keywords: [] },
  CORE_ZONE,
]
const score = zoneScorer(zones)

test("contentZone: knowledge that clearly belongs elsewhere moves", () => {
  const text = "Residence permit renewal: book the prefecture appointment, the visa expires in March"
  assert.deepEqual(contentZone(text, "side-project", score)?.zone, "legal")
  assert.equal(contentZone(text, "dev", score)?.zone, "legal")
})

test("contentZone: knowledge that fits where it is, or too faint a signal, stays", () => {
  assert.equal(contentZone("Fix the deploy bug in the API migration", "dev", score), undefined, "already in its zone")
  assert.equal(contentZone("Call the lawyer", "dev", score), undefined, "a single keyword is not enough")
  assert.equal(contentZone("Deploy the API for the visa, prefecture and residence forms", "dev", score), undefined, "not twice the current zone's score")
  assert.equal(contentZone("Nothing to see here", "dev", score), undefined)
})

test("contentZone: the core neither gives nor receives", () => {
  const coreText = "Our mission and vision, the values every member shares"
  assert.equal(contentZone(coreText, "dev", score), undefined)
  assert.equal(contentZone("Prefecture appointment for the visa and residence permit", CORE_ZONE.id, score), undefined)
})

test("contentZone: `to` limits the destinations without settling for a second best", () => {
  const job = "Job interview with the recruiter: send the resume and the application"
  assert.equal(contentZone(job, "dev", score, { to: ["legal", "sales"] })?.zone, "sales")
  assert.equal(contentZone(job, "dev", score, { to: ["legal"] }), undefined)
})

test("contentText: title, body and entity names", () => {
  assert.equal(contentText({ title: "T", body: "B", entities: [{ name: "Prefecture of Paris" }] }), "T B Prefecture of Paris")
})
