import { strict as assert } from "node:assert"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import { cmdRezone, localSessions, projectMoves, zoneIds } from "../src/rezone"
import { TEST_ZONES, tempDir } from "./helpers"
import { mockBrain } from "./mock-brain"

const line = (o: unknown) => JSON.stringify(o) + "\n"

/** Claude Code logs (two sessions in two projects, one file) and a Codex session. */
function logs() {
  const claude = tempDir()
  const codex = tempDir()
  const proj = join(claude, "projects", "-home-anas-dev")
  mkdirSync(proj, { recursive: true })
  writeFileSync(
    join(proj, "a.jsonl"),
    line({ type: "summary", summary: "x" }) +
      line({ type: "user", sessionId: "s-encore", cwd: "/home/anas/dev/encore", message: { role: "user", content: "hi" } }) +
      line({ type: "user", sessionId: "s-other", cwd: "/home/anas/dev/other", message: { role: "user", content: "hi" } }) +
      "{not json, cwd\n",
  )
  const day = join(codex, "sessions", "2026", "10", "18")
  mkdirSync(day, { recursive: true })
  writeFileSync(
    join(day, "rollout-2026-10-18T10-00-00-0199aaaa-bbbb-cccc-dddd-eeeeffff0000.jsonl"),
    line({ type: "session_meta", payload: { id: "0199aaaa-bbbb-cccc-dddd-eeeeffff0000", cwd: "/home/anas/clients/fournil/api" } }),
  )
  return { claude, codex }
}

const ZONES = [...TEST_ZONES, { id: "encore", name: "Encore", description: "", keywords: [], projects: ["encore"] }, { id: "fournil", name: "Fournil", description: "", keywords: [], projects: ["fournil"] }]

test("localSessions + projectMoves: each session in a project goes to its zone, the others stay out", () => {
  const sessions = localSessions(logs())
  assert.equal(sessions.get("s-encore"), "/home/anas/dev/encore")
  assert.equal(sessions.get("s-other"), "/home/anas/dev/other")
  assert.equal(sessions.size, 3)
  const moves = projectMoves(sessions, ZONES, () => undefined)
  assert.deepEqual(
    moves.sort((a, b) => a.zone.localeCompare(b.zone)),
    [
      { session_id: "s-encore", zone: "encore" },
      { session_id: [...sessions.keys()].find((k) => sessions.get(k)?.includes("fournil"))!, zone: "fournil" },
    ],
  )
})

test("cmdRezone: sends the moves (dry run then for real); without a project zone: explicit error", async () => {
  const dirs = logs()
  const home = tempDir()
  process.env.COMPANY_BRAIN_HOME = home
  process.env.CLAUDE_CONFIG_DIR = dirs.claude
  process.env.CODEX_HOME = dirs.codex
  const brain = await mockBrain({ zones: ZONES.map((z, i) => ({ color: "#000", position: i, readable: true, ...z })) })
  try {
    writeFileSync(join(home, "config.json"), JSON.stringify({ url: brain.url, token: "cb_test_token_123456" }))
    const out: string[] = []
    assert.equal(await cmdRezone({ dryRun: true }, (s) => out.push(s)), 0)
    assert.equal(brain.rezones.length, 1)
    assert.equal(brain.rezones[0].dry_run, true)
    assert.deepEqual(brain.rezones[0].moves.map((m) => m.zone).sort(), ["encore", "fournil"])
    assert.match(out.join("\n"), /3 local sessions, 2 sessions in a project/)
    assert.match(out.join("\n"), /4 knowledge items would be moved \(Encore 2, Fournil 2\)/)
    await cmdRezone({}, (s) => out.push(s))
    assert.equal(brain.rezones[1].dry_run, false)
    assert.match(out.join("\n"), /4 knowledge items moved/)
  } finally {
    await brain.close()
  }
  const plain = await mockBrain()
  try {
    writeFileSync(join(home, "config.json"), JSON.stringify({ url: plain.url, token: "cb_test_token_123456" }))
    await assert.rejects(cmdRezone({}, () => {}), /No zone lists a project yet/)
    assert.equal(plain.rezones.length, 0)
  } finally {
    await plain.close()
  }
})

test("zoneIds: by id or name, comma-separated; unknown zone or missing value: explicit error", () => {
  assert.equal(zoneIds(undefined, ZONES, "to"), undefined)
  assert.deepEqual(zoneIds("encore, FOURNIL,encore", ZONES, "to"), ["encore", "fournil"])
  assert.throws(() => zoneIds("nope", ZONES, "to"), /--to: unknown zone "nope"/)
  assert.throws(() => zoneIds(true, ZONES, "from"), /--from needs zones/)
})

test("cmdRezone --content: the brain files by content, project sessions kept, examples shown", async () => {
  const dirs = logs()
  const home = tempDir()
  process.env.COMPANY_BRAIN_HOME = home
  process.env.CLAUDE_CONFIG_DIR = dirs.claude
  process.env.CODEX_HOME = dirs.codex
  const brain = await mockBrain({ zones: ZONES.map((z, i) => ({ color: "#000", position: i, readable: true, ...z })) })
  try {
    writeFileSync(join(home, "config.json"), JSON.stringify({ url: brain.url, token: "cb_test_token_123456" }))
    const out: string[] = []
    assert.equal(await cmdRezone({ content: true, dryRun: true, to: "Fournil" }, (s) => out.push(s)), 0)
    assert.equal(brain.rezones.length, 0, "no session move sent")
    const [sent] = brain.contentRezones
    assert.equal(sent.dry_run, true)
    assert.deepEqual(sent.to, ["fournil"])
    assert.equal(sent.from, undefined)
    assert.equal(sent.keep_sessions?.length, 2, "the two sessions opened in a project are kept")
    const text = out.join("\n")
    assert.match(text, /40 knowledge items of yours read, 2 kept in their project's zone/)
    assert.match(text, /12 knowledge items would be moved \(Fournil 12\)/)
    assert.match(text, /· Prefecture appointment 0 — .* → Fournil/)
    assert.match(text, /… and 2 more/)
    assert.match(text, /Dry run: nothing was moved/)
    await assert.rejects(cmdRezone({ to: "fournil" }, () => {}), /--from and --to go with --content/)
    await assert.rejects(cmdRezone({ content: true, from: "nope" }, () => {}), /--from: unknown zone "nope"/)
  } finally {
    await brain.close()
  }
})
