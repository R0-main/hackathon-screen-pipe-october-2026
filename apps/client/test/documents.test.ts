import { strict as assert } from "node:assert"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import { documentCandidate, documentPathsInCodexLine, documentPathsInText } from "../src/documents"
import { documentPathsOfLine, parseClaudeLines } from "../src/sources/claude-logs"
import { runSync } from "../src/sync"
import { tempDir } from "./helpers"
import { mockBrain } from "./mock-brain"

const ts = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString()
const line = (o: unknown) => JSON.stringify(o) + "\n"

function capture() {
  const out: string[] = []
  return { io: { log: (s: string) => out.push(s), warn: (s: string) => out.push(s) }, text: () => out.join("\n") }
}

test("paths in a message: dropped in a terminal, quoted, @mention, relative; never another format", () => {
  const home = "/home/jm"
  const text =
    "Summarize /home/jm/Downloads/Revenus\\ T3\\ 2026.pdf and \"/home/jm/Documents/Budget 2027.xlsx\", then @reports/q3.docx " +
    "(see ~/Desktop/plan.pptx). Not notes.md, nor /tmp/x.pdf.bak, nor script.py."
  assert.deepEqual(documentPathsInText(text, "/home/jm/work", home).sort(), [
    "/home/jm/Desktop/plan.pptx",
    "/home/jm/Documents/Budget 2027.xlsx",
    "/home/jm/Downloads/Revenus T3 2026.pdf",
    "/home/jm/work/reports/q3.docx",
  ])
})

test("Claude Code: the files its tools open and those of the prompt, never a command's output", () => {
  const read = { type: "assistant", cwd: "/home/jm/w", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "/home/jm/Downloads/revenus-T3.pdf" } }] } }
  const code = { type: "assistant", cwd: "/home/jm/w", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "/home/jm/w/src/app.ts" } }] } }
  const bash = { type: "assistant", cwd: "/home/jm/w", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "pdftotext data/budget.pdf -" } }] } }
  const stdout = { type: "user", cwd: "/home/jm/w", message: { content: "<bash-stdout>a.pdf\nb.pdf</bash-stdout>" } }
  const reminder = { type: "user", cwd: "/home/jm/w", message: { content: [{ type: "text", text: "<system-reminder>/home/jm/old.pdf changed</system-reminder>Look at contract.docx" }] } }
  assert.deepEqual(documentPathsOfLine(read), ["/home/jm/Downloads/revenus-T3.pdf"])
  assert.deepEqual(documentPathsOfLine(code), [])
  assert.deepEqual(documentPathsOfLine(bash), ["/home/jm/w/data/budget.pdf"])
  assert.deepEqual(documentPathsOfLine(stdout), [])
  assert.deepEqual(documentPathsOfLine(reminder), ["/home/jm/w/contract.docx"])

  const { conversations } = parseClaudeLines(
    [
      { type: "user", sessionId: "s", cwd: "/home/jm/w", timestamp: ts(5), message: { role: "user", content: "What was the Q3 revenue?" } },
      { ...read, sessionId: "s", timestamp: ts(4) },
      { type: "assistant", sessionId: "s", cwd: "/home/jm/w", timestamp: ts(3), message: { role: "assistant", content: [{ type: "text", text: "Q3 revenue was €1.86M." }] } },
    ],
    { fallbackId: "f" },
  )
  assert.deepEqual(conversations[0].documents, ["/home/jm/Downloads/revenus-T3.pdf"])
})

test("Codex: the files a command opens", () => {
  const call = {
    type: "response_item",
    payload: { type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["bash", "-lc", "pdftotext \"Revenus T3.pdf\" - | head"], workdir: "/home/jm/finance" }) },
  }
  assert.deepEqual(documentPathsInCodexLine(call, "/home/jm"), ["/home/jm/finance/Revenus T3.pdf"])
  assert.deepEqual(documentPathsInCodexLine({ type: "response_item", payload: { type: "message", role: "assistant", content: "report.pdf" } }), [])
})

test("candidates: only real files of the home folder, never a hidden or application folder, 3 MB at most", () => {
  const home = tempDir()
  const ok = join(home, "Documents", "q3.pdf")
  const hidden = join(home, ".config", "x.pdf")
  const lib = join(home, "Library", "Caches", "y.pdf")
  const cloud = join(home, "Library", "CloudStorage", "GoogleDrive", "z.pdf")
  for (const f of [ok, hidden, lib, cloud]) {
    mkdirSync(join(f, ".."), { recursive: true })
    writeFileSync(f, "%PDF-1.4 test")
  }
  const big = join(home, "Documents", "big.pdf")
  writeFileSync(big, Buffer.alloc(3 * 1024 * 1024 + 1))
  assert.ok(!("skipped" in documentCandidate(ok, { home })))
  assert.ok(!("skipped" in documentCandidate(cloud, { home })), "a synced drive holds documents")
  assert.match((documentCandidate(hidden, { home }) as { skipped: string }).skipped, /hidden/)
  assert.match((documentCandidate(lib, { home }) as { skipped: string }).skipped, /application/)
  assert.match((documentCandidate(big, { home }) as { skipped: string }).skipped, /too large/)
  assert.match((documentCandidate("/etc/hosts.pdf", { home }) as { skipped: string }).skipped, /not found|outside/)
  assert.match((documentCandidate(join(home, "Documents", "missing.pdf"), { home }) as { skipped: string }).skipped, /not found/)
})

test("sync: the files a session worked on go with its knowledge, once; a file with a secret stays on the computer", async () => {
  const brain = await mockBrain()
  const prevHome = process.env.HOME
  try {
    const home = tempDir()
    process.env.HOME = home
    const brainHome = join(home, ".company-brain")
    const claude = join(home, ".claude")
    const proj = join(claude, "projects", "-home-jm-finance")
    mkdirSync(proj, { recursive: true })
    mkdirSync(brainHome, { recursive: true })
    writeFileSync(join(brainHome, "config.json"), JSON.stringify({ url: brain.url, token: "cb_test_token_123456", screenpipe_url: "http://127.0.0.1:9", use_claude_cli: false, sources: ["claude"], screenpipe_agent: false }))
    process.env.COMPANY_BRAIN_HOME = brainHome
    process.env.CLAUDE_CONFIG_DIR = claude
    process.env.CODEX_HOME = tempDir()

    const docs = join(home, "Documents")
    mkdirSync(docs, { recursive: true })
    const pdf = join(docs, "Revenus T3 2026.pdf")
    writeFileSync(pdf, "%PDF-1.4\n% fake revenue report\n")
    const csv = join(docs, "deploy-keys.csv")
    // Split so that no secret scanner takes the fake key for a real one.
    writeFileSync(csv, `service,key\nanthropic,${"sk-ant"}-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefghij\n`)
    const turn = (s: string, file: string, minAgo: number, answer: string) =>
      line({ type: "user", sessionId: s, cwd: docs, timestamp: ts(minAgo), message: { role: "user", content: `Read ${JSON.stringify(file)} and tell me what we decided about the deploy pipeline` } }) +
      line({ type: "assistant", sessionId: s, cwd: docs, timestamp: ts(minAgo - 1), message: { role: "assistant", content: [{ type: "tool_use", name: "Read", input: { file_path: file } }], stop_reason: "tool_use" } }) +
      line({ type: "assistant", sessionId: s, cwd: docs, timestamp: ts(minAgo - 2), message: { role: "assistant", content: [{ type: "text", text: answer }], stop_reason: "end_turn" } })
    writeFileSync(
      join(proj, "a.jsonl"),
      turn("a", pdf, 30, "We decided to deploy the API to production every Tuesday.\n1. Merge into main\n2. Tag the release\n3. Watch Sentry") +
        turn("b", csv, 20, "We decided to rotate the production deploy keys every quarter.\n1. Create the new key\n2. Update the CI secret\n3. Revoke the old one"),
    )

    const dry = capture()
    await runSync({ dryRun: true, distiller: "heuristic" }, dry.io)
    assert.match(dry.text(), /D1\. Revenus T3 2026\.pdf/)
    assert.match(dry.text(), /deploy-keys\.csv.*stays on the computer: It contains a secret/)
    assert.equal(brain.uploads.length, 0, "a dry run sends nothing")

    const out = capture()
    const r = await runSync({ distiller: "heuristic" }, out.io)
    assert.equal(brain.uploads.length, 1, out.text())
    const up = brain.uploads[0]
    assert.equal(up.name, "Revenus T3 2026.pdf", "the file name only, never the folders")
    assert.equal(up.auto, true)
    assert.ok(up.item_ids.length > 0, "linked to the session's knowledge")
    assert.equal(Buffer.from(up.content!, "base64").toString(), readFileSync(pdf, "utf8"))
    assert.match(out.text(), /Documents: 1 document sent with the knowledge \(Revenus T3 2026\.pdf → dev\), 1 kept on the computer/)
    assert.equal(r.documents?.filter((d) => d.status === "refused").length, 1)
    const state = JSON.parse(readFileSync(join(brainHome, "state.json"), "utf8"))
    assert.equal(Object.values(state.documents as Record<string, { id?: string; refused?: string }>).filter((d) => d.id === "doc1").length, 1)
    assert.ok(!JSON.stringify(state).includes("sk-ant-"), "nothing of the refused file in the state")

    // A later session reads the same PDF: only its fingerprint goes, to link the new knowledge.
    writeFileSync(join(proj, "c.jsonl"), turn("c", pdf, 5, "We decided to freeze production deploys during Black Friday week.\n1. Announce it\n2. Lock the pipeline\n3. Reopen on Monday"))
    await runSync({ distiller: "heuristic" }, capture().io)
    assert.equal(brain.uploads.length, 2)
    assert.equal(brain.uploads[1].content, undefined)
    assert.ok(brain.uploads[1].sha256)
    assert.ok([...brain.documents.values()][0].item_ids.length > up.item_ids.length)

    // --send-documents no: nothing goes any more.
    writeFileSync(join(brainHome, "config.json"), JSON.stringify({ url: brain.url, token: "cb_test_token_123456", screenpipe_url: "http://127.0.0.1:9", use_claude_cli: false, sources: ["claude"], screenpipe_agent: false, send_documents: false }))
    writeFileSync(join(proj, "d.jsonl"), turn("d", pdf, 3, "We decided to deploy the mobile app on Thursdays.\n1. Build\n2. Submit\n3. Release"))
    await runSync({ distiller: "heuristic" }, capture().io)
    assert.equal(brain.uploads.length, 2)
  } finally {
    process.env.HOME = prevHome
    await brain.close()
  }
})
