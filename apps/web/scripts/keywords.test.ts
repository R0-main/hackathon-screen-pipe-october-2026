// Keywords at ingestion, with a simulated Claude: each new knowledge item is read alone, with its source, and its
// keywords are stored apart; the search then finds it by them. Without Claude, or with BRAIN_KEYWORDS=off, nothing is
// called.

import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-keywords-"))
process.env.BRAIN_DATA_DIR = dir
delete process.env.DATABASE_URL
delete process.env.VOYAGE_API_KEY
delete process.env.BRAIN_EMBEDDING_URL
process.env.ANTHROPIC_API_KEY = "sk-ant-test"

/** What Claude was asked, one prompt per call. */
const prompts: string[] = []
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input)
  if (!url.includes("api.anthropic.com")) return realFetch(input, init)
  const body = JSON.parse(String(init?.body ?? "{}"))
  prompts.push(body.messages[0].content)
  const keywords = String(body.messages[0].content).includes("Sentry") ? ["alerte paiement", "taux d'échec"] : ["autre"]
  return new Response(
    JSON.stringify({ id: "msg_test", type: "message", role: "assistant", model: body.model, content: [{ type: "text", text: JSON.stringify({ keywords }) }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } }),
    { status: 200, headers: { "content-type": "application/json" } },
  )
}) as typeof fetch

const { getRootStore, runInOrg } = await import("../lib/store")
const { seedDemoBrain } = await import("../lib/demo-seed")
const { getAccess } = await import("../lib/access")
const { ingestItems, queryBrain } = await import("../lib/brain")
type Viewer = import("../lib/auth").Viewer

const root = getRootStore()
let org = ""
let tokens: Record<string, { token: string; id: string }> = {}

async function viewer(key: string): Promise<Viewer> {
  const p = await root.getProfile(tokens[key].id)
  if (!p) throw new Error(`${key} not found`)
  return { profile: p, real: p, access: await getAccess(p) }
}
const inOrg = <T>(fn: () => Promise<T>) => runInOrg(org, fn)

before(async () => {
  const seeded = await seedDemoBrain(root)
  tokens = seeded.tokens
  org = (await root.getOrg()).id
})

after(async () => {
  globalThis.fetch = realFetch
  fs.rmSync(dir, { recursive: true, force: true })
})

const item = (title: string, body: string) => ({
  zone: "dev",
  kind: "fact" as const,
  title,
  body,
  entities: [{ type: "tool" as const, name: "Sentry" }],
  source: { app: "Terminal", tool: "claude-code" as const, at: new Date().toISOString() },
  confidence: 0.8,
})

test("ingestion: each new item read alone with its source; its keywords stored and searchable", async () => {
  const hugo = await viewer("hugo")
  const r = await inOrg(() => ingestItems(hugo, [item("Sentry pages on checkout errors above 3%", "The alert reads the last 10 minutes of payments.")]))
  assert.equal(r.inserted, 1)
  assert.equal(prompts.length, 1, "one call for one item")
  assert.match(prompts[0], /^<knowledge zone="Dev[^"]*" type="fact" author="Hugo Bernard" app="Terminal" tool="claude-code" date="\d{4}-\d{2}-\d{2}">/)
  assert.equal((prompts[0].match(/<knowledge/g) ?? []).length, 1, "the item alone, never its neighbors")
  const stored = await inOrg(() => root.getItem(r.ids[0]))
  assert.deepEqual(stored?.keywords, ["alerte paiement", "taux d'échec"])
  const found = await inOrg(() => queryBrain(hugo, { query: "alerte paiement" }))
  assert.equal(found.items[0]?.id, r.ids[0])
})

test("BRAIN_KEYWORDS=off: no call, no keywords", async () => {
  process.env.BRAIN_KEYWORDS = "off"
  try {
    const before = prompts.length
    const hugo = await viewer("hugo")
    const r = await inOrg(() => ingestItems(hugo, [item("Sentry release health dashboard", "Crash-free sessions per release, shared in #dev.")]))
    assert.equal(prompts.length, before)
    assert.equal((await inOrg(() => root.getItem(r.ids[0])))?.keywords, undefined)
  } finally {
    delete process.env.BRAIN_KEYWORDS
  }
})
