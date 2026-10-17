import { strict as assert } from "node:assert"
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import { DISTILL_MARKER, distillHeuristic } from "@brain/core"
import { buildInstallPrompt } from "../../web/lib/install-prompt"
import type { State } from "../src/config"
import { completeLineCount, parseClaudeLine, readClaudeLogs } from "../src/sources/claude-logs"
import { readNewLines } from "../src/sources/jsonl"
import { TEST_ZONES, tempDir } from "./helpers"

const now = Date.now()
const ts = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString()

function line(o: unknown) {
  return JSON.stringify(o) + "\n"
}

function user(sessionId: string, content: unknown, minAgo: number, extra: Record<string, unknown> = {}) {
  return line({ type: "user", sessionId, cwd: "/home/hugo/fournil", timestamp: ts(minAgo), message: { role: "user", content }, ...extra })
}

function assistant(sessionId: string, content: unknown, minAgo: number, stop_reason?: string) {
  return line({ type: "assistant", sessionId, cwd: "/home/hugo/fournil", timestamp: ts(minAgo), message: { role: "assistant", content, ...(stop_reason ? { stop_reason } : {}) } })
}

function setup() {
  const dir = tempDir()
  const proj = join(dir, "projects", "-home-hugo-fournil")
  mkdirSync(proj, { recursive: true })
  return { dir, proj }
}

test("parseClaudeLine: text content, blocks, tool_result and meta ignored", () => {
  assert.equal(parseClaudeLine({ type: "user", message: { role: "user", content: "Hello" } })?.text, "Hello")
  const blocks = parseClaudeLine({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "Here it is" }, { type: "tool_use", name: "Bash", input: {} }] },
  })
  assert.equal(blocks?.text, "Here it is")
  assert.equal(parseClaudeLine({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "output" }] } }), null)
  assert.equal(parseClaudeLine({ type: "user", isMeta: true, message: { role: "user", content: "skill" } }), null)
  assert.equal(parseClaudeLine({ type: "user", message: { role: "user", content: "<command-name>/clear</command-name>" } }), null)
  assert.equal(
    parseClaudeLine({ type: "user", message: { role: "user", content: "Do this<system-reminder>noise</system-reminder>" } })?.text,
    "Do this",
  )
  assert.equal(parseClaudeLine({ type: "attachment" }), null)
})

test("readClaudeLogs: groups by session, merges the assistant, ignores DISTILL_MARKER, resumes at the offset", () => {
  const { dir, proj } = setup()
  const f1 = join(proj, "s1.jsonl")
  writeFileSync(
    f1,
    user("s1", "How do we deploy to production?", 30) +
      assistant("s1", [{ type: "text", text: "Let me look." }, { type: "tool_use", name: "Read", input: {} }], 29) +
      user("s1", [{ type: "tool_result", tool_use_id: "x", content: "file" }], 29) +
      assistant("s1", [{ type: "text", text: "1. Merge\n2. Tag\n3. Monitor" }], 28) +
      user("s1", "Old message", 60 * 48), // outside the window
  )
  const f2 = join(proj, "internal.jsonl")
  writeFileSync(f2, user("s2", `${DISTILL_MARKER}\nYou feed…`, 10) + assistant("s2", '{"items":[]}', 9))

  const state: State = {}
  const since = new Date(now - 24 * 3600_000)
  const r1 = readClaudeLogs({ dir, state, since })
  assert.equal(r1.conversations.length, 1)
  const c = r1.conversations[0]
  assert.equal(c.id, "s1")
  assert.equal(c.tool, "claude-code")
  assert.equal(c.cwd, "/home/hugo/fournil")
  assert.deepEqual(
    c.messages.map((m) => m.role),
    ["user", "assistant"],
  )
  assert.match(c.messages[1].text, /Let me look\.\n\n1\. Merge/)
  assert.equal(r1.stats.internal, 1)

  // Checkpoints applied, then new lines appended: only the new ones are read.
  for (const cm of r1.commits) cm.apply(state)
  assert.equal(state.claude?.files[f2].internal, true)
  const r2 = readClaudeLogs({ dir, state, since })
  assert.equal(r2.conversations.length, 0)

  appendFileSync(f1, user("s1", "And for the rollback?", 5) + assistant("s1", "We use Promote on Vercel.", 4))
  appendFileSync(f2, assistant("s2", "internal follow-up", 3))
  const r3 = readClaudeLogs({ dir, state, since })
  assert.equal(r3.conversations.length, 1)
  assert.equal(r3.conversations[0].messages.length, 2)
  assert.equal(r3.conversations[0].messages[0].text, "And for the rollback?")
})

test("readNewLines: incomplete line left for later, truncated file read again from 0", () => {
  const { proj } = setup()
  const f = join(proj, "x.jsonl")
  writeFileSync(f, line({ a: 1 }) + '{"b":')
  const r1 = readNewLines(f)!
  assert.equal(r1.lines.length, 1)
  appendFileSync(f, "2}\n")
  const r2 = readNewLines(f, r1.checkpoint)!
  assert.deepEqual(r2.lines, [{ b: 2 }])
  writeFileSync(f, line({ c: 3 }))
  const r3 = readNewLines(f, r2.checkpoint)!
  assert.equal(r3.reset, true)
  assert.deepEqual(r3.lines, [{ c: 3 }])
})

test("turn split between two syncs: the offset stops before the unanswered question, then the whole turn is read", () => {
  const { dir, proj } = setup()
  const f = join(proj, "turn.jsonl")
  // Sync 1: the question is written, the assistant has only produced a tool call so far.
  writeFileSync(
    f,
    user("t", "We decided to keep Qonto for the cash. How do we reconcile the statements?", 3) +
      assistant("t", [{ type: "tool_use", name: "Read", input: {} }], 2, "tool_use") +
      user("t", [{ type: "tool_result", tool_use_id: "x", content: "statement" }], 2),
  )
  const state: State = {}
  const since = new Date(now - 24 * 3600_000)
  const r1 = readClaudeLogs({ dir, state, since })
  assert.equal(r1.conversations.length, 0)
  assert.equal(r1.stats.pending, 1)
  for (const c of r1.commits) c.apply(state)
  assert.equal(state.claude?.files[f], undefined, "no checkpoint past the turn in progress")

  // Sync 2: the final answer is written → the whole turn (question + answer) is read and distilled.
  appendFileSync(
    f,
    assistant("t", [{ type: "text", text: "Decision: we keep Qonto for the cash.\n1. Export the Qonto statements\n2. Import them into Pennylane\n3. Match the entries" }], 1, "end_turn"),
  )
  const r2 = readClaudeLogs({ dir, state, since })
  assert.equal(r2.conversations.length, 1)
  const conv = r2.conversations[0]
  assert.deepEqual(conv.messages.map((m) => m.role), ["user", "assistant"])
  assert.match(conv.messages[0].text, /keep Qonto/)
  const items = distillHeuristic(conv, TEST_ZONES)
  assert.ok(items.some((i) => i.kind === "decision"), JSON.stringify(items.map((i) => i.title)))
  assert.ok(items.some((i) => i.kind === "procedure"))
  for (const c of r2.commits) c.apply(state)
  assert.equal(readClaudeLogs({ dir, state, since }).conversations.length, 0)
})

test("turn split in the middle of the answer (stop_reason tool_use): nothing is read before the end of the turn", () => {
  const { dir, proj } = setup()
  const f = join(proj, "mid.jsonl")
  writeFileSync(
    f,
    user("m", "How do we deploy?", 30) +
      assistant("m", "We merge into main.", 29, "end_turn") +
      user("m", "And the rollback?", 3) +
      assistant("m", [{ type: "text", text: "Let me look at the config." }, { type: "tool_use", name: "Read", input: {} }], 2, "tool_use"),
  )
  const state: State = {}
  const since = new Date(now - 24 * 3600_000)
  const r1 = readClaudeLogs({ dir, state, since })
  // The first turn (finished) goes; the second one waits for its end.
  assert.equal(r1.conversations.length, 1)
  assert.deepEqual(r1.conversations[0].messages.map((m) => m.text), ["How do we deploy?", "We merge into main."])
  for (const c of r1.commits) c.apply(state)
  appendFileSync(f, assistant("m", "We use Promote on Vercel.", 1, "end_turn"))
  const r2 = readClaudeLogs({ dir, state, since })
  assert.deepEqual(r2.conversations[0].messages.map((m) => m.text), ["And the rollback?", "Let me look at the config.\n\nWe use Promote on Vercel."])
})

test("completeLineCount: finished turn, turn in progress, turn abandoned long ago", () => {
  const parse = (s: string) => s.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>)
  const done = parse(user("a", "Q", 5) + assistant("a", "R", 4))
  assert.equal(completeLineCount(done, now), 2)
  const waiting = parse(assistant("a", "R0", 9) + user("a", "Q", 5))
  assert.equal(completeLineCount(waiting, now), 1)
  const tool = parse(user("a", "Q", 5) + assistant("a", [{ type: "text", text: "Starting" }], 4, "tool_use"))
  assert.equal(completeLineCount(tool, now), 0)
  const stale = parse(user("a", "Q", 45) + assistant("a", [{ type: "tool_use", name: "Bash", input: {} }], 44, "tool_use"))
  assert.equal(completeLineCount(stale, now), 2)
})

test("install session (magic prompt with the token) or the computer's token: session ignored", () => {
  const { dir, proj } = setup()
  const token = "cb_tqoelDcQG1aiU0jik075v5hdhINhmVhv"
  const install = buildInstallPrompt({ baseUrl: "https://c.example", token, name: "Hugo Bernard", orgName: "Fournil", zones: ["dev"] })
  const f1 = join(proj, "install.jsonl")
  writeFileSync(f1, user("i", install, 10) + assistant("i", `I ran init with your token ${token}. 1. init\n2. hello\n3. hooks`, 9, "end_turn"))
  const f2 = join(proj, "debug.jsonl")
  writeFileSync(f2, user("d", `Why does the brain answer 401 with ${token}?`, 10) + assistant("d", "The token may have been regenerated.", 9, "end_turn"))
  const state: State = {}
  const r = readClaudeLogs({ dir, state, since: new Date(now - 24 * 3600_000), secrets: [token] })
  assert.equal(r.conversations.length, 0)
  assert.equal(r.stats.internal, 2)
  for (const c of r.commits) c.apply(state)
  assert.equal(state.claude?.files[f1].internal, true)
  // The rest of the install session stays ignored.
  appendFileSync(f1, user("i", "Thanks, and now fix the API bug", 2) + assistant("i", "Fixed.", 1, "end_turn"))
  assert.equal(readClaudeLogs({ dir, state, since: new Date(now - 24 * 3600_000), secrets: [token] }).conversations.length, 0)
})
