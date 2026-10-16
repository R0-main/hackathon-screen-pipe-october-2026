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

test("tour coupé entre deux synchros : l'offset s'arrête avant la question sans réponse, puis le tour entier est lu", () => {
  const { dir, proj } = setup()
  const f = join(proj, "turn.jsonl")
  // Synchro 1 : la question est écrite, l'assistant n'a encore produit qu'un appel d'outil.
  writeFileSync(
    f,
    user("t", "On a décidé de garder Qonto pour la tréso. Comment on rapproche les relevés ?", 3) +
      assistant("t", [{ type: "tool_use", name: "Read", input: {} }], 2, "tool_use") +
      user("t", [{ type: "tool_result", tool_use_id: "x", content: "relevé" }], 2),
  )
  const state: State = {}
  const since = new Date(now - 24 * 3600_000)
  const r1 = readClaudeLogs({ dir, state, since })
  assert.equal(r1.conversations.length, 0)
  assert.equal(r1.stats.pending, 1)
  for (const c of r1.commits) c.apply(state)
  assert.equal(state.claude?.files[f], undefined, "aucun checkpoint au-delà du tour en cours")

  // Synchro 2 : la réponse finale est écrite → le tour complet (question + réponse) est lu et distillé.
  appendFileSync(
    f,
    assistant("t", [{ type: "text", text: "Décision : on garde Qonto pour la trésorerie.\n1. Exporter les relevés Qonto\n2. Les importer dans Pennylane\n3. Lettrer les écritures" }], 1, "end_turn"),
  )
  const r2 = readClaudeLogs({ dir, state, since })
  assert.equal(r2.conversations.length, 1)
  const conv = r2.conversations[0]
  assert.deepEqual(conv.messages.map((m) => m.role), ["user", "assistant"])
  assert.match(conv.messages[0].text, /garder Qonto/)
  const items = distillHeuristic(conv, TEST_ZONES)
  assert.ok(items.some((i) => i.kind === "decision"), JSON.stringify(items.map((i) => i.title)))
  assert.ok(items.some((i) => i.kind === "procedure"))
  for (const c of r2.commits) c.apply(state)
  assert.equal(readClaudeLogs({ dir, state, since }).conversations.length, 0)
})

test("tour coupé au milieu de la réponse (stop_reason tool_use) : rien n'est lu avant la fin du tour", () => {
  const { dir, proj } = setup()
  const f = join(proj, "mid.jsonl")
  writeFileSync(
    f,
    user("m", "Comment on déploie ?", 30) +
      assistant("m", "On merge sur main.", 29, "end_turn") +
      user("m", "Et le rollback ?", 3) +
      assistant("m", [{ type: "text", text: "Je regarde la config." }, { type: "tool_use", name: "Read", input: {} }], 2, "tool_use"),
  )
  const state: State = {}
  const since = new Date(now - 24 * 3600_000)
  const r1 = readClaudeLogs({ dir, state, since })
  // Le premier tour (fini) part ; le second attend sa fin.
  assert.equal(r1.conversations.length, 1)
  assert.deepEqual(r1.conversations[0].messages.map((m) => m.text), ["Comment on déploie ?", "On merge sur main."])
  for (const c of r1.commits) c.apply(state)
  appendFileSync(f, assistant("m", "On utilise Promote sur Vercel.", 1, "end_turn"))
  const r2 = readClaudeLogs({ dir, state, since })
  assert.deepEqual(r2.conversations[0].messages.map((m) => m.text), ["Et le rollback ?", "Je regarde la config.\n\nOn utilise Promote sur Vercel."])
})

test("completeLineCount : tour fini, tour en cours, tour abandonné depuis longtemps", () => {
  const parse = (s: string) => s.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>)
  const done = parse(user("a", "Q", 5) + assistant("a", "R", 4))
  assert.equal(completeLineCount(done, now), 2)
  const waiting = parse(assistant("a", "R0", 9) + user("a", "Q", 5))
  assert.equal(completeLineCount(waiting, now), 1)
  const tool = parse(user("a", "Q", 5) + assistant("a", [{ type: "text", text: "Je lance" }], 4, "tool_use"))
  assert.equal(completeLineCount(tool, now), 0)
  const stale = parse(user("a", "Q", 45) + assistant("a", [{ type: "tool_use", name: "Bash", input: {} }], 44, "tool_use"))
  assert.equal(completeLineCount(stale, now), 2)
})

test("session d'installation (prompt magique avec le jeton) ou jeton du poste : session ignorée", () => {
  const { dir, proj } = setup()
  const token = "cb_tqoelDcQG1aiU0jik075v5hdhINhmVhv"
  const install = buildInstallPrompt({ baseUrl: "https://c.example", token, name: "Hugo Bernard", orgName: "Fournil", zones: ["dev"] })
  const f1 = join(proj, "install.jsonl")
  writeFileSync(f1, user("i", install, 10) + assistant("i", `J'ai lancé init avec ton jeton ${token}. 1. init\n2. hello\n3. hooks`, 9, "end_turn"))
  const f2 = join(proj, "debug.jsonl")
  writeFileSync(f2, user("d", `Pourquoi le cerveau répond 401 avec ${token} ?`, 10) + assistant("d", "Le jeton a peut-être été régénéré.", 9, "end_turn"))
  const state: State = {}
  const r = readClaudeLogs({ dir, state, since: new Date(now - 24 * 3600_000), secrets: [token] })
  assert.equal(r.conversations.length, 0)
  assert.equal(r.stats.internal, 2)
  for (const c of r.commits) c.apply(state)
  assert.equal(state.claude?.files[f1].internal, true)
  // La suite de la session d'installation reste ignorée.
  appendFileSync(f1, user("i", "Merci, et maintenant corrige le bug de l'API", 2) + assistant("i", "Corrigé.", 1, "end_turn"))
  assert.equal(readClaudeLogs({ dir, state, since: new Date(now - 24 * 3600_000), secrets: [token] }).conversations.length, 0)
})
