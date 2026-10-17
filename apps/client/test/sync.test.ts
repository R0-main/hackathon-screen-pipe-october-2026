import { strict as assert } from "node:assert"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { after, before, test } from "node:test"
import { acquireLock, parseSince, runSync } from "../src/sync"
import { tempDir } from "./helpers"
import { mockBrain } from "./mock-brain"

let brain: Awaited<ReturnType<typeof mockBrain>>
let home: string

const ts = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString()
const line = (o: unknown) => JSON.stringify(o) + "\n"
const quiet = { log: () => {}, warn: () => {} }

before(async () => {
  brain = await mockBrain()
  home = tempDir()
  const claude = tempDir()
  const proj = join(claude, "projects", "-home-hugo-fournil")
  mkdirSync(proj, { recursive: true })
  const s = "11111111-2222-3333-4444-555555555555"
  writeFileSync(
    join(proj, `${s}.jsonl`),
    line({ type: "user", sessionId: s, cwd: "/home/hugo/fournil", timestamp: ts(20), message: { role: "user", content: "How do we deploy the API to production? My token is sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA and my email hugo@fournil.fr" } }) +
      line({
        type: "assistant",
        sessionId: s,
        cwd: "/home/hugo/fournil",
        timestamp: ts(19),
        message: { role: "assistant", content: [{ type: "text", text: "We decided to deploy through Git tags.\n1. Merge into main\n2. Create the tag\n3. Watch the logs\nTODO: write the rollback runbook" }] },
      }),
  )
  writeFileSync(join(home, "config.json"), JSON.stringify({ url: brain.url, token: "cb_test_token_123456", screenpipe_url: "http://127.0.0.1:9", use_claude_cli: false, sources: ["claude", "codex", "screenpipe"] }))
  process.env.COMPANY_BRAIN_HOME = home
  process.env.CLAUDE_CONFIG_DIR = claude
  process.env.CODEX_HOME = tempDir()
  delete process.env.ANTHROPIC_API_KEY
})

after(() => brain.close())

test("parseSince", () => {
  const now = new Date("2026-10-16T12:00:00Z")
  assert.equal(parseSince("24h", now).toISOString(), "2026-10-15T12:00:00.000Z")
  assert.equal(parseSince("7d", now).toISOString(), "2026-10-09T12:00:00.000Z")
  assert.equal(parseSince("2026-10-01T00:00:00Z", now).toISOString(), "2026-10-01T00:00:00.000Z")
  assert.throws(() => parseSince("yesterday", now))
})

test("sync --dry-run: nothing is sent, secrets redacted, checkpoints unchanged", async () => {
  const logs: string[] = []
  const r = await runSync({ dryRun: true, source: "claude", distiller: "heuristic" }, { log: (s) => logs.push(s), warn: (s) => logs.push(s) })
  assert.ok(r.items.length >= 3, `items: ${r.items.length}`)
  assert.equal(brain.ingested.length, 0)
  const out = logs.join("\n")
  assert.match(out, /dry run/)
  assert.ok(!out.includes("sk-ant-api03"), "secret shown")
  assert.ok(!out.includes("hugo@fournil.fr"), "email shown")
  assert.ok(!existsSync(join(home, "state.json")))
  const kinds = new Set(r.items.map((i) => i.kind))
  assert.ok(kinds.has("decision") && kinds.has("procedure") && kinds.has("task"))
})

test("sync: sends, saves the checkpoints, then sends nothing again", async () => {
  const r = await runSync({ source: "claude", distiller: "heuristic" }, quiet)
  assert.equal(r.sent, brain.ingested.length)
  assert.ok(r.sent >= 3)
  const json = JSON.stringify(brain.ingested)
  assert.ok(!json.includes("sk-ant-api03") && !json.includes("hugo@fournil.fr"))
  const state = JSON.parse(readFileSync(join(home, "state.json"), "utf8"))
  assert.equal(state.last_sync.items_sent, r.sent)
  const r2 = await runSync({ source: "claude", distiller: "heuristic" }, quiet)
  assert.equal(r2.sent, 0)
  assert.equal(r2.conversations.claude, 0)
})

test("sync --source all: Screenpipe stopped → warning, carry on", async () => {
  const warns: string[] = []
  const r = await runSync({ source: "all", distiller: "heuristic" }, { log: () => {}, warn: (s) => warns.push(s) })
  assert.equal(r.sent, 0)
  assert.ok(warns.some((w) => /Screenpipe unreachable/.test(w)))
})

test("lock: a second sync is refused, an orphaned lock is taken over", () => {
  const lock = acquireLock(join(home, "test.lock"))
  assert.ok("release" in lock)
  const second = acquireLock(join(home, "test.lock"))
  assert.ok("busy" in second)
  lock.release()
  writeFileSync(join(home, "orphan.lock"), JSON.stringify({ pid: 999999999, at: new Date().toISOString() }))
  const third = acquireLock(join(home, "orphan.lock"))
  assert.ok("release" in third)
  third.release()
})
