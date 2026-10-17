// `claude -p`: never in --bare mode (it ignores CLAUDE_CODE_OAUTH_TOKEN), and an expired or revoked token
// ("Please run /login") is an outage of the computer, with a clear message, never a failure counted per conversation.

import { strict as assert } from "node:assert"
import { chmodSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import type { StatusInput } from "@brain/core"
import { apiFailure, classifyFailure, claudeCliArgs, claudeCliEnv, cliFailure, runClaudeCli, statusFailure, unreadableFailure } from "../src/distill"
import { cmdRefreshStatus } from "../src/refresh-status"
import { runSync } from "../src/sync"
import { fakeClaude, withPath } from "./fake-claude"
import { mockServer, tempDir } from "./helpers"
import { mockBrain } from "./mock-brain"

const srcDir = fileURLToPath(new URL("../src", import.meta.url))
// The fake CLI lists --bare in its help: it must never be used.
const HELP = "--bare --no-session-persistence --tools --model"
// Assembled at run time: no plain token pattern in the repo.
const CLAUDE_TOKEN = ["sk-ant-", "oat01-", "Tk4", "w".repeat(48)].join("")

const ts = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString()
const line = (o: unknown) => JSON.stringify(o) + "\n"
const session = (s: string, q: string, a: string, minAgo: number) =>
  line({ type: "user", sessionId: s, timestamp: ts(minAgo), message: { role: "user", content: q } }) +
  line({ type: "assistant", sessionId: s, timestamp: ts(minAgo - 1), message: { role: "assistant", content: [{ type: "text", text: a }], stop_reason: "end_turn" } })

function capture() {
  const out: string[] = []
  return { io: { log: (s: string) => out.push(s), warn: (s: string) => out.push(s) }, log: (s: string) => out.push(s), text: () => out.join("\n") }
}

function station(url: string, token = "cb_test_token_123456", extra: Record<string, unknown> = {}) {
  const home = tempDir()
  const claude = tempDir()
  const proj = join(claude, "projects", "p")
  mkdirSync(proj, { recursive: true })
  writeFileSync(join(home, "config.json"), JSON.stringify({ url, token, screenpipe_url: "http://127.0.0.1:9", use_claude_cli: true, sources: ["claude"], ...extra }), { mode: 0o600 })
  process.env.COMPANY_BRAIN_HOME = home
  process.env.CLAUDE_CONFIG_DIR = claude
  process.env.CODEX_HOME = tempDir()
  delete process.env.ANTHROPIC_API_KEY
  return { home, proj, state: () => JSON.parse(readFileSync(join(home, "state.json"), "utf8")) }
}

const AUTH_HELP = /Claude Code is no longer signed in on this computer: the Claude token has expired or was revoked/
// The command quoted is the computer's own: the ~/.company-brain/brain shortcut if it exists, otherwise Node.js and the script.
const AUTH_STEPS = /Run `claude setup-token`, then `[^`]+ init --claude-token <token>` \(or `claude \/login`\)/

test("classifyFailure / cliFailure: expired or revoked token, /login, network, quotas; the rest is specific to the conversation", () => {
  for (const t of [
    "OAuth token has expired. Please obtain a new token or refresh your existing token.",
    "Not logged in · Please run /login",
    "Invalid API key · Please run /login",
    'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token revoked"}}',
    "OAuth access token has been revoked",
  ])
    assert.equal(classifyFailure(t), "auth", t)
  for (const t of ["API Error: Connection error.", "spawn claude ENOENT", "API Error: 529 Overloaded", "Claude AI usage limit reached|1760000000", "API Error: 429 rate_limit_error", "getaddrinfo ENOTFOUND api.anthropic.com", "Credit balance is too low"])
    assert.equal(classifyFailure(t), "outage", t)
  // Subscription limits, as the installed CLI writes them.
  for (const t of [
    "You've hit your session limit · resets 3pm",
    "You've hit your weekly limit · resets Oct 20, 3pm",
    "You've hit your Opus limit · resets Oct 20, 3pm · /upgrade to keep using Claude Code",
    "You've hit your limit",
    "You're out of usage credits · resets 3pm",
    "Your org is out of usage · add funds to continue",
    "Session limit reached",
    "5-hour limit reached ∙ resets 3pm",
    "API Error: Rate limit exceeded",
    "Overloaded",
  ])
    assert.equal(classifyFailure(t), "outage", t)
  for (const t of ["Prompt is too long", "Unexpected error", "timeout of 120 s exceeded", "Error: max turns reached (duration 401 ms, 529 tokens)"]) assert.equal(classifyFailure(t), "conversation", t)

  // is_error envelope with code 0: failure, classified on its `result` (the numeric fields do not count).
  assert.deepEqual(cliFailure({ stdout: JSON.stringify({ is_error: true, duration_ms: 401, result: "Not logged in · Please run /login" }) })?.failure, "auth")
  assert.deepEqual(cliFailure({ stdout: JSON.stringify({ is_error: true, duration_ms: 401, result: "Prompt is too long" }) }), {
    error: "Prompt is too long",
    failure: "conversation",
    signature: "Prompt is too long",
  })
  // Normal answer (even in prose): not a failure of the CLI.
  assert.equal(cliFailure({ stdout: JSON.stringify({ is_error: false, duration_ms: 401, result: "Sorry, I can't." }) }), null)

  // Numeric HTTP status of the envelope (api_error_status): 401/403 → sign-in, 429/529/5xx → outage, whatever the text.
  const env = (status: number, result = "Unexpected error") => cliFailure({ stdout: JSON.stringify({ type: "result", is_error: true, api_error_status: status, duration_ms: 640, result }) })
  assert.deepEqual(env(429, "You've hit your session limit · resets 3pm"), { error: "You've hit your session limit · resets 3pm", failure: "outage" })
  for (const [status, kind] of [[401, "auth"], [403, "auth"], [429, "outage"], [500, "outage"], [503, "outage"], [529, "outage"]] as const) assert.equal(env(status)?.failure, kind, String(status))
  assert.equal(env(400)?.failure, "conversation", "400: classified on the text")
  assert.equal(env(400, "Not logged in · Please run /login")?.failure, "auth")
  assert.equal(statusFailure("429"), null, "only a number counts")
  assert.equal(statusFailure(null), null)

  // Output without JSON: the model answered (failure specific to the conversation)… except a short text that reads like an
  // error of the CLI, which proves nothing (handled as an unknown error, with a signature), never as an outage.
  assert.equal(unreadableFailure(JSON.stringify({ is_error: false, result: "Sorry, I would rather not process this conversation." })).signature, undefined)
  const lim = unreadableFailure(JSON.stringify({ is_error: false, result: "You've hit your session limit · resets 3pm" }))
  assert.equal(lim.failure, "conversation")
  assert.equal(lim.signature, "You've hit your session limit · resets 3pm")
  assert.equal(unreadableFailure(JSON.stringify({ is_error: false, result: `Summary: ${"we talk about the rate limit of the API. ".repeat(20)}` })).signature, undefined, "a long answer in prose is still an answer")
  assert.equal(unreadableFailure("").signature, "empty output")
  assert.equal(unreadableFailure(JSON.stringify({ type: "result", is_error: false })).signature, "empty output")

  // Anthropic API (status of the last HTTP call).
  assert.equal(apiFailure({ status: 401, body: '{"type":"authentication_error"}' }).failure, "auth")
  assert.equal(apiFailure({ status: 529 }).failure, "outage")
  assert.equal(apiFailure({ network: "fetch failed" }).failure, "outage")
  assert.equal(apiFailure({ status: 400, body: "Your credit balance is too low" }).failure, "outage")
  assert.equal(apiFailure({ status: 200 }).failure, "conversation")
  assert.equal(apiFailure({ status: 200 }).signature, undefined, "the model answered: Claude works")
})

test("NO-BARE: no `claude -p` (distillation, refresh-status) uses --bare, even if the CLI offers it", async () => {
  const cli = fakeClaude({ help: HELP })
  const brain = await mockBrain()
  const input: StatusInput = { company_name: "Fournil", generated_for: "2026-10-16", zones: [{ id: "dev", name: "Dev", description: "" }], items: [], tasks: [] }
  const status = await mockServer((req) => (req.url.startsWith("/api/status/input") ? { body: input } : undefined))
  try {
    const st = station(brain.url, "cb_test_token_123456", { claude_oauth_token: CLAUDE_TOKEN })
    writeFileSync(join(st.proj, "a.jsonl"), session("a", "QZX1 Which database do we go with?", "We go with Supabase.", 30))
    const r = await withPath(cli.bin, () => runSync({}, capture().io))
    assert.equal(r.sent, 1)
    station(status.url, "cb_admin", { claude_oauth_token: CLAUDE_TOKEN })
    assert.equal(await withPath(cli.bin, () => cmdRefreshStatus({ dryRun: true }, () => {})), 0)

    const calls = cli.calls()
    assert.ok(calls.some((c) => c.status) && calls.some((c) => !c.status), "distillation and refresh-status called")
    for (const c of calls) {
      assert.equal(c.args[0], "-p")
      assert.ok(!c.args.includes("--bare"), `--bare passed: ${c.args.join(" ")}`)
      assert.equal(c.token, CLAUDE_TOKEN, "the config token must reach claude -p")
    }
    assert.ok(!claudeCliArgs(join(cli.bin, "claude")).includes("--bare"))

    // A single place builds the arguments of `claude -p` (claudeCliArgs): no other launch that bypasses it.
    const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : [join(dir, n)]))
    const withP = files(srcDir).filter((f) => f.endsWith(".ts") && /["']-p["']/.test(readFileSync(f, "utf8")))
    assert.deepEqual(withP.map((f) => f.slice(srcDir.length + 1)), ["distill.ts"])
    assert.doesNotMatch(readFileSync(join(srcDir, "distill.ts"), "utf8"), /push\([^)]*["']--bare["']/)
  } finally {
    await brain.close()
    await status.close()
  }
})

test("TOKEN-EXPIRED: expired Claude token → clear message, outage (nothing counted, nothing given up), everything goes once signed in again", async () => {
  const cli = fakeClaude({ help: HELP })
  const brain = await mockBrain()
  try {
    const st = station(brain.url)
    const files = [0, 1, 2, 3, 4].map((k) => join(st.proj, `s${k}.jsonl`))
    files.forEach((f, k) => writeFileSync(f, session(`s${k}`, `QZX${k} How do we deploy the API?`, "We decided to deploy with Vercel.", 60 - k)))
    cli.setMode("expired")
    for (let run = 1; run <= 4; run++) {
      const before = cli.calls().length
      const out = capture()
      const r = await withPath(cli.bin, () => runSync({}, out.io))
      assert.equal(r.failed, 5)
      assert.equal(r.sent, 0)
      // Sign-in lost: we stop at once (at most the calls already started in parallel).
      assert.ok(cli.calls().length - before <= 2, `calls: ${cli.calls().length - before}`)
      assert.match(out.text(), AUTH_HELP)
      assert.match(out.text(), AUTH_STEPS)
      assert.match(out.text(), /OAuth token has expired/)
      assert.match(out.text(), /be distilled on the next sync, once Claude is signed in again \(no attempt counted\)/)
      assert.doesNotMatch(out.text(), /given up|Failure due to the content/)
      assert.equal(st.state().distill_failures, undefined, "outage counted as a conversation failure")
      for (const f of files) assert.equal(st.state().claude?.files?.[f], undefined)
    }
    cli.setMode("")
    const r = await withPath(cli.bin, () => runSync({}, capture().io))
    assert.equal(r.failed, 0)
    assert.equal(r.sent, 5)
  } finally {
    await brain.close()
  }
})

test("TOKEN-EXPIRED: revoked token (JSON envelope, code 1) and \"Please run /login\" (code 0) → same message, same outage", async () => {
  for (const mode of ["revoked-json", "login"]) {
    const cli = fakeClaude({ help: HELP })
    const brain = await mockBrain()
    try {
      const st = station(brain.url)
      for (let k = 0; k < 4; k++) writeFileSync(join(st.proj, `s${k}.jsonl`), session(`s${k}`, `QZX${k} Question?`, "Answer.", 30 - k))
      cli.setMode(mode)
      const out = capture()
      const r = await withPath(cli.bin, () => runSync({}, out.io))
      assert.equal(r.failed, 4, mode)
      assert.ok(cli.calls().length <= 2, `${mode}: ${cli.calls().length} calls`)
      assert.match(out.text(), AUTH_HELP)
      assert.match(out.text(), AUTH_STEPS)
      assert.match(out.text(), /Please run \/login/)
      assert.equal(st.state().distill_failures, undefined)
    } finally {
      await brain.close()
    }
  }
})

test("TOKEN-EXPIRED: refresh-status says what to do when the token has expired or was revoked", async () => {
  const input: StatusInput = { company_name: "Fournil", generated_for: "2026-10-16", zones: [{ id: "dev", name: "Dev", description: "" }], items: [], tasks: [] }
  const brain = await mockServer((req) => (req.url.startsWith("/api/status/input") ? { body: input } : undefined))
  try {
    station(brain.url, "cb_admin", { claude_oauth_token: CLAUDE_TOKEN })
    for (const mode of ["expired", "revoked-json", "login"]) {
      const cli = fakeClaude({ help: HELP })
      cli.setMode(mode)
      await assert.rejects(withPath(cli.bin, () => cmdRefreshStatus({}, () => {})), (err: Error) => {
        assert.match(err.message, AUTH_HELP, mode)
        assert.match(err.message, AUTH_STEPS, mode)
        assert.match(err.message, /run `refresh-status` again/)
        assert.ok(!err.message.includes(CLAUDE_TOKEN))
        return true
      })
    }
    // Other outage (network): generic failure message, not the token one.
    const cli = fakeClaude({ help: HELP })
    cli.setMode("network")
    await assert.rejects(withPath(cli.bin, () => cmdRefreshStatus({}, () => {})), /`claude -p` failed: code 1: API Error: Connection error/)
  } finally {
    await brain.close()
  }
})

test("TOKEN-EXPIRED: API key refused (401) by the Anthropic API → clear message, immediate stop, nothing counted", async () => {
  let calls = 0
  const anthropic = await mockServer(() => {
    calls++
    return { status: 401, body: { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } } }
  })
  const brain = await mockBrain()
  const prevBase = process.env.ANTHROPIC_BASE_URL
  process.env.ANTHROPIC_BASE_URL = anthropic.url
  const prevError = console.error
  console.error = () => {}
  try {
    const st = station(brain.url, "cb_test_token_123456", { anthropic_api_key: ["sk-ant-", "api03-", "z".repeat(30)].join("") })
    for (let k = 0; k < 6; k++) writeFileSync(join(st.proj, `s${k}.jsonl`), session(`s${k}`, `QZX${k} Question?`, "We decided to keep Supabase.", 30 - k))
    const out = capture()
    const r = await withPath(null, () => runSync({}, out.io))
    assert.equal(r.distiller, "claude-api")
    assert.equal(r.failed, 6)
    assert.match(out.text(), /Anthropic API key refused \("Anthropic API: HTTP 401/)
    assert.match(out.text(), /init --anthropic-key <key>/)
    // Concurrency 3: at most 3 conversations attempted (triage + extraction each), then stop.
    assert.ok(calls <= 6, `HTTP calls: ${calls}`)
    assert.equal(st.state().distill_failures, undefined)
  } finally {
    console.error = prevError
    if (prevBase === undefined) delete process.env.ANTHROPIC_BASE_URL
    else process.env.ANTHROPIC_BASE_URL = prevBase
    await brain.close()
    await anthropic.close()
  }
})

test("R-SIMPLE: CLAUDE_CODE_SIMPLE (same as --bare) is never passed to `claude -p`, which therefore reads the token", async () => {
  const base = { PATH: "/usr/bin", CLAUDE_CODE_SIMPLE: "1", HOME: "/home/x" }
  const env = claudeCliEnv({ oauthToken: CLAUDE_TOKEN }, base)
  assert.equal(env.CLAUDE_CODE_SIMPLE, undefined)
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, CLAUDE_TOKEN)
  assert.equal(env.COMPANY_BRAIN_INTERNAL, "1")
  assert.equal(base.CLAUDE_CODE_SIMPLE, "1", "the environment of the process is not changed")

  // End to end: brain.mjs started from a `claude --bare` session (inherited variable).
  const cli = fakeClaude({ help: HELP })
  const brain = await mockBrain()
  const prev = process.env.CLAUDE_CODE_SIMPLE
  process.env.CLAUDE_CODE_SIMPLE = "1"
  try {
    const st = station(brain.url, "cb_test_token_123456", { claude_oauth_token: CLAUDE_TOKEN })
    writeFileSync(join(st.proj, "a.jsonl"), session("a", "QZX1 Which database do we go with?", "We go with Supabase.", 30))
    const r = await withPath(cli.bin, () => runSync({}, capture().io))
    assert.equal(r.sent, 1)
    assert.ok(cli.calls().length > 0)
    for (const c of cli.calls()) {
      assert.equal(c.simple, null, "CLAUDE_CODE_SIMPLE passed to claude -p")
      assert.equal(c.token, CLAUDE_TOKEN)
    }
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CODE_SIMPLE
    else process.env.CLAUDE_CODE_SIMPLE = prev
    await brain.close()
  }
})

test("R-LIMIT: subscription limit (api_error_status 429), repeated syncs → nothing counted or given up, everything goes after the reset", async () => {
  const cli = fakeClaude({ help: HELP })
  const brain = await mockBrain()
  try {
    const st = station(brain.url)
    const f = join(st.proj, "lim.jsonl")
    writeFileSync(f, session("lim", "QZXLIM7 Do we move the database to Supabase this week?", "Yes, decision made: migration on Thursday.", 20))
    cli.setMode("limit")
    for (let run = 1; run <= 5; run++) {
      const out = capture()
      const r = await withPath(cli.bin, () => runSync({}, out.io))
      assert.equal(r.failed, 1)
      assert.match(out.text(), /You've hit your session limit/)
      assert.match(out.text(), /General outage \(Claude unreachable or overloaded\): no attempt is counted/)
      assert.doesNotMatch(out.text(), /given up|Failure due to the content/)
      assert.equal(st.state().distill_failures, undefined, "subscription limit counted as a failure of the conversation")
      assert.equal(st.state().claude?.files?.[f], undefined, "checkpoint moved forward during the limit")
    }
    // Same limit, text only (no envelope or status): recognized too.
    cli.setMode("limit-text")
    const out = capture()
    await withPath(cli.bin, () => runSync({}, out.io))
    assert.match(out.text(), /You've hit your weekly limit/)
    assert.equal(st.state().distill_failures, undefined)
    // The limit is lifted: the conversation goes.
    cli.setMode("")
    const r = await withPath(cli.bin, () => runSync({}, capture().io))
    assert.equal(r.sent, 1)
    assert.ok(JSON.stringify(brain.received).includes("QZXLIM7"))
    assert.ok(st.state().claude.files[f])
  } finally {
    await brain.close()
  }
})

test("R-LIMIT: limit reached during a sync (2 successful calls) → the following conversations are not counted", async () => {
  const cli = fakeClaude({ help: HELP })
  const brain = await mockBrain()
  try {
    const st = station(brain.url)
    for (let k = 0; k < 6; k++) writeFileSync(join(st.proj, `m${k}.jsonl`), session(`m${k}`, `QZXM${k} How do we deploy the API?`, "We decided to deploy with Vercel.", 60 - k))
    cli.setMode("limit")
    cli.allow(2)
    const out = capture()
    const r = await withPath(cli.bin, () => runSync({}, out.io))
    assert.equal(r.sent, 2)
    assert.equal(r.failed, 4)
    assert.match(out.text(), /Outage \(Claude unreachable or overloaded\): no attempt is counted/)
    assert.doesNotMatch(out.text(), /given up|Failure due to the content/)
    assert.deepEqual(Object.values(st.state().distill_failures ?? {}).filter((x) => (x as { n: number }).n > 0), [])
    cli.setMode("")
    const r2 = await withPath(cli.bin, () => runSync({}, capture().io))
    assert.equal(r2.failed, 0)
    assert.deepEqual(tagsOf(brain.ingested), ["QZXM0", "QZXM1", "QZXM2", "QZXM3", "QZXM4", "QZXM5"])
  } finally {
    await brain.close()
  }
})

const tagsOf = (v: unknown) => [...new Set([...JSON.stringify(v).matchAll(/QZX[A-Z]*\d+/g)].map((m) => m[0]))].sort()

test("R-LIMIT: unknown error without any answer from Claude (unknown outage wording) → never given up before 24 h and 5 attempts", async () => {
  const cli = fakeClaude({ help: HELP })
  const brain = await mockBrain()
  try {
    const st = station(brain.url)
    const f = join(st.proj, "w.jsonl")
    writeFileSync(f, session("w", "QZXW1 Do we keep Qonto for the cash?", "Yes, decision made.", 20))
    cli.setMode("weird")
    for (let run = 1; run <= 6; run++) {
      const out = capture()
      await withPath(cli.bin, () => runSync({}, out.io))
      assert.match(out.text(), /General outage \(Claude answered no call\): no attempt is counted/)
      assert.match(out.text(), /for more than 24 h \(at least 5 attempts\) will be given up/)
      assert.doesNotMatch(out.text(), /given up after|Failure due to the content/)
      const e = st.state().distill_failures?.w
      assert.equal(e?.n, 0, "attempt counted without proof")
      assert.equal(e?.tries, run)
      assert.equal(st.state().claude?.files?.[f], undefined)
    }
    // Same limit text returned as a normal answer (is_error false): proves nothing either.
    cli.setMode("limit-ok")
    await withPath(cli.bin, () => runSync({}, capture().io))
    assert.equal(st.state().distill_failures?.w?.n, 0)

    // Safeguard: the failures have lasted more than 24 h → given up, the checkpoint moves forward.
    cli.setMode("weird")
    const state = st.state()
    state.distill_failures.w.first_at = new Date(Date.now() - 25 * 3_600_000).toISOString()
    writeFileSync(join(st.home, "state.json"), JSON.stringify(state))
    const out = capture()
    await withPath(cli.bin, () => runSync({}, out.io))
    assert.match(out.text(), /1 conversation given up after more than 24 h of failures \(at least 5 attempts\): nothing was sent for it/)
    assert.equal(st.state().distill_failures, undefined)
    assert.ok(st.state().claude.files[f], "conversation stuck: checkpoint still not moved forward after 24 h")
    assert.ok(!JSON.stringify(brain.received).includes("QZXW1"))
  } finally {
    await brain.close()
  }
})

test("R-LIMIT: runClaudeCli classifies on api_error_status (non-zero code); timeout = unknown error (signature)", async () => {
  const dir = tempDir("cli-run-")
  const script = (name: string, body: string) => {
    const bin = join(dir, name)
    writeFileSync(bin, `#!${process.execPath}\nif (process.argv[2] === "--help") process.exit(0)\nprocess.stdin.resume()\n${body}\n`)
    chmodSync(bin, 0o755)
    return bin
  }
  const envelope = (status: number) => `process.stdin.on("end", () => { process.stdout.write(JSON.stringify({ type: "result", is_error: true, api_error_status: ${status}, duration_ms: 401, result: "Unexpected error" })); process.exit(1) })`
  for (const [status, kind] of [[529, "outage"], [429, "outage"], [401, "auth"], [400, "conversation"]] as const) {
    const run = await runClaudeCli(script(`s${status}`, envelope(status)), "prompt", 10_000)
    assert.equal(run.failure, kind, String(status))
    assert.equal(Boolean(run.signature), kind === "conversation", String(status))
  }
  const run = await runClaudeCli(script("slow", "setTimeout(() => process.exit(0), 5000)"), "prompt", 300)
  assert.equal(run.failure, "conversation")
  assert.equal(run.signature, "timeout")
  assert.deepEqual(cliFailure(run), { error: run.error, failure: "conversation", signature: "timeout" })
})
