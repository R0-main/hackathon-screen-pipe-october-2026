import { strict as assert } from "node:assert"
import { spawn } from "node:child_process"
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { delimiter, join } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import { applyPrivacy, runSync } from "../src/sync"
import { TEST_ZONES, mockServer, tempDir } from "./helpers"
import { mockBrain } from "./mock-brain"

const clientDir = fileURLToPath(new URL("..", import.meta.url))
const ts = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString()
const line = (o: unknown) => JSON.stringify(o) + "\n"
const user = (s: string, text: string, minAgo: number) => line({ type: "user", sessionId: s, cwd: "/home/hugo/fournil", timestamp: ts(minAgo), message: { role: "user", content: text } })
const assistant = (s: string, text: string, minAgo: number) =>
  line({ type: "assistant", sessionId: s, cwd: "/home/hugo/fournil", timestamp: ts(minAgo), message: { role: "assistant", content: [{ type: "text", text }], stop_reason: "end_turn" } })

function capture() {
  const out: string[] = []
  return { io: { log: (s: string) => out.push(s), warn: (s: string) => out.push(s) }, text: () => out.join("\n") }
}

/** A test computer: Claude / Codex / client folders, config pointing to the fake brain. */
function workstation(brainUrl: string, extra: Record<string, unknown> = {}) {
  const home = tempDir()
  const claude = tempDir()
  const proj = join(claude, "projects", "-home-hugo-fournil")
  mkdirSync(proj, { recursive: true })
  writeFileSync(join(home, "config.json"), JSON.stringify({ url: brainUrl, token: "cb_test_token_123456", screenpipe_url: "http://127.0.0.1:9", use_claude_cli: false, sources: ["claude"], screenpipe_agent: false, ...extra }))
  process.env.COMPANY_BRAIN_HOME = home
  process.env.CLAUDE_CONFIG_DIR = claude
  process.env.CODEX_HOME = tempDir()
  delete process.env.ANTHROPIC_API_KEY
  return { home, claude, proj, state: () => JSON.parse(readFileSync(join(home, "state.json"), "utf8")) }
}

function session(i: number) {
  return (
    user(`s${i}`, `How do we configure billing module ${i}?`, 200 - i) +
    assistant(
      `s${i}`,
      `We decided to use strategy ${i} for module ${i}.\n1. Create the module_${i} table\n2. Migrate the data of module ${i}\n3. Check module ${i} in staging\nTODO: document module ${i} in the wiki`,
      199 - i,
    )
  )
}

test("sending interrupted at the 2nd batch: the batches already accepted are not sent again (checkpoints per batch)", async () => {
  const brain = await mockBrain({ failIngestAt: [2] })
  try {
    const ws = workstation(brain.url)
    for (let i = 1; i <= 30; i++) writeFileSync(join(ws.proj, `s${String(i).padStart(2, "0")}.jsonl`), session(i))
    await assert.rejects(runSync({ distiller: "heuristic" }, capture().io), /500/)
    assert.equal(brain.ingested.length, 50)
    // The conversations sent in full have their checkpoint.
    const saved = Object.keys(ws.state().claude.files).length
    assert.ok(saved >= 12, `checkpoints saved: ${saved}`)

    const out = capture()
    const r = await runSync({ distiller: "heuristic" }, out.io)
    const total = brain.ingested.length
    assert.ok(total >= 115, `unique knowledge items: ${total}`)
    const resent = brain.received.length - total
    // At most the items of the conversation straddling the failed batch (4 here), and the brain skips them.
    assert.ok(resent <= 4, `sent again: ${resent}`)
    assert.equal(r.duplicates, resent)
    assert.equal(r.sent + 50, total)
    const again = await runSync({ distiller: "heuristic" }, capture().io)
    assert.equal(again.items.length, 0)
  } finally {
    await brain.close()
  }
})

test("dry run: abridged texts by default, full with --full; --confirm sends exactly the preview", async () => {
  const brain = await mockBrain()
  try {
    const ws = workstation(brain.url)
    const steps = Array.from({ length: 5 }, (_, n) => `${n + 1}. Step ${n + 1} of the runbook to put the Fournil API into production, with a check of the logs`).join("\n")
    const f = join(ws.proj, "deploy.jsonl")
    writeFileSync(f, user("d", "How do we deploy the API to production?", 20) + assistant("d", `Here is the procedure.\n${steps}`, 19))

    const short = capture()
    await runSync({ dryRun: true, distiller: "heuristic" }, short.io)
    assert.match(short.text(), /Abridged texts: add --full/)
    assert.ok(!short.text().includes("Step 5 of the runbook"))

    const full = capture()
    const preview = await runSync({ dryRun: true, full: true, distiller: "heuristic" }, full.io)
    // Every step, whatever the way the distiller formats the procedure.
    for (let n = 1; n <= 5; n++) assert.ok(full.text().includes(`Step ${n} of the runbook`), `step ${n} missing from the preview`)
    assert.ok(!full.text().includes("Abridged texts"))
    assert.match(full.text(), /sync --confirm/)
    assert.equal(brain.ingested.length, 0)
    assert.equal(statSync(join(ws.home, "preview.json")).mode & 0o777, 0o600)
    assert.ok(!existsSync(join(ws.home, "state.json")))

    // Activity arrives between the preview and the approval: it does not go with --confirm.
    appendFileSync(f, user("d", "And for the database rollback?", 5) + assistant("d", "We decided to keep the daily Supabase snapshots.", 4))
    const sent = await runSync({ confirm: true }, capture().io)
    assert.deepEqual(brain.ingested, JSON.parse(JSON.stringify(preview.items)))
    assert.equal(sent.sent, preview.items.length)
    assert.ok(!existsSync(join(ws.home, "preview.json")))
    assert.ok(ws.state().last_sync.items_sent === preview.items.length)
    assert.ok(!JSON.stringify(brain.ingested).includes("snapshots"))

    // The next sync resumes after the preview: only the new activity goes.
    await runSync({ distiller: "heuristic" }, capture().io)
    const later = brain.ingested.slice(preview.items.length)
    assert.ok(later.length > 0 && JSON.stringify(later).includes("snapshots"))
    assert.ok(!JSON.stringify(later).includes("Step 1 of the runbook"))

    await assert.rejects(runSync({ confirm: true }, capture().io), /No dry run to confirm/)
  } finally {
    await brain.close()
  }
})

test("--confirm refuses an outdated preview (sync in between)", async () => {
  const brain = await mockBrain()
  try {
    const ws = workstation(brain.url)
    writeFileSync(join(ws.proj, "a.jsonl"), session(1))
    await runSync({ dryRun: true, distiller: "heuristic" }, capture().io)
    writeFileSync(join(ws.home, "state.json"), JSON.stringify({ claude: { files: {} }, last_sync: { at: ts(0) } }))
    await assert.rejects(runSync({ confirm: true }, capture().io), /A sync happened since the dry run/)
    assert.equal(brain.ingested.length, 0)
  } finally {
    await brain.close()
  }
})

test("after install-schedule (baseline): the history not reviewed does not go, the new activity does", async () => {
  const brain = await mockBrain()
  try {
    const ws = workstation(brain.url)
    writeFileSync(join(ws.home, "state.json"), JSON.stringify({ baseline_at: ts(10) }))
    writeFileSync(
      join(ws.proj, "x.jsonl"),
      user("x", "How do we close the month?", 60) +
        assistant("x", "We decided to close on the 5th of the next month.", 59) +
        user("x", "And for expense reports?", 3) +
        assistant("x", "We decided to move expense reports to Swile.", 2),
    )
    await runSync({ distiller: "heuristic" }, capture().io)
    const json = JSON.stringify(brain.ingested)
    assert.ok(json.includes("Swile"), json)
    assert.ok(!json.includes("close on the 5th"), "an exchange from before the setup was sent")
  } finally {
    await brain.close()
  }
})

test("a session in a project that a zone lists goes to that zone, whatever its content", async () => {
  const fournil = { id: "fournil", name: "Fournil", description: "The bakery app", color: "#000", position: 2, readable: true, keywords: [], projects: ["fournil"] }
  const brain = await mockBrain({ zones: [...TEST_ZONES, fournil] })
  try {
    const ws = workstation(brain.url)
    // Content that the keywords would file under finance: the project folder (/home/hugo/fournil) decides.
    writeFileSync(join(ws.proj, "p.jsonl"), user("p", "How do we handle the VAT on invoices?", 30) + assistant("p", "We decided to issue the invoices with VAT at 5.5% from the closing.", 29))
    await runSync({ distiller: "heuristic", since: "1d" }, capture().io)
    const items = brain.ingested as { zone: string }[]
    assert.ok(items.length > 0, "nothing sent")
    assert.deepEqual([...new Set(items.map((i) => i.zone))], ["fournil"])
  } finally {
    await brain.close()
  }
})

test("Screenpipe workflows: shown in the dry run (filtered, redacted), only those are sent up", async () => {
  const brain = await mockBrain()
  const sp = await mockServer((req) => {
    const u = new URL(req.url, "http://x")
    if (u.pathname === "/search") return { body: { data: [], pagination: { total: 0 } } }
    if (u.pathname === "/workflows")
      return {
        body: {
          workflows: [
            { title: "Replies to Julie on WhatsApp", description: "Personal evening messages", occurrences: 9, days: 5 },
            { title: "Invoice reminders", description: "Mail then Excel", apps: ["Mail"], occurrences: 6, days: 4 },
            { title: "Daily VAT check with Claude", description: "Then writes to finance@fournil.fr", app_name: "Claude", occurrences: 8, days: 6, typical_time: "09:00" },
          ],
        },
      }
    return undefined
  })
  try {
    workstation(brain.url, { screenpipe_url: sp.url, sources: ["screenpipe"] })
    const out = capture()
    await runSync({ dryRun: true, distiller: "heuristic" }, out.io)
    assert.match(out.text(), /W1\. Daily VAT check with Claude .*8 times over 6 days, around 09:00/)
    assert.match(out.text(), /2 Screenpipe workflows dropped/)
    assert.ok(!out.text().includes("finance@fournil.fr") && !out.text().includes("WhatsApp"))
    await runSync({ distiller: "heuristic" }, capture().io)
    assert.equal(brain.automations.length, 1)
    assert.ok(!JSON.stringify(brain.automations).includes("finance@fournil.fr"))
  } finally {
    await brain.close()
    await sp.close()
  }
})

test("applyPrivacy: the computer's token redacted, install session dropped", () => {
  const conv = (id: string, text: string) => ({
    id,
    tool: "claude" as const,
    app: "Terminal",
    started_at: ts(5),
    ended_at: ts(4),
    messages: [
      { role: "user" as const, text },
      { role: "assistant" as const, text: "OK, we deploy the API." },
    ],
  })
  const r = applyPrivacy(
    [
      conv("a", "The API deployment returns 401, here is the copied header: cb_AbCdEfGhIjKlMnOpQrStUvWxYz012345"),
      conv("b", "You are going to connect this computer to NOS Brainer, Fournil's company brain. I am Hugo."),
      conv("c", "The deployment crashes with mysecretkey-123456789 in the logs"),
    ],
    ["mysecretkey-123456789"],
  )
  assert.equal(r.kept.length, 1)
  assert.ok(!r.kept[0].messages[0].text.includes("cb_AbCd"))
  assert.match(r.kept[0].messages[0].text, /\[token redacted\]/)
  assert.deepEqual(
    r.dropped.map((d) => d.reason),
    ["brain install session", "brain install session"],
  )
})

test("sync --scheduled --home: minimal environment (like cron), PATH and folders taken from the config", { skip: process.platform === "win32" }, async () => {
  const brain = await mockBrain()
  try {
    const ws = workstation(brain.url)
    writeFileSync(join(ws.proj, "a.jsonl"), session(1))
    const bin = tempDir()
    // Fake `claude` CLI: answers an empty extraction.
    writeFileSync(join(bin, "claude"), '#!/bin/sh\ncat > /dev/null\necho \'{"result":"{\\"items\\":[]}"}\'\n')
    chmodSync(join(bin, "claude"), 0o755)
    const cfg = JSON.parse(readFileSync(join(ws.home, "config.json"), "utf8"))
    writeFileSync(join(ws.home, "config.json"), JSON.stringify({ ...cfg, use_claude_cli: true, schedule_env: { PATH: `${bin}${delimiter}/usr/bin`, CLAUDE_CONFIG_DIR: ws.claude } }))
    const out = await new Promise<string>((resolve) => {
      const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "sync", "--scheduled", "--dry-run", "--home", ws.home], {
        cwd: clientDir,
        // Like cron: minimal PATH, without node's folder (where the real `claude` CLI also is on this computer).
        env: { HOME: tempDir(), PATH: `/usr/bin${delimiter}/bin` },
      })
      let s = ""
      child.stdout.on("data", (d) => (s += d))
      child.stderr.on("data", (d) => (s += d))
      child.on("close", () => resolve(s))
    })
    assert.match(out, new RegExp(`CLI found \\(${join(bin, "claude").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`), out)
    assert.match(out, /Claude Code: 1 conversation/, out)
  } finally {
    await brain.close()
  }
})
