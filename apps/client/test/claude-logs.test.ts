import { strict as assert } from "node:assert"
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import { DISTILL_MARKER } from "@brain/core"
import type { State } from "../src/config"
import { parseClaudeLine, readClaudeLogs } from "../src/sources/claude-logs"
import { readNewLines } from "../src/sources/jsonl"
import { tempDir } from "./helpers"

const now = Date.now()
const ts = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString()

function line(o: unknown) {
  return JSON.stringify(o) + "\n"
}

function user(sessionId: string, content: unknown, minAgo: number, extra: Record<string, unknown> = {}) {
  return line({ type: "user", sessionId, cwd: "/home/hugo/fournil", timestamp: ts(minAgo), message: { role: "user", content }, ...extra })
}

function assistant(sessionId: string, content: unknown, minAgo: number) {
  return line({ type: "assistant", sessionId, cwd: "/home/hugo/fournil", timestamp: ts(minAgo), message: { role: "assistant", content } })
}

function setup() {
  const dir = tempDir()
  const proj = join(dir, "projects", "-home-hugo-fournil")
  mkdirSync(proj, { recursive: true })
  return { dir, proj }
}

test("parseClaudeLine : contenu texte, blocs, tool_result et méta ignorés", () => {
  assert.equal(parseClaudeLine({ type: "user", message: { role: "user", content: "Bonjour" } })?.text, "Bonjour")
  const blocks = parseClaudeLine({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "Voici" }, { type: "tool_use", name: "Bash", input: {} }] },
  })
  assert.equal(blocks?.text, "Voici")
  assert.equal(parseClaudeLine({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "sortie" }] } }), null)
  assert.equal(parseClaudeLine({ type: "user", isMeta: true, message: { role: "user", content: "skill" } }), null)
  assert.equal(parseClaudeLine({ type: "user", message: { role: "user", content: "<command-name>/clear</command-name>" } }), null)
  assert.equal(
    parseClaudeLine({ type: "user", message: { role: "user", content: "Fais ça<system-reminder>bruit</system-reminder>" } })?.text,
    "Fais ça",
  )
  assert.equal(parseClaudeLine({ type: "attachment" }), null)
})

test("readClaudeLogs : regroupe par session, fusionne l'assistant, ignore DISTILL_MARKER, reprend à l'offset", () => {
  const { dir, proj } = setup()
  const f1 = join(proj, "s1.jsonl")
  writeFileSync(
    f1,
    user("s1", "Comment on déploie en production ?", 30) +
      assistant("s1", [{ type: "text", text: "Je regarde." }, { type: "tool_use", name: "Read", input: {} }], 29) +
      user("s1", [{ type: "tool_result", tool_use_id: "x", content: "fichier" }], 29) +
      assistant("s1", [{ type: "text", text: "1. Merger\n2. Tagger\n3. Surveiller" }], 28) +
      user("s1", "Vieux message", 60 * 48), // hors fenêtre
  )
  const f2 = join(proj, "internal.jsonl")
  writeFileSync(f2, user("s2", `${DISTILL_MARKER}\nTu alimentes…`, 10) + assistant("s2", '{"items":[]}', 9))

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
  assert.match(c.messages[1].text, /Je regarde\.\n\n1\. Merger/)
  assert.equal(r1.stats.internal, 1)

  // Application des checkpoints puis ajout de nouvelles lignes : seules les nouvelles sont lues.
  for (const cm of r1.commits) cm.apply(state)
  assert.equal(state.claude?.files[f2].internal, true)
  const r2 = readClaudeLogs({ dir, state, since })
  assert.equal(r2.conversations.length, 0)

  appendFileSync(f1, user("s1", "Et pour le rollback ?", 5) + assistant("s1", "On utilise Promote sur Vercel.", 4))
  appendFileSync(f2, assistant("s2", "suite interne", 3))
  const r3 = readClaudeLogs({ dir, state, since })
  assert.equal(r3.conversations.length, 1)
  assert.equal(r3.conversations[0].messages.length, 2)
  assert.equal(r3.conversations[0].messages[0].text, "Et pour le rollback ?")
})

test("readNewLines : ligne incomplète laissée pour plus tard, fichier tronqué relu depuis 0", () => {
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
