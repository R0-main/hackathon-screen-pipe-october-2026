// The Settings page on file storage with the Encore demo: the defaults until an admin saves, a change kept as asked,
// semantic search and reranking turned off for the company (nothing sent to the provider, at search or at ingestion),
// what search_brain sends agents, the page's data, and who may change it (members and the public demo read only).
// BRAIN_TEST_DATABASE_URL (a throwaway database, migrated): the same on Postgres; it is reset by the seed.

import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-settings-"))
process.env.BRAIN_DATA_DIR = dir
if (process.env.BRAIN_TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.BRAIN_TEST_DATABASE_URL
else delete process.env.DATABASE_URL
delete process.env.ANTHROPIC_API_KEY
delete process.env.ANTHROPIC_AUTH_TOKEN
delete process.env.BRAIN_DEMO

// A fake provider and reranker in place of the deployment's: they count what they are sent.
const sent = { documents: 0, queries: 0, reranked: 0 }
const g = globalThis as Record<string, unknown>
g.__brainEmbedding = {
  id: "voyage",
  model: "fake-1",
  embed: async (texts: string[], kind: string) => {
    if (kind === "query") sent.queries += texts.length
    else sent.documents += texts.length
    return texts.map((t) => [t.length % 7, 1, t.includes("deploy") ? 1 : 0])
  },
}
g.__brainReranker = {
  model: "fake-rerank",
  rerank: async (_q: string, docs: string[]) => {
    sent.reranked++
    return docs.map(() => 0.9)
  },
}

const { getRootStore, runInOrg } = await import("../lib/store")
const { seedDemoBrain } = await import("../lib/demo-seed")
const { getAccess } = await import("../lib/access")
const { ingestItems, queryBrain } = await import("../lib/brain")
const { DEFAULT_SEARCH_SETTINGS, getSearchSettings, setSearchSettings } = await import("../lib/search-settings")
const { settingsOverview } = await import("../lib/settings")
const { agentFormat, formatQuery } = await import("@brain/core/mcp")
const settingsRoute = await import("../app/api/settings/route")
type Viewer = import("../lib/auth").Viewer

const root = getRootStore()
let org = ""
let tokens: Record<string, { token: string; id: string }> = {}
const inOrg = <T>(fn: () => Promise<T>) => runInOrg(org, fn)

async function viewer(key: string): Promise<Viewer> {
  const p = await root.getProfile(tokens[key].id)
  if (!p) throw new Error(`${key} not found`)
  return { profile: p, real: p, access: await getAccess(p) }
}

/** PUT /api/settings as `key` (its token, as a workstation or an agent would). */
async function put(key: string, body: unknown) {
  const req = new Request("http://settings.test/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json", authorization: `Bearer ${tokens[key].token}` },
    body: JSON.stringify(body),
  })
  const res = await settingsRoute.PUT(req, undefined)
  return { status: res.status, data: (await res.json()) as any }
}

before(async () => {
  tokens = (await seedDemoBrain(root)).tokens
  org = (await root.getOrg()).id
})

after(async () => {
  fs.rmSync(dir, { recursive: true, force: true })
  await (root as { end?: () => Promise<void> }).end?.()
})

test("settings: the defaults until an admin saves, a change kept, an unreadable value ignored", async () => {
  assert.deepEqual(await inOrg(() => getSearchSettings()), DEFAULT_SEARCH_SETTINGS)
  const saved = await inOrg(() => setSearchSettings(root, { agents: { documents: 0 } }, "Claire Martin"))
  assert.deepEqual(saved.agents, { ...DEFAULT_SEARCH_SETTINGS.agents, documents: 0 }, "only what was asked changes")
  assert.equal(saved.updated_by, "Claire Martin")
  await inOrg(() => root.setOrgSetting("search-settings", "{not json"))
  assert.deepEqual(await inOrg(() => getSearchSettings()), DEFAULT_SEARCH_SETTINGS)
  await inOrg(() => root.setOrgSetting("search-settings", null))
})

test("settings: semantic search and reranking off, nothing goes to the provider, at search or at ingestion", async () => {
  const hugo = await viewer("hugo")
  sent.queries = sent.reranked = sent.documents = 0
  await inOrg(() => queryBrain(hugo, { query: "how do we deploy to production" }))
  assert.ok(sent.queries > 0 && sent.reranked > 0, "on by default: the question is embedded, the candidates reranked")

  await inOrg(() => setSearchSettings(root, { semantic: false, rerank: false }, "Claire Martin"))
  sent.queries = sent.reranked = sent.documents = 0
  const r = await inOrg(() => queryBrain(hugo, { query: "how do we deploy to production" }))
  assert.ok(r.items.some((i) => i.title === "Deploy Encore to production"), "words and keywords still find it")
  await inOrg(() =>
    ingestItems(hugo, [{ zone: "dev", kind: "fact", title: "Settings test: the staging database resets on Sundays", body: "Every Sunday at 3am.", entities: [], source: { app: "Terminal", tool: "claude-code", at: new Date().toISOString() }, confidence: 0.8 }]),
  )
  assert.deepEqual(sent, { documents: 0, queries: 0, reranked: 0 })

  await inOrg(() => setSearchSettings(root, { semantic: true, rerank: true }, "Claire Martin"))
  await inOrg(() =>
    ingestItems(hugo, [{ zone: "dev", kind: "fact", title: "Settings test: staging deploys go out at noon", body: "Noon, after the stand-up.", entities: [], source: { app: "Terminal", tool: "claude-code", at: new Date().toISOString() }, confidence: 0.8 }]),
  )
  assert.ok(sent.documents > 0, "back on: new knowledge is indexed")
})

test("settings: search_brain answers with the company's number of results and format, the agent's choice first", async () => {
  const hugo = await viewer("hugo")
  await inOrg(() => setSearchSettings(root, { agents: { limit: 5, detail: "full", documents: 1 } }, "Claire Martin"))
  const r = await inOrg(() => queryBrain(hugo, { query: "deploy" }))
  assert.ok(r.items.length <= 5)
  assert.deepEqual(r.format, { detail: "full", documents: 1 })
  assert.deepEqual(agentFormat(undefined, r.format), { documents: 1 }, "the company's choice: every result in full")
  assert.deepEqual(agentFormat("compact", r.format), { full: 3, documents: 1 }, "the agent asked: compact")
  assert.deepEqual(agentFormat(undefined, undefined), { full: 3, documents: 2 }, "an older brain: compact, 2 documents")
  const text = formatQuery(r as any, (z) => z, agentFormat(undefined, r.format))
  assert.ok(!text.includes("Also relevant"), "full: no one-line results")
  await inOrg(() => root.setOrgSetting("search-settings", null))
})

test("settings page: the index, the keywords left, the tokens per search, what leaves the company", async () => {
  const claire = await viewer("claire")
  const o = await inOrg(() => settingsOverview(claire))
  assert.equal(o.can_edit, true)
  assert.deepEqual(o.deployment, { embeddings: { provider: "Voyage AI (embeddings)", model: "fake-1" }, reranker: { model: "fake-rerank" } })
  assert.ok(o.index && o.index.total > 0 && o.index.missing >= 0 && o.index.missing <= o.index.total)
  assert.equal(o.keywords.total, o.index!.total)
  assert.ok(o.tokens.compact > 0 && o.tokens.compact < o.tokens.full, `compact ${o.tokens.compact} < full ${o.tokens.full}`)
  assert.ok(o.leaves.some((l) => l.who.startsWith("Voyage AI (embeddings)")) && o.leaves.some((l) => l.who === "Voyage AI (reranking)"))
  assert.ok(!o.leaves.some((l) => l.who.startsWith("Anthropic")), "no Claude on this deployment: nothing to Anthropic")

  await inOrg(() => setSearchSettings(root, { semantic: false, rerank: false }, "Claire Martin"))
  const off = await inOrg(() => settingsOverview(claire))
  assert.deepEqual(off.leaves, [], "nothing leaves")
  await inOrg(() => root.setOrgSetting("search-settings", null))

  const hugo = await viewer("hugo")
  const member = await inOrg(() => settingsOverview(hugo))
  assert.equal(member.can_edit, false)
  assert.deepEqual(member.claude, { source: null }, "a member sees where Claude comes from, nothing of the key")
})

test("settings route: an admin changes them, a member cannot, nor anyone on the public demo", async () => {
  const bad = await put("claire", { agents: { limit: 500 } })
  assert.equal(bad.status, 400, "out of range")
  assert.equal((await put("hugo", { semantic: false })).status, 403, "members read only")
  const ok = await put("claire", { agents: { documents: 3 } })
  assert.equal(ok.status, 200)
  assert.equal(ok.data.settings.agents.documents, 3)
  process.env.BRAIN_DEMO = "1"
  try {
    const demo = await put("claire", { semantic: false })
    assert.equal(demo.status, 403)
    assert.match(demo.data.error, /demo's settings are read-only/)
    assert.equal((await inOrg(() => getSearchSettings())).semantic, true, "unchanged")
    assert.equal((await inOrg(async () => settingsOverview(await viewer("claire")))).can_edit, false)
  } finally {
    delete process.env.BRAIN_DEMO
  }
})
