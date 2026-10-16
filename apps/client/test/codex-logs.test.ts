import { strict as assert } from "node:assert"
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import type { State } from "../src/config"
import { codexSessionId, parseCodexLines, readCodexLogs } from "../src/sources/codex-logs"
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
  const r3 = readCodexLogs({ dir, state, since })
  assert.deepEqual(r3.conversations[0].messages.map((m) => m.text), ["Question 2"])
})
