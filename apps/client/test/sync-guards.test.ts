// Safeguards of the sync: starting point of the schedule, partial preview, LLM failures, personal signals,
// the computer's secrets, count per zone from the brain's answer.

import { strict as assert } from "node:assert"
import { appendFileSync, chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import { ZoneTally, applyPrivacy, insertedByZone, runSync } from "../src/sync"
import { prepareSchedule } from "../src/install"
import { fakeClaude, withPath } from "./fake-claude"
import { mockServer, tempDir } from "./helpers"
import { mockBrain } from "./mock-brain"

const ts = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString()
const line = (o: unknown) => JSON.stringify(o) + "\n"
const user = (s: string, text: string, minAgo: number) => line({ type: "user", sessionId: s, cwd: "/home/ines/app", timestamp: ts(minAgo), message: { role: "user", content: text } })
const assistant = (s: string, text: string, minAgo: number, stop_reason = "end_turn") =>
  line({ type: "assistant", sessionId: s, cwd: "/home/ines/app", timestamp: ts(minAgo), message: { role: "assistant", content: [{ type: "text", text }], stop_reason } })
const toolUse = (s: string, minAgo: number) =>
  line({ type: "assistant", sessionId: s, cwd: "/home/ines/app", timestamp: ts(minAgo), message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: {} }], stop_reason: "tool_use" } })

function capture() {
  const out: string[] = []
  return { io: { log: (s: string) => out.push(s), warn: (s: string) => out.push(s) }, text: () => out.join("\n") }
}

/** Fake secrets assembled at run time (no plain secret pattern in the repo). */
const fake = (...parts: string[]) => parts.join("")

function workstation(brainUrl: string, extra: Record<string, unknown> = {}) {
  const home = tempDir()
  const claude = tempDir()
  const codex = tempDir()
  const proj = join(claude, "projects", "-home-ines-app")
  mkdirSync(proj, { recursive: true })
  writeFileSync(join(home, "config.json"), JSON.stringify({ url: brainUrl, token: "cb_test_token_123456", screenpipe_url: "http://127.0.0.1:9", use_claude_cli: false, sources: ["claude"], screenpipe_agent: false, ...extra }))
  process.env.COMPANY_BRAIN_HOME = home
  process.env.CLAUDE_CONFIG_DIR = claude
  process.env.CODEX_HOME = codex
  delete process.env.ANTHROPIC_API_KEY
  return {
    home,
    claude,
    codex,
    proj,
    state: () => JSON.parse(readFileSync(join(home, "state.json"), "utf8")),
    setConfig: (patch: Record<string, unknown>) => {
      const cfg = JSON.parse(readFileSync(join(home, "config.json"), "utf8"))
      writeFileSync(join(home, "config.json"), JSON.stringify({ ...cfg, ...patch }))
    },
  }
}

type Row = { n: number; at: number; app: string; window: string; text: string }

/** Fake Screenpipe: /search by time window, from newest to oldest, with a total. */
async function screenpipe(rows: Row[]) {
  return mockServer((req) => {
    const u = new URL(req.url, "http://x")
    if (u.pathname === "/health") return { body: { status: "healthy" } }
    if (u.pathname === "/workflows") return { body: { workflows: [] } }
    if (u.pathname !== "/search") return undefined
    if (u.searchParams.get("content_type") !== "ocr") return { body: { data: [], pagination: { total: 0 } } }
    const a = Date.parse(u.searchParams.get("start_time")!)
    const b = Date.parse(u.searchParams.get("end_time")!)
    const limit = Number(u.searchParams.get("limit"))
    const offset = Number(u.searchParams.get("offset"))
    const sel = rows.filter((r) => r.at >= a && r.at <= b).sort((x, y) => y.at - x.at)
    const data = sel.slice(offset, offset + limit).map((r) => ({
      type: "OCR",
      content: { frame_id: r.n, text: r.text, timestamp: new Date(r.at).toISOString(), app_name: r.app, window_name: r.window },
    }))
    return { body: { data, pagination: { limit, offset, total: sel.length } } }
  })
}

const nums = (v: unknown, re = /QZX(\d+)/g) => [...JSON.stringify(v).matchAll(re)].map((m) => Number(m[1]))

test("PRIVACY-8b: after install-schedule, neither the rest of Screenpipe nor the postponed conversations go on their own", async () => {
  const brain = await mockBrain()
  const now = Date.now()
  // 40 Screenpipe windows (40 conversations) over the last 6 hours: the preview (limit 30) postpones 10.
  const rows: Row[] = []
  for (let k = 0; k < 40; k++) {
    const t = now - 6 * 3600_000 + k * 8 * 60_000
    rows.push({ n: 2 * k, at: t, app: "Terminal", window: `claude — topic ${k}`, text: `QZX${k} We decided to keep Qonto for the cash of batch ${k}.` })
    rows.push({ n: 2 * k + 1, at: t + 30_000, app: "Terminal", window: `claude — topic ${k}`, text: `1. Open statement ${k}\n2. Reconcile statement ${k}` })
  }
  const sp = await screenpipe(rows)
  try {
    const ws = workstation(brain.url, { screenpipe_url: sp.url, sources: ["screenpipe", "claude"] })
    // Claude Code: a session postponed by the limit is not read again either, nor is a turn in progress.
    writeFileSync(join(ws.proj, "pending.jsonl"), user("p", "QZX900 How do we close the VAT?", 3) + toolUse("p", 2))

    const dry = capture()
    const r = await runSync({ dryRun: true, full: true, since: "24h", distiller: "heuristic" }, dry.io)
    const shown = new Set(nums(r.items))
    assert.ok(shown.size >= 25 && shown.size < 40, `conversations shown: ${shown.size}`)
    assert.equal(r.deferred, 40 - shown.size)
    // The preview says clearly that it is partial, and why.
    assert.match(dry.text(), /Warning, partial preview/)
    assert.match(dry.text(), /conversations postponed: limit of 30 segments/)
    assert.match(dry.text(), /conversation turn in progress/)
    assert.match(dry.text(), /After install-schedule, what was not reviewed is never sent/)

    await runSync({ confirm: true }, capture().io)
    assert.deepEqual(new Set(nums(brain.ingested)), shown)
    prepareSchedule({ PATH: "/usr/bin" }, () => {})
    const st = ws.state()
    assert.ok(st.screenpipe.last_timestamp >= st.baseline_at, "Screenpipe checkpoint moved up at setup")
    assert.ok(st.claude.files[join(ws.proj, "pending.jsonl")], "Claude Code file resumed at its current end")

    // The scheduled sync sends nothing from before…
    const before = brain.ingested.length
    await runSync({ distiller: "heuristic" }, capture().io)
    assert.equal(brain.ingested.length, before, `sent after the setup: ${JSON.stringify(brain.ingested.slice(before))}`)
    // … but the new activity goes.
    rows.push({ n: 999, at: Date.now() + 1000, app: "Terminal", window: "claude — new", text: "QZX777 We decided to move expense reports to Swile." })
    appendFileSync(join(ws.proj, "pending.jsonl"), assistant("p", "QZX901 We decided to close the VAT on the 5th.", 0))
    await new Promise((res) => setTimeout(res, 1100))
    await runSync({ distiller: "heuristic" }, capture().io)
    const later = nums(brain.ingested.slice(before))
    assert.ok(later.includes(777), `new capture missing: ${later}`)
    assert.ok(later.includes(901), `answer that arrived after the setup missing: ${later}`)
    assert.ok(!later.includes(900), "the question from before the setup (never reviewed) was sent")
    assert.ok(!later.some((n) => n < 40), `Screenpipe history not reviewed was sent: ${later}`)
  } finally {
    await brain.close()
    await sp.close()
  }
})

test("PRIVACY-8b: a truncated Screenpipe preview says so, and the schedule does not pick up the rest", async () => {
  const brain = await mockBrain()
  const now = Date.now()
  // 2600 captures in 2 h: more than a pass reads (20 pages of 100).
  const rows: Row[] = Array.from({ length: 2600 }, (_, i) => ({
    n: i,
    at: now - 2 * 3600_000 + i * 2500,
    app: "Terminal",
    window: `claude — finance ${Math.floor(i / 400)}`,
    text: `QZX${i} bank reconciliation line ${i}`,
  }))
  const sp = await screenpipe(rows)
  try {
    const ws = workstation(brain.url, { screenpipe_url: sp.url, sources: ["screenpipe"] })
    const dry = capture()
    await runSync({ dryRun: true, full: true, since: "24h", distiller: "heuristic", limit: 200 }, dry.io)
    assert.match(dry.text(), /Warning, partial preview/)
    assert.match(dry.text(), /Screenpipe: captures read only up to .*/)
    const preview = JSON.parse(readFileSync(join(ws.home, "preview.json"), "utf8"))
    const maxShown = Math.max(...nums(preview.items))
    assert.ok(maxShown < 2599)
    await runSync({ confirm: true }, capture().io)
    prepareSchedule({ PATH: "/usr/bin" }, () => {})
    const before = brain.ingested.length
    await runSync({ distiller: "heuristic", limit: 200 }, capture().io)
    const later = nums(brain.ingested.slice(before))
    assert.deepEqual(later, [], `captures from before the setup sent (up to #${Math.max(-1, ...later)})`)
  } finally {
    await brain.close()
    await sp.close()
  }
})

test("R-count: the count per zone only counts the inserted items (brain's answer)", async () => {
  const brain = await mockBrain()
  try {
    const ws = workstation(brain.url)
    writeFileSync(join(ws.proj, "d.jsonl"), user("d", "How do we deploy the API to production?", 50) + assistant("d", "We decided to deploy with Vercel.\n1. Merge\n2. Tag\n3. Monitor", 49))
    const first = capture()
    const r1 = await runSync({ distiller: "heuristic" }, first.io)
    assert.ok(r1.sent > 0)
    assert.match(first.text(), new RegExp(`Sent: ${r1.sent} knowledge items? to the brain \\(dev: ${r1.sent}\\)\\.`))
    // Full resend: everything is already known, no zone must be credited.
    const again = capture()
    const r2 = await runSync({ distiller: "heuristic", reset: true }, again.io)
    assert.equal(r2.sent, 0)
    assert.deepEqual(r2.zones, {})
    assert.match(again.text(), new RegExp(`Sent: 0 knowledge items to the brain, ${r2.duplicates} already known items? skipped by the brain\\.`))
    assert.deepEqual(ws.state().last_sync.zones, {})
  } finally {
    await brain.close()
  }
})

test("R-count: insertedByZone / ZoneTally (per_zone, single zone, zones touched, ambiguous case)", () => {
  const batch = [{ zone: "dev" }, { zone: "dev" }, { zone: "finance" }, { zone: "sales" }]
  assert.deepEqual(insertedByZone(batch, { inserted: 3, zones: ["dev", "finance"], per_zone: { dev: 2, finance: 1 } }), { dev: 2, finance: 1 })
  assert.deepEqual(insertedByZone(batch, { inserted: 0, zones: [] }), {})
  assert.deepEqual(insertedByZone(batch, { inserted: 4, zones: ["dev", "finance", "sales"] }), { dev: 2, finance: 1, sales: 1 })
  assert.deepEqual(insertedByZone(batch, { inserted: 1, zones: ["dev"] }), { dev: 1 })
  // The items of the zones not touched were all skipped: the rest is exact.
  assert.deepEqual(insertedByZone(batch, { inserted: 3, zones: ["dev", "finance"] }), { dev: 2, finance: 1 })
  // One of the two "dev" items skipped, "finance" inserted: impossible to decide without per_zone.
  assert.equal(insertedByZone(batch, { inserted: 2, zones: ["dev", "finance"] }), null)
  const t = new ZoneTally()
  t.add(batch, { inserted: 4, zones: ["dev", "finance", "sales"] })
  t.add(batch, { inserted: 2, zones: ["dev", "finance"] })
  assert.equal(t.line(), "dev: 2, finance: 1, sales: 1, dev or finance: 2")
})

/** Fake `claude` CLI: logs every call; fails if the prompt contains QZXFAIL (or always, network down, with failAll). */
function fakeClaudeSh(dir: string, opts: { failAll?: boolean } = {}) {
  const bin = join(dir, "bin")
  mkdirSync(bin, { recursive: true })
  const out = join(dir, "out.json")
  writeFileSync(
    out,
    JSON.stringify({
      result: JSON.stringify({ items: [{ zone: "finance", kind: "decision", title: "VAT closing on the 5th of the month", body: "Decision made: the VAT is closed on the 5th.", entities: [], confidence: 0.9 }] }),
    }),
  )
  writeFileSync(
    join(bin, "claude"),
    `#!/bin/sh
if [ "$1" = "--help" ]; then echo "--no-session-persistence --tools"; exit 0; fi
input=$(cat)
echo call >> "${join(dir, "calls.log")}"
${opts.failAll ? 'echo "API Error: Connection error." >&2; exit 1' : 'case "$input" in *QZXFAIL*) echo "boom" >&2; exit 1;; esac'}
cat "${out}"
`,
  )
  chmodSync(join(bin, "claude"), 0o755)
  return { bin, calls: () => (readFileSync(join(dir, "calls.log"), "utf8").match(/call/g) ?? []).length }
}

test("PRIVACY-4c: Claude does not answer → nothing is distilled by the heuristic, checkpoint unchanged, retried later", async () => {
  const brain = await mockBrain()
  try {
    const ws = workstation(brain.url, { use_claude_cli: true })
    const f = join(ws.proj, "vat.jsonl")
    writeFileSync(f, user("t", "How do we close the VAT this month?", 50) + assistant("t", "We decided to close the VAT on the 5th.\n1. Export\n2. File", 49))
    for (let i = 0; i < 4; i++) writeFileSync(join(ws.proj, `x${i}.jsonl`), user(`x${i}`, `How do we configure module ${i}?`, 40 - i) + assistant(`x${i}`, `We decided to use strategy ${i}.`, 39 - i))
    const down = fakeClaudeSh(tempDir(), { failAll: true })
    const out = capture()
    const r = await withPath(down.bin, () => runSync({}, out.io))
    assert.equal(r.distiller, "claude-cli")
    assert.equal(brain.received.length, 0, "the heuristic was used as a fallback")
    assert.equal(r.failed, 5)
    // At most MAX_SYSTEMIC_FAILURES calls (+ the one in progress): we do not insist when Claude is unreachable.
    assert.ok(down.calls() <= 4, `calls: ${down.calls()}`)
    assert.match(out.text(), /not distilled .*Connection error/)
    assert.match(out.text(), /the heuristic is not used instead: (it|they) will be retried/)
    assert.match(out.text(), /General outage \(Claude unreachable or overloaded\): no attempt is counted/)
    assert.equal(ws.state().claude?.files?.[f], undefined, "checkpoint moved forward despite the failure")
    assert.equal(ws.state().distill_failures, undefined, "general outage counted as a conversation failure")

    // Claude is back: the conversation is distilled by Claude and sent.
    const up = fakeClaudeSh(tempDir())
    const r2 = await withPath(up.bin, () => runSync({}, capture().io))
    assert.equal(r2.failed, 0)
    assert.ok(brain.ingested.length >= 1)
    assert.ok(ws.state().claude.files[f])
  } finally {
    await brain.close()
  }
})

test("PRIVACY-4c: a conversation Claude cannot distill (the others go through) is given up after 3 attempts, without sending anything", async () => {
  const brain = await mockBrain()
  try {
    const ws = workstation(brain.url, { use_claude_cli: true })
    const bad = join(ws.proj, "bad.jsonl")
    writeFileSync(bad, user("b", "QZXFAIL How do we close the VAT?", 50) + assistant("b", "We decided to close the VAT on the 5th.", 49))
    const cli = fakeClaudeSh(tempDir())
    for (let run = 1; run <= 3; run++) {
      writeFileSync(join(ws.proj, `ok${run}.jsonl`), user(`ok${run}`, `Finance question ${run}?`, 30) + assistant(`ok${run}`, `Finance answer ${run}.`, 29))
      const out = capture()
      const r = await withPath(cli.bin, () => runSync({}, out.io))
      if (run < 3) {
        assert.equal(r.failed, 1)
        assert.equal(ws.state().distill_failures?.b?.n, run)
        assert.equal(ws.state().claude.files[bad], undefined)
      } else {
        assert.match(out.text(), /1 conversation given up after 3 unsuccessful attempts: nothing was sent/)
        assert.equal(ws.state().distill_failures, undefined)
        assert.ok(ws.state().claude.files[bad], "conversation given up: its checkpoint moves forward")
      }
    }
    assert.ok(!JSON.stringify(brain.received).includes("QZXFAIL"))
  } finally {
    await brain.close()
  }
})

test("H-personal-signals: signals shown in the dry run; weak signals of an active conversation → examined again (not processed)", async () => {
  const brain = await mockBrain()
  try {
    const ws = workstation(brain.url)
    const weak = join(ws.proj, "weak.jsonl")
    const strong = join(ws.proj, "strong.jsonl")
    const oldWeak = join(ws.proj, "old.jsonl")
    writeFileSync(weak, user("w", "Export the statements of my bank account and prepare the VAT", 20) + assistant("w", "OK.", 19))
    writeFileSync(strong, user("s", "Write an email to my lawyer about the divorce", 20) + assistant("s", "Here is a draft.", 19))
    writeFileSync(oldWeak, user("o", "Export the statements of my bank account", 300) + assistant("o", "OK.", 299))
    const dry = capture()
    await runSync({ dryRun: true, distiller: "heuristic", since: "24h" }, dry.io)
    assert.match(dry.text(), /dropped: s \(personal content: divorce\)/)
    assert.match(dry.text(), /dropped: w \(personal content, weak signals: my bank account \(work vocabulary: 1\); examined again on the next sync/)
    assert.match(dry.text(), /dropped: o \(personal content, weak signals: my bank account \(work vocabulary: 0\)\)/)

    await runSync({ distiller: "heuristic", since: "24h" }, capture().io)
    const files = ws.state().claude.files
    assert.ok(files[strong], "clearly personal conversation: processed (dropped for good)")
    assert.ok(files[oldWeak], "conversation inactive for a long time: processed")
    assert.equal(files[weak], undefined, "weak signals, active conversation: must be examined again")
    // The conversation goes on with real work: examined again in full, it goes through.
    appendFileSync(weak, user("w", "Do the Qonto bank reconciliation with Pennylane, list the VAT discrepancies and the supplier invoices", 2) + assistant("w", "We decided to reconcile each supplier invoice in Pennylane.", 1))
    await runSync({ distiller: "heuristic" }, capture().io)
    assert.ok(ws.state().claude.files[weak])
    assert.ok(JSON.stringify(brain.ingested).includes("Pennylane"))
    assert.equal(brain.ingested.length > 0, true)
    assert.ok(!JSON.stringify(brain.received).includes("divorce"))
  } finally {
    await brain.close()
  }
})

test("H-redact-literals: the computer's secrets (Claude Code token included) are redacted as is, or the session is dropped", async () => {
  const oauth = fake("sk-ant-", "oat01-", "Zq9", "x".repeat(40))
  const spTok = fake("sp", "-local-", "Kd83hQ", "pz2Lm")
  const secrets = ["cb_test_token_123456", spTok, oauth]
  const conv = (id: string, title: string, text: string) => ({
    id,
    tool: "claude" as const,
    app: "Terminal",
    title,
    started_at: ts(5),
    ended_at: ts(4),
    messages: [
      { role: "user" as const, text },
      { role: "assistant" as const, text: "We decided to deploy the API on Friday." },
    ],
  })
  const r = applyPrivacy([conv("a", `Terminal ${spTok} deployment`, "How do we deploy the API?"), conv("b", "API", `The deployment fails with ${oauth}`)], secrets)
  assert.equal(r.kept.length, 1)
  assert.ok(!r.kept[0].title?.includes(spTok))
  assert.match(r.kept[0].title ?? "", /redacted/)
  assert.deepEqual(r.dropped.map((d) => [d.id, d.reason]), [["b", "brain install session"]])

  // End to end: the session where the Claude Code token appears does not go.
  const brain = await mockBrain()
  try {
    const ws = workstation(brain.url, { claude_oauth_token: oauth, screenpipe_token: spTok })
    writeFileSync(join(ws.proj, "tok.jsonl"), user("k", `export CLAUDE_CODE_OAUTH_TOKEN=${oauth} then we deploy the API`, 20) + assistant("k", "We decided to deploy the API.", 19))
    writeFileSync(join(ws.proj, "ok.jsonl"), user("ok", "How do we deploy the API to production?", 20) + assistant("ok", "We decided to deploy with Vercel.", 19))
    await runSync({ distiller: "heuristic" }, capture().io)
    const sent = JSON.stringify(brain.received)
    assert.ok(sent.includes("Vercel"))
    assert.ok(!sent.includes(oauth) && !sent.includes("oat01"))
  } finally {
    await brain.close()
  }
})

const tags = (v: unknown) => [...new Set([...JSON.stringify(v).matchAll(/QZX[A-Z]*\d+/g)].map((m) => m[0]))].sort()

test("STALL: conversations Claude always refuses (the oldest) block neither the following ones nor their checkpoints, and are given up after 3 attempts", async () => {
  const brain = await mockBrain()
  const cli = fakeClaude()
  try {
    const ws = workstation(brain.url, { use_claude_cli: true })
    const bad = [0, 1, 2, 3].map((k) => join(ws.proj, `bad${k}.jsonl`))
    bad.forEach((f, k) => writeFileSync(f, user(`bad${k}`, `QZXBAD${k} How do we close the VAT?`, 120 - k) + assistant(`bad${k}`, "We close on the 5th.", 119 - k)))
    const good = [0, 1, 2, 3, 4].map((k) => join(ws.proj, `ok${k}.jsonl`))
    good.forEach((f, k) => writeFileSync(f, user(`ok${k}`, `QZX${k} How do we deploy the API?`, 60 - k) + assistant(`ok${k}`, "We decided to deploy with Vercel.", 59 - k)))

    // 1st pass: the 4 refusals do not cut the sync, the 5 following conversations go (same pass).
    const out1 = capture()
    const r1 = await withPath(cli.bin, () => runSync({}, out1.io))
    assert.deepEqual(tags(brain.ingested), ["QZX0", "QZX1", "QZX2", "QZX3", "QZX4"])
    assert.equal(r1.failed, 4)
    assert.equal(cli.calls().length, 9, "every conversation is attempted")
    assert.doesNotMatch(out1.text(), /not attempted|General outage|Check that `claude -p` works/)
    assert.match(out1.text(), /Failure due to the content of 4 conversations \(attempt 1\/3\)/)
    for (const f of good) assert.ok(ws.state().claude.files[f], "conversation distilled: checkpoint moved forward")
    for (const f of bad) assert.equal(ws.state().claude.files[f], undefined)
    assert.deepEqual(Object.values(ws.state().distill_failures).map((f) => (f as { n: number }).n), [1, 1, 1, 1])

    // 2nd pass: only the refused conversations are left; the model answers (in prose): the attempt is counted.
    await withPath(cli.bin, () => runSync({}, capture().io))
    assert.deepEqual(Object.values(ws.state().distill_failures).map((f) => (f as { n: number }).n), [2, 2, 2, 2])
    // 3rd pass: given up, without sending anything; their checkpoints move forward.
    const out3 = capture()
    await withPath(cli.bin, () => runSync({}, out3.io))
    assert.match(out3.text(), /4 conversations given up after 3 unsuccessful attempts: nothing was sent for them/)
    assert.equal(ws.state().distill_failures, undefined)
    for (const f of bad) assert.ok(ws.state().claude.files[f], "conversation given up: checkpoint moved forward")
    const calls = cli.calls().length
    await withPath(cli.bin, () => runSync({}, capture().io))
    assert.equal(cli.calls().length, calls, "conversations given up were retried")
    assert.ok(!JSON.stringify(brain.received).includes("QZXBAD"))
  } finally {
    await brain.close()
  }
})

test("STALL: a Screenpipe window Claude refuses does not block the Screenpipe checkpoint: given up on the 3rd pass, the rest is read", async () => {
  const brain = await mockBrain()
  const cli = fakeClaude()
  const now = Date.now()
  const start = now - 2 * 3600_000
  // The oldest window is refused by Claude; then 2600 captures (more than a pass reads).
  const rows: Row[] = [
    { n: 0, at: start, app: "Terminal", window: "claude — bad", text: "QZXBAD1 Conversation Claude refuses to process." },
    { n: 1, at: start + 20_000, app: "Terminal", window: "claude — bad", text: "QZXBAD1 rest of the refused conversation." },
  ]
  for (let i = 0; i < 2600; i++) {
    const w = Math.floor(i / 100)
    rows.push({ n: i + 2, at: start + 60_000 + i * 2500, app: "Terminal", window: `claude — finance ${w}`, text: `QZXW${w} bank reconciliation line ${i}` })
  }
  const sp = await screenpipe(rows)
  try {
    const ws = workstation(brain.url, { use_claude_cli: true, screenpipe_url: sp.url, sources: ["screenpipe"] })
    const r1 = await withPath(cli.bin, () => runSync({ limit: 200 }, capture().io))
    assert.equal(r1.failed, 1)
    const firstPass = tags(brain.ingested)
    assert.ok(firstPass.length > 5, `1st pass: ${firstPass}`)
    const lastWindow = (t: string[]) => Math.max(...t.map((x) => Number(x.slice(4))))
    assert.ok(lastWindow(firstPass) < 25, "the 1st pass does not read everything (capped reading)")
    assert.equal(ws.state().screenpipe?.last_timestamp, undefined, "checkpoint moved past a window not distilled")
    const failing = () => Object.values(ws.state().distill_failures ?? {}).map((f) => (f as { n: number }).n)
    assert.deepEqual(failing(), [1])

    // 2nd pass: same window read again, only the refused conversation is attempted → attempt counted (the model answered).
    const r2 = await withPath(cli.bin, () => runSync({ limit: 200 }, capture().io))
    assert.equal(r2.sent, 0)
    assert.deepEqual(failing(), [2])
    // 3rd pass: given up; the Screenpipe checkpoint finally moves forward.
    const out3 = capture()
    await withPath(cli.bin, () => runSync({ limit: 200 }, out3.io))
    assert.match(out3.text(), /1 conversation given up after 3 unsuccessful attempts/)
    assert.ok(ws.state().screenpipe?.last_timestamp, "Screenpipe checkpoint still stuck")
    // The rest (never read until then) goes on the next pass.
    await withPath(cli.bin, () => runSync({ limit: 200 }, capture().io))
    assert.ok(lastWindow(tags(brain.ingested)) > lastWindow(firstPass), `rest never read: ${tags(brain.ingested)}`)
    assert.ok(!JSON.stringify(brain.received).includes("QZXBAD"))
  } finally {
    await brain.close()
    await sp.close()
  }
})

test("STALL: every call fails the same way without an answer from Claude → outage, nothing counted; a conversation in error → counted when Claude answers the others, then given up", async () => {
  const brain = await mockBrain()
  const cli = fakeClaude()
  try {
    const ws = workstation(brain.url, { use_claude_cli: true })
    for (let k = 0; k < 5; k++) writeFileSync(join(ws.proj, `s${k}.jsonl`), user(`s${k}`, `QZX${k} How do we deploy the API?`, 60 - k) + assistant(`s${k}`, "We decided to deploy with Vercel.", 59 - k))
    const err = join(ws.proj, "err.jsonl")
    writeFileSync(err, user("err", "QZXERR1 A conversation that crashes the CLI", 90) + assistant("err", "OK.", 89))

    // The same unknown error on every call: stop after 3 calls, no attempt counted.
    cli.setMode("weird")
    const out1 = capture()
    const r1 = await withPath(cli.bin, () => runSync({}, out1.io))
    assert.equal(r1.failed, 6)
    assert.ok(cli.calls().length <= 4, `calls: ${cli.calls().length}`)
    assert.match(out1.text(), /General outage \(every call fails the same way\): no attempt is counted/)
    assert.ok(Object.values(ws.state().distill_failures ?? {}).every((f) => (f as { n: number }).n === 0))
    assert.equal(ws.state().claude?.files?.[err], undefined)

    // Claude is back: the conversations never in failure go first, the one that crashes the CLI is counted.
    cli.setMode("")
    const before = cli.calls().length
    await withPath(cli.bin, () => runSync({}, capture().io))
    const run2 = cli.calls().slice(before)
    // Order: s2, s3, s4 (never in failure), then err, s0, s1 (already in failure); 2 calls at a time.
    assert.ok(run2.findIndex((c) => c.tags.includes("QZXERR1")) >= 2, `order: ${run2.map((c) => c.tags.join("+"))}`)
    assert.deepEqual(tags(brain.ingested), ["QZX0", "QZX1", "QZX2", "QZX3", "QZX4"])
    assert.equal(ws.state().distill_failures?.err?.n, 1)
    // Alone in the queue next (Claude answers no call): the failure proves nothing, it is not counted.
    const out3 = capture()
    await withPath(cli.bin, () => runSync({}, out3.io))
    assert.equal(ws.state().distill_failures?.err?.n, 1)
    assert.match(out3.text(), /General outage \(Claude answered no call\): no attempt is counted/)
    // As soon as Claude answers other conversations in the same sync, the failure counts: given up on the 3rd.
    for (const k of [5, 6]) {
      writeFileSync(join(ws.proj, `s${k}.jsonl`), user(`s${k}`, `QZX${k} How do we test the API?`, 30) + assistant(`s${k}`, "We decided to test with Vitest.", 29))
      const out = capture()
      await withPath(cli.bin, () => runSync({}, out.io))
      if (k === 5) assert.equal(ws.state().distill_failures?.err?.n, 2)
      else assert.match(out.text(), /1 conversation given up after 3 unsuccessful attempts/)
    }
    assert.ok(ws.state().claude.files[err])
    assert.deepEqual(tags(brain.ingested), ["QZX0", "QZX1", "QZX2", "QZX3", "QZX4", "QZX5", "QZX6"])
    assert.ok(!JSON.stringify(brain.received).includes("QZXERR"))
  } finally {
    await brain.close()
  }
})

test("R-LIMIT: a Screenpipe window that always makes the CLI fail (unknown error, nothing else to distill) frees the checkpoint within a day", async () => {
  const brain = await mockBrain()
  const cli = fakeClaude()
  const now = Date.now()
  const start = now - 2 * 3600_000
  const rows: Row[] = [
    { n: 0, at: start, app: "Terminal", window: "claude — stuck", text: "QZXERR1 Conversation that crashes the CLI." },
    { n: 1, at: start + 20_000, app: "Terminal", window: "claude — stuck", text: "QZXERR1 rest of the conversation." },
  ]
  for (let i = 0; i < 2600; i++) rows.push({ n: i + 2, at: start + 60_000 + i * 2500, app: "Terminal", window: `claude — finance ${Math.floor(i / 100)}`, text: `QZXW${Math.floor(i / 100)} bank reconciliation line ${i}` })
  const sp = await screenpipe(rows)
  try {
    const ws = workstation(brain.url, { use_claude_cli: true, screenpipe_url: sp.url, sources: ["screenpipe"] })
    const entry = () => {
      const all = Object.values(ws.state().distill_failures ?? {}) as { n: number; tries?: number }[]
      assert.ok(all.length <= 1, "a single conversation in failure")
      return all[0]
    }
    // 1st pass: the other windows go (Claude answers) → the failure is conclusive (1/3).
    await withPath(cli.bin, () => runSync({ limit: 200 }, capture().io))
    assert.equal(entry()?.n, 1)
    const lastWindow = (t: string[]) => Math.max(...t.filter((x) => x.startsWith("QZXW")).map((x) => Number(x.slice(4))))
    const firstPass = lastWindow(tags(brain.ingested))
    // Then only the stuck window is attempted, without any answer from Claude: nothing conclusive, not given up.
    for (let run = 2; run <= 5; run++) {
      await withPath(cli.bin, () => runSync({ limit: 200 }, capture().io))
      assert.equal(entry()?.n, 1)
      assert.equal(entry()?.tries, run)
      assert.equal(ws.state().screenpipe?.last_timestamp, undefined)
    }
    // The next day (failures for more than 24 h, at least 5 attempts): given up, the checkpoint moves forward, the rest is read.
    const state = ws.state()
    for (const f of Object.values(state.distill_failures) as { first_at?: string }[]) f.first_at = new Date(now - 25 * 3_600_000).toISOString()
    writeFileSync(join(process.env.COMPANY_BRAIN_HOME!, "state.json"), JSON.stringify(state))
    const out = capture()
    await withPath(cli.bin, () => runSync({ limit: 200 }, out.io))
    assert.match(out.text(), /1 conversation given up after more than 24 h of failures/)
    assert.ok(ws.state().screenpipe?.last_timestamp, "Screenpipe checkpoint still stuck")
    await withPath(cli.bin, () => runSync({ limit: 200 }, capture().io))
    assert.ok(lastWindow(tags(brain.ingested)) > firstPass, "the rest was never read")
    assert.ok(!JSON.stringify(brain.received).includes("QZXERR"))
  } finally {
    await brain.close()
    await sp.close()
  }
})
