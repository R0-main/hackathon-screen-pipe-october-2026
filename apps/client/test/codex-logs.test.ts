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

test("parseCodexLines : format response_item, bruit d'environnement et rôles système ignorés", () => {
  const lines = [
    { timestamp: ts(20), type: "session_meta", payload: { id: uuid, cwd: "/home/ines/app", timestamp: ts(20) } },
    { timestamp: ts(20), type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "règles" }] } },
    { timestamp: ts(20), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>cwd</environment_context>" }] } },
    { timestamp: ts(19), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Ajoute un export CSV des factures" }] } },
    { timestamp: ts(19), type: "event_msg", payload: { type: "user_message", message: "Ajoute un export CSV des factures" } },
    { timestamp: ts(18), type: "response_item", payload: { type: "reasoning", summary: [] } },
    { timestamp: ts(18), type: "response_item", payload: { type: "function_call", name: "shell", arguments: "{}" } },
    { timestamp: ts(17), type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "C'est fait : on part sur papaparse." }] } },
  ]
  const { conversation } = parseCodexLines(lines, { fallbackId: "codex:x" })
  assert.ok(conversation)
  assert.equal(conversation.tool, "codex")
  assert.equal(conversation.cwd, "/home/ines/app")
  assert.deepEqual(
    conversation.messages.map((m) => [m.role, m.text]),
    [
      ["user", "Ajoute un export CSV des factures"],
      ["assistant", "C'est fait : on part sur papaparse."],
    ],
  )
})

test("parseCodexLines : ancien format et lignes génériques role + content", () => {
  const lines = [
    { id: uuid, timestamp: ts(30), instructions: null },
    { type: "message", role: "user", content: [{ type: "input_text", text: "Explique le module de TVA" }] },
    { record_type: "state" },
    { role: "assistant", content: "Le module calcule la TVA par taux." },
  ]
  const { conversation } = parseCodexLines(lines, { fallbackId: "codex:y" })
  assert.equal(conversation?.messages.length, 2)
  assert.equal(conversation?.messages[1].text, "Le module calcule la TVA par taux.")
})

test("parseCodexLines : repli sur event_msg si aucun response_item", () => {
  const lines = [
    { timestamp: ts(5), type: "event_msg", payload: { type: "user_message", message: "Pourquoi le build casse ?" } },
    { timestamp: ts(4), type: "event_msg", payload: { type: "agent_message", message: "Une dépendance manquante." } },
  ]
  assert.equal(parseCodexLines(lines, { fallbackId: "z" }).conversation?.messages.length, 2)
})

test("readCodexLogs : offsets par fichier et identifiant stable", () => {
  const dir = tempDir()
  const day = join(dir, "sessions", "2026", "10", "16")
  mkdirSync(day, { recursive: true })
  const f = join(day, `rollout-2026-10-16T09-00-00-${uuid}.jsonl`)
  writeFileSync(
    f,
    l({ timestamp: ts(10), type: "session_meta", payload: { id: uuid, cwd: "/w" } }) +
      l({ timestamp: ts(9), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Question 1" }] } }) +
      l({ timestamp: ts(8), type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Réponse 1" }] } }),
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
  // Question sans réponse, encore récente : tour en cours, laissé pour le prochain passage.
  const r3 = readCodexLogs({ dir, state, since })
  assert.equal(r3.conversations.length, 0)
  assert.equal(r3.stats.pending, 1)
  for (const c of r3.commits) c.apply(state)
  appendFileSync(f, l({ timestamp: ts(1), type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Réponse 2" }] } }))
  const r4 = readCodexLogs({ dir, state, since })
  assert.deepEqual(r4.conversations[0].messages.map((m) => m.text), ["Question 2", "Réponse 2"])
})

/** Rollout Codex récent : session, puis un tour (question, appels d'outils…). */
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

test("CLIENT-6b : un tour Codex coupé entre deux synchros est lu en entier (question + réponse finale)", () => {
  const dir = tempDir()
  const f = rollout(dir, [
    { timestamp: ts(6), type: "session_meta", payload: { id: uuid, cwd: "/home/ines/app" } },
    ...userMsg("On garde Qonto pour la trésorerie ?", 5),
    agentMsg("Je regarde les relevés.", 5),
    call(4),
    callOut(4),
  ])
  const state: State = {}
  const since = new Date(now - 3600_000)
  // 1er passage en plein tour (l'agent attend un outil) : rien n'est lu, l'offset ne bouge pas.
  const r1 = readCodexLogs({ dir, state, since })
  assert.equal(r1.conversations.length, 0)
  assert.equal(r1.stats.pending, 1)
  for (const c of r1.commits) c.apply(state)
  // L'offset s'arrête au début du tour (après la ligne session_meta).
  assert.equal(state.codex?.files[f]?.offset, Buffer.byteLength(readFileSync(f, "utf8").split("\n")[0] + "\n"))
  // La réponse finale arrive : le tour complet (question comprise) est lu.
  appendFileSync(f, l(agentMsg("Décision : on garde Qonto pour la trésorerie.", 2)) + l({ timestamp: ts(2), type: "event_msg", payload: { type: "token_count" } }))
  const r2 = readCodexLogs({ dir, state, since })
  assert.equal(r2.stats.pending, 0)
  assert.deepEqual(
    r2.conversations[0].messages.map((m) => m.role),
    ["user", "assistant"],
  )
  assert.match(r2.conversations[0].messages[0].text, /On garde Qonto/)
  assert.match(r2.conversations[0].messages[1].text, /Décision : on garde Qonto/)
  for (const c of r2.commits) c.apply(state)
  assert.equal(readCodexLogs({ dir, state, since }).conversations.length, 0)
})

test("completeCodexLineCount : fin de tour explicite, tour abandonné, tours précédents gardés", () => {
  const head = [{ timestamp: ts(30), type: "session_meta", payload: { id: uuid } }, ...userMsg("Question 1", 29), agentMsg("Réponse 1", 28)]
  const pendingTurn = [...userMsg("Question 2", 3), call(2)]
  // Les tours finis sont gardés, le tour en cours (2) est retenu à partir de sa question.
  assert.equal(completeCodexLineCount([...head, ...pendingTurn], now), head.length)
  // task_complete clôt le tour, même sans message de l'agent.
  assert.equal(completeCodexLineCount([...head, ...pendingTurn, { timestamp: ts(1), type: "event_msg", payload: { type: "task_complete" } }], now), head.length + pendingTurn.length + 1)
  // Plus d'activité depuis 30 min : tour abandonné, lu tel quel.
  const stale = [...head, ...userMsg("Question 2", 45), call(44)]
  assert.equal(completeCodexLineCount(stale, now), stale.length)
  // Ancien format sans horodatage : lu tel quel.
  const old = [{ type: "message", role: "user", content: "Q" }]
  assert.equal(completeCodexLineCount(old, now), 1)
  // Message de l'agent puis appel d'outil : pas encore fini.
  assert.equal(completeCodexLineCount([...head, ...userMsg("Question 3", 3), agentMsg("Je lance les tests.", 2), call(2), callOut(1)], now), head.length)
})

test("CODEX-TURN : la fin d'un tour précédent (interrompu ou fini sans réponse) ne clôt pas le tour en cours", () => {
  const head = [{ timestamp: ts(30), type: "session_meta", payload: { id: uuid } }]
  const end = (type: string, minAgo: number) => ({ timestamp: ts(minAgo), type: "event_msg", payload: { type } })
  const reasoning = (minAgo: number) => ({ timestamp: ts(minAgo), type: "response_item", payload: { type: "reasoning", summary: [] } })
  // q1 interrompue sans réponse (turn_aborted), puis q2 encore en cours : q2 est retenue à partir de sa question.
  const aborted = [...head, ...userMsg("Question 1", 10), reasoning(9), end("turn_aborted", 8)]
  assert.equal(completeCodexLineCount([...aborted, ...userMsg("Question 2", 3), call(2)], now), aborted.length)
  // Même chose sans raisonnement entre q1 et l'interruption.
  const abortedBare = [...head, ...userMsg("Question 1", 10), end("turn_aborted", 8)]
  assert.equal(completeCodexLineCount([...abortedBare, ...userMsg("Question 2", 3), reasoning(2)], now), abortedBare.length)
  // q1 finie par task_complete sans message de l'agent, puis q2 en cours.
  const completed = [...head, ...userMsg("Question 1", 20), call(19), end("task_complete", 19)]
  assert.equal(completeCodexLineCount([...completed, ...userMsg("Question 2", 3), call(2)], now), completed.length)
  // La fin de tour de q2 la clôt bien.
  assert.equal(completeCodexLineCount([...aborted, ...userMsg("Question 2", 3), call(2), end("task_complete", 1)], now), aborted.length + 4)
})

test("CODEX-TURN : q1, outil, interruption, q2 en cours → q2 lue en entier au passage suivant (comme pour Claude Code)", () => {
  const dir = tempDir()
  const f = rollout(dir, [
    { timestamp: ts(12), type: "session_meta", payload: { id: uuid, cwd: "/home/ines/app" } },
    ...userMsg("QZXq1 Ajoute l'export CSV", 10),
    call(9),
    { timestamp: ts(8), type: "event_msg", payload: { type: "turn_aborted", reason: "interrupted" } },
    ...userMsg("QZXq2 Plutôt un export Excel", 3),
    { timestamp: ts(2), type: "response_item", payload: { type: "reasoning", summary: [] } },
  ])
  const state: State = {}
  const since = new Date(now - 3600_000)
  const r1 = readCodexLogs({ dir, state, since })
  assert.equal(r1.stats.pending, 1)
  assert.deepEqual(r1.conversations.map((c) => c.messages.map((m) => m.text)), [["QZXq1 Ajoute l'export CSV"]])
  for (const c of r1.commits) c.apply(state)
  appendFileSync(f, l(agentMsg("QZXq2 Décision : export Excel avec exceljs.", 1)) + l({ timestamp: ts(1), type: "event_msg", payload: { type: "task_complete" } }))
  const r2 = readCodexLogs({ dir, state, since })
  assert.equal(r2.stats.pending, 0)
  assert.deepEqual(
    r2.conversations[0].messages.map((m) => [m.role, m.text]),
    [
      ["user", "QZXq2 Plutôt un export Excel"],
      ["assistant", "QZXq2 Décision : export Excel avec exceljs."],
    ],
  )

  // Parité avec le lecteur Claude Code sur le transcript équivalent (q1, tool_use, interruption, q2 en cours).
  const at = (m: number) => new Date(now - m * 60_000).toISOString()
  const claudeLines = [
    { type: "user", sessionId: "s", timestamp: at(10), message: { role: "user", content: "QZXq1 Ajoute l'export CSV" } },
    { type: "assistant", sessionId: "s", timestamp: at(9), message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: {} }], stop_reason: "tool_use" } },
    { type: "user", sessionId: "s", timestamp: at(8), message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user for tool use]" }] } },
    { type: "user", sessionId: "s", timestamp: at(3), message: { role: "user", content: "QZXq2 Plutôt un export Excel" } },
  ]
  assert.equal(completeLineCount(claudeLines, now), 3)
})
