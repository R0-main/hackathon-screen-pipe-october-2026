import { strict as assert } from "node:assert"
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import type { State } from "../src/config"
import { completeLineCount } from "../src/sources/claude-logs"
import { codexSessionId, completeCodexLineCount, parseCodexLines, readCodexLogs } from "../src/sources/codex-logs"
import { tempDir } from "./helpers"

const now = Date.now()
const ts = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString()
const l = (o: unknown) => JSON.stringify(o) + "\n"
const uuid = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"

test("parseCodexLines: response_item format, environment noise and system roles ignored", () => {
  const lines = [
    { timestamp: ts(20), type: "session_meta", payload: { id: uuid, cwd: "/home/ines/app", timestamp: ts(20) } },
    { timestamp: ts(20), type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "rules" }] } },
    { timestamp: ts(20), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>cwd</environment_context>" }] } },
    { timestamp: ts(19), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Add a CSV export of the invoices" }] } },
    { timestamp: ts(19), type: "event_msg", payload: { type: "user_message", message: "Add a CSV export of the invoices" } },
    { timestamp: ts(18), type: "response_item", payload: { type: "reasoning", summary: [] } },
    { timestamp: ts(18), type: "response_item", payload: { type: "function_call", name: "shell", arguments: "{}" } },
    { timestamp: ts(17), type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done: we go with papaparse." }] } },
  ]
  const { conversation } = parseCodexLines(lines, { fallbackId: "codex:x" })
  assert.ok(conversation)
  assert.equal(conversation.tool, "codex")
  assert.equal(conversation.cwd, "/home/ines/app")
  assert.deepEqual(
    conversation.messages.map((m) => [m.role, m.text]),
    [
      ["user", "Add a CSV export of the invoices"],
      ["assistant", "Done: we go with papaparse."],
    ],
  )
})

test("parseCodexLines: old format and generic role + content lines", () => {
  const lines = [
    { id: uuid, timestamp: ts(30), instructions: null },
    { type: "message", role: "user", content: [{ type: "input_text", text: "Explain the VAT module" }] },
    { record_type: "state" },
    { role: "assistant", content: "The module computes the VAT per rate." },
  ]
  const { conversation } = parseCodexLines(lines, { fallbackId: "codex:y" })
  assert.equal(conversation?.messages.length, 2)
  assert.equal(conversation?.messages[1].text, "The module computes the VAT per rate.")
})

test("parseCodexLines: falls back on event_msg if there is no response_item", () => {
  const lines = [
    { timestamp: ts(5), type: "event_msg", payload: { type: "user_message", message: "Why does the build break?" } },
    { timestamp: ts(4), type: "event_msg", payload: { type: "agent_message", message: "A missing dependency." } },
  ]
  assert.equal(parseCodexLines(lines, { fallbackId: "z" }).conversation?.messages.length, 2)
})

test("readCodexLogs: offsets per file and stable id", () => {
  const dir = tempDir()
  const day = join(dir, "sessions", "2026", "10", "16")
  mkdirSync(day, { recursive: true })
  const f = join(day, `rollout-2026-10-16T09-00-00-${uuid}.jsonl`)
  writeFileSync(
    f,
    l({ timestamp: ts(10), type: "session_meta", payload: { id: uuid, cwd: "/w" } }) +
      l({ timestamp: ts(9), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Question 1" }] } }) +
      l({ timestamp: ts(8), type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Answer 1" }] } }),
  )
  assert.equal(codexSessionId(f), `codex:${uuid}`)
  const state: State = {}
  const since = new Date(now - 3600_000)
  const r1 = readCodexLogs({ dir, state, since })
  assert.equal(r1.conversations.length, 1)
  assert.equal(r1.conversations[0].id, `codex:${uuid}`)
  for (const c of r1.commits) c.apply(state)
  assert.equal(readCodexLogs({ dir, state, since }).conversations.length, 0)
  appendFileSync(f, l({ timestamp: ts(2), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Question 2" }] } }))
  // Unanswered question, still recent: turn in progress, left for the next run.
  const r3 = readCodexLogs({ dir, state, since })
  assert.equal(r3.conversations.length, 0)
  assert.equal(r3.stats.pending, 1)
  for (const c of r3.commits) c.apply(state)
  appendFileSync(f, l({ timestamp: ts(1), type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Answer 2" }] } }))
  const r4 = readCodexLogs({ dir, state, since })
  assert.deepEqual(r4.conversations[0].messages.map((m) => m.text), ["Question 2", "Answer 2"])
})

/** Recent Codex rollout: session, then a turn (question, tool calls…). */
function rollout(dir: string, lines: unknown[]) {
  const day = join(dir, "sessions", "2026", "10", "16")
  mkdirSync(day, { recursive: true })
  const f = join(day, `rollout-2026-10-16T10-00-00-${uuid}.jsonl`)
  writeFileSync(f, lines.map((o) => l(o)).join(""))
  return f
}
const userMsg = (text: string, minAgo: number) => [
  { timestamp: ts(minAgo), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } },
  { timestamp: ts(minAgo), type: "event_msg", payload: { type: "user_message", message: text } },
]
const agentMsg = (text: string, minAgo: number) => ({ timestamp: ts(minAgo), type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] } })
const call = (minAgo: number) => ({ timestamp: ts(minAgo), type: "response_item", payload: { type: "function_call", name: "shell", arguments: "{}", call_id: "c" } })
const callOut = (minAgo: number) => ({ timestamp: ts(minAgo), type: "response_item", payload: { type: "function_call_output", call_id: "c", output: "ok" } })

test("CLIENT-6b: a Codex turn split between two syncs is read in full (question + final answer)", () => {
  const dir = tempDir()
  const f = rollout(dir, [
    { timestamp: ts(6), type: "session_meta", payload: { id: uuid, cwd: "/home/ines/app" } },
    ...userMsg("Do we keep Qonto for the cash?", 5),
    agentMsg("Let me look at the statements.", 5),
    call(4),
    callOut(4),
  ])
  const state: State = {}
  const since = new Date(now - 3600_000)
  // 1st run in the middle of a turn (the agent waits for a tool): nothing is read, the offset does not move.
  const r1 = readCodexLogs({ dir, state, since })
  assert.equal(r1.conversations.length, 0)
  assert.equal(r1.stats.pending, 1)
  for (const c of r1.commits) c.apply(state)
  // The offset stops at the start of the turn (after the session_meta line).
  assert.equal(state.codex?.files[f]?.offset, Buffer.byteLength(readFileSync(f, "utf8").split("\n")[0] + "\n"))
  // The final answer arrives: the whole turn (question included) is read.
  appendFileSync(f, l(agentMsg("Decision: we keep Qonto for the cash.", 2)) + l({ timestamp: ts(2), type: "event_msg", payload: { type: "token_count" } }))
  const r2 = readCodexLogs({ dir, state, since })
  assert.equal(r2.stats.pending, 0)
  assert.deepEqual(
    r2.conversations[0].messages.map((m) => m.role),
    ["user", "assistant"],
  )
  assert.match(r2.conversations[0].messages[0].text, /Do we keep Qonto/)
  assert.match(r2.conversations[0].messages[1].text, /Decision: we keep Qonto/)
  for (const c of r2.commits) c.apply(state)
  assert.equal(readCodexLogs({ dir, state, since }).conversations.length, 0)
})

test("completeCodexLineCount: explicit end of turn, abandoned turn, previous turns kept", () => {
  const head = [{ timestamp: ts(30), type: "session_meta", payload: { id: uuid } }, ...userMsg("Question 1", 29), agentMsg("Answer 1", 28)]
  const pendingTurn = [...userMsg("Question 2", 3), call(2)]
  // Finished turns are kept, the turn in progress (2) is held back from its question on.
  assert.equal(completeCodexLineCount([...head, ...pendingTurn], now), head.length)
  // task_complete closes the turn, even without a message from the agent.
  assert.equal(completeCodexLineCount([...head, ...pendingTurn, { timestamp: ts(1), type: "event_msg", payload: { type: "task_complete" } }], now), head.length + pendingTurn.length + 1)
  // No activity for 30 min: abandoned turn, read as is.
  const stale = [...head, ...userMsg("Question 2", 45), call(44)]
  assert.equal(completeCodexLineCount(stale, now), stale.length)
  // Old format without timestamps: read as is.
  const old = [{ type: "message", role: "user", content: "Q" }]
  assert.equal(completeCodexLineCount(old, now), 1)
  // Agent message then tool call: not finished yet.
  assert.equal(completeCodexLineCount([...head, ...userMsg("Question 3", 3), agentMsg("Running the tests.", 2), call(2), callOut(1)], now), head.length)
})

test("CODEX-TURN: the end of a previous turn (interrupted or finished without an answer) does not close the turn in progress", () => {
  const head = [{ timestamp: ts(30), type: "session_meta", payload: { id: uuid } }]
  const end = (type: string, minAgo: number) => ({ timestamp: ts(minAgo), type: "event_msg", payload: { type } })
  const reasoning = (minAgo: number) => ({ timestamp: ts(minAgo), type: "response_item", payload: { type: "reasoning", summary: [] } })
  // q1 interrupted without an answer (turn_aborted), then q2 still in progress: q2 is held back from its question on.
  const aborted = [...head, ...userMsg("Question 1", 10), reasoning(9), end("turn_aborted", 8)]
  assert.equal(completeCodexLineCount([...aborted, ...userMsg("Question 2", 3), call(2)], now), aborted.length)
  // Same thing without reasoning between q1 and the interruption.
  const abortedBare = [...head, ...userMsg("Question 1", 10), end("turn_aborted", 8)]
  assert.equal(completeCodexLineCount([...abortedBare, ...userMsg("Question 2", 3), reasoning(2)], now), abortedBare.length)
  // q1 finished by task_complete without a message from the agent, then q2 in progress.
  const completed = [...head, ...userMsg("Question 1", 20), call(19), end("task_complete", 19)]
  assert.equal(completeCodexLineCount([...completed, ...userMsg("Question 2", 3), call(2)], now), completed.length)
  // The end of turn of q2 does close it.
  assert.equal(completeCodexLineCount([...aborted, ...userMsg("Question 2", 3), call(2), end("task_complete", 1)], now), aborted.length + 4)
})

test("CODEX-TURN: q1, tool, interruption, q2 in progress → q2 read in full on the next run (as for Claude Code)", () => {
  const dir = tempDir()
  const f = rollout(dir, [
    { timestamp: ts(12), type: "session_meta", payload: { id: uuid, cwd: "/home/ines/app" } },
    ...userMsg("QZXq1 Add the CSV export", 10),
    call(9),
    { timestamp: ts(8), type: "event_msg", payload: { type: "turn_aborted", reason: "interrupted" } },
    ...userMsg("QZXq2 An Excel export instead", 3),
    { timestamp: ts(2), type: "response_item", payload: { type: "reasoning", summary: [] } },
  ])
  const state: State = {}
  const since = new Date(now - 3600_000)
  const r1 = readCodexLogs({ dir, state, since })
  assert.equal(r1.stats.pending, 1)
  assert.deepEqual(r1.conversations.map((c) => c.messages.map((m) => m.text)), [["QZXq1 Add the CSV export"]])
  for (const c of r1.commits) c.apply(state)
  appendFileSync(f, l(agentMsg("QZXq2 Decision: Excel export with exceljs.", 1)) + l({ timestamp: ts(1), type: "event_msg", payload: { type: "task_complete" } }))
  const r2 = readCodexLogs({ dir, state, since })
  assert.equal(r2.stats.pending, 0)
  assert.deepEqual(
    r2.conversations[0].messages.map((m) => [m.role, m.text]),
    [
      ["user", "QZXq2 An Excel export instead"],
      ["assistant", "QZXq2 Decision: Excel export with exceljs."],
    ],
  )

  // Parity with the Claude Code reader on the same transcript (q1, tool_use, interruption, q2 in progress).
  const at = (m: number) => new Date(now - m * 60_000).toISOString()
  const claudeLines = [
    { type: "user", sessionId: "s", timestamp: at(10), message: { role: "user", content: "QZXq1 Add the CSV export" } },
    { type: "assistant", sessionId: "s", timestamp: at(9), message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: {} }], stop_reason: "tool_use" } },
    { type: "user", sessionId: "s", timestamp: at(8), message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user for tool use]" }] } },
    { type: "user", sessionId: "s", timestamp: at(3), message: { role: "user", content: "QZXq2 An Excel export instead" } },
  ]
  assert.equal(completeLineCount(claudeLines, now), 3)
})

test("R-STEER: a message added while a Codex turn is working does not split the turn: q1 is never sent without its answer", () => {
  const dir = tempDir()
  const reasoning = (minAgo: number) => ({ timestamp: ts(minAgo), type: "response_item", payload: { type: "reasoning", summary: [] } })
  const f = rollout(dir, [
    { timestamp: ts(6), type: "session_meta", payload: { id: uuid, cwd: "/home/ines/app" } },
    ...userMsg("QZXh1 Add the CSV export of the invoices", 5),
    reasoning(5),
    call(4),
    callOut(4),
    ...userMsg("QZXh2 Detail: semicolon separator", 2),
    reasoning(1),
  ])
  const state: State = {}
  const since = new Date(now - 3600_000)
  // The turn (q1 + detail) has no answer yet: everything is held back, the offset does not go past q1.
  const r1 = readCodexLogs({ dir, state, since })
  assert.equal(r1.stats.pending, 1)
  assert.equal(r1.conversations.length, 0)
  for (const c of r1.commits) c.apply(state)
  appendFileSync(f, l(agentMsg("QZXh Decision: CSV export with semicolons.", 0)) + l({ timestamp: ts(0), type: "event_msg", payload: { type: "task_complete" } }))
  const r2 = readCodexLogs({ dir, state, since })
  assert.equal(r2.stats.pending, 0)
  const texts = r2.conversations.flatMap((c) => c.messages.map((m) => `${m.role}:${m.text}`)).join("\n")
  assert.match(texts, /user:QZXh1 Add the CSV export of the invoices/)
  assert.match(texts, /QZXh2 Detail/)
  assert.match(texts, /assistant:QZXh Decision/)

  // Ends of turn still split: turn_aborted event, or its "<turn_aborted>" trace in the history.
  const head = [{ timestamp: ts(30), type: "session_meta", payload: { id: uuid } }]
  const noise = { timestamp: ts(8), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<turn_aborted>\nThe user interrupted\n</turn_aborted>" }] } }
  const abortedByNoise = [...head, ...userMsg("Question 1", 10), reasoning(9), noise]
  assert.equal(completeCodexLineCount([...abortedByNoise, ...userMsg("Question 2", 3), reasoning(2)], now), abortedByNoise.length)
})
