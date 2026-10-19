import { strict as assert } from "node:assert"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import { cmdRezone, localSessions, projectMoves } from "../src/rezone"
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
