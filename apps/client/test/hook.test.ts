import { strict as assert } from "node:assert"
import { spawn } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { after, before, test } from "node:test"
import { promptFingerprint } from "@brain/core"
import { buildInstallPrompt } from "../../web/lib/install-prompt"
import type { Cache } from "../src/config"
import { eventForHook } from "../src/hook"
import { TEST_ZONES, mockServer, tempDir, type Recorded } from "./helpers"

const clientDir = fileURLToPath(new URL("..", import.meta.url))
let srv: Awaited<ReturnType<typeof mockServer>>
let home: string

before(async () => {
  srv = await mockServer((req) => (req.url === "/api/events" ? { status: 201, body: { recorded: 1, zones: [] } } : undefined))
  home = tempDir()
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, "config.json"), JSON.stringify({ url: srv.url, token: "cb_test_token_123456", screenpipe_url: "http://127.0.0.1:9", use_claude_cli: false, sources: ["claude"] }))
  writeFileSync(
    join(home, "cache.json"),
    JSON.stringify({
      updated_at: new Date().toISOString(),
      whoami: { name: "Hugo Bernard", org: "Fournil", role: "member", readable: ["dev"], writable: ["dev"] },
      zones: TEST_ZONES,
    }),
  )
})

after(() => srv.close())

// Asynchronous spawn: the fake server runs in this process and must be able to answer.
function runHook(input: unknown, env: Record<string, string> = {}): Promise<{ status: number | null; stdout: string; ms: number }> {
  const t0 = Date.now()
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "hook"], {
      cwd: clientDir,
      env: { ...process.env, COMPANY_BRAIN_HOME: home, COMPANY_BRAIN_INTERNAL: "", ...env },
    })
    let stdout = ""
    child.stdout.on("data", (d) => (stdout += d))
    child.on("close", (status) => resolve({ status, stdout, ms: Date.now() - t0 }))
    child.stdin.end(typeof input === "string" ? input : JSON.stringify(input))
  })
}

function lastEvent(): Recorded | undefined {
  return srv.requests.filter((r) => r.url === "/api/events").at(-1)
}

test("UserPromptSubmit: sends zones + fingerprint + redacted summary, writes nothing on stdout", async () => {
  const before = srv.requests.length
  const prompt = "How do I deploy the Supabase migration to production? my key sk-ant-api03-abcdefghijklmnopqrstuvwxyz"
  const r = await runHook({ session_id: "sess-1", transcript_path: "/tmp/x.jsonl", cwd: "/w", hook_event_name: "UserPromptSubmit", prompt })
  assert.equal(r.status, 0)
  assert.equal(r.stdout, "")
  assert.equal(srv.requests.length, before + 1)
  const ev = lastEvent()!
  assert.equal(ev.headers.authorization, "Bearer cb_test_token_123456")
  const body = ev.body as Record<string, unknown>
  assert.equal(body.agent, "claude-code")
  assert.equal(body.type, "query")
  assert.deepEqual(body.zones, ["dev"])
  assert.equal(body.fingerprint, promptFingerprint(prompt))
  assert.equal(body.session_id, "sess-1")
  assert.ok(typeof body.summary === "string" && body.summary.length <= 160)
  assert.ok(!String(body.summary).includes("sk-ant"))
  assert.match(String(body.summary), /\[secret redacted\]/)
})

test("SessionStart: a single line of context + started event", async () => {
  const r = await runHook({ session_id: "sess-2", hook_event_name: "SessionStart", source: "startup" })
  assert.equal(r.status, 0)
  const lines = r.stdout.trim().split("\n")
  assert.equal(lines.length, 1)
  assert.match(lines[0], /Company brain for Fournil connected/)
  assert.match(lines[0], /Dev/)
  assert.match(lines[0], /search_brain/)
  assert.match(lines[0], /company-brain/)
  assert.deepEqual(lastEvent()!.body, { agent: "claude-code", type: "started", session_id: "sess-2" })
})

test("Stop: stopped event; unknown event ignored", async () => {
  await runHook({ session_id: "sess-3", hook_event_name: "Stop" })
  assert.deepEqual(lastEvent()!.body, { agent: "claude-code", type: "stopped", session_id: "sess-3" })
  const n = srv.requests.length
  const r = await runHook({ session_id: "sess-3", hook_event_name: "PreToolUse" })
  assert.equal(r.status, 0)
  assert.equal(srv.requests.length, n)
})

test("COMPANY_BRAIN_INTERNAL=1: no request, no output", async () => {
  const n = srv.requests.length
  const r = await runHook({ hook_event_name: "SessionStart" }, { COMPANY_BRAIN_INTERNAL: "1" })
  assert.equal(r.status, 0)
  assert.equal(r.stdout, "")
  assert.equal(srv.requests.length, n)
})

test("invalid JSON or brain unreachable: code 0, fast", async () => {
  assert.equal((await runHook("not json")).status, 0)
  const badHome = tempDir()
  writeFileSync(join(badHome, "config.json"), JSON.stringify({ url: "http://10.255.255.1:81", token: "cb_x" }))
  const r = await runHook({ hook_event_name: "UserPromptSubmit", prompt: "test" }, { COMPANY_BRAIN_HOME: badHome })
  assert.equal(r.status, 0)
  assert.equal(r.stdout, "")
  assert.ok(r.ms < 6000, `too slow: ${r.ms} ms`)
})

const CACHE: Cache = { updated_at: "", zones: TEST_ZONES }
const prompt = (p: string) => ({ session_id: "s", hook_event_name: "UserPromptSubmit", prompt: p })

test("eventForHook: personal prompt → no summary, no fingerprint, no zone (even if classified by keyword)", () => {
  for (const p of [
    "REVIEWPRIV3 write a whatsapp message to my wife: I will be late tonight",
    "book me a doctolib appointment for my son, and check the school canteen invoice",
  ]) {
    const ev = eventForHook(prompt(p), CACHE)!
    assert.deepEqual(ev, { agent: "claude-code", type: "query", zones: [], session_id: "s" }, p)
  }
})

test("eventForHook: prompt without a zone → fingerprint only, no summary", () => {
  const p = "What is the best way to structure a pivot table?"
  const ev = eventForHook(prompt(p), CACHE)!
  assert.deepEqual(ev.zones, [])
  assert.equal(ev.summary, undefined)
  assert.equal(ev.fingerprint, promptFingerprint(p))
})

test("eventForHook: prompt in a project that a zone lists → that zone", () => {
  const cache: Cache = { updated_at: "", zones: [...TEST_ZONES, { id: "fournil", name: "Fournil", description: "", keywords: [], projects: ["fournil"], readable: true }] }
  const p = "How do I deploy the Supabase migration to production?"
  assert.deepEqual(eventForHook({ ...prompt(p), cwd: "/home/hugo/fournil/api" }, cache)!.zones, ["fournil"])
  assert.deepEqual(eventForHook({ ...prompt(p), cwd: "/home/hugo/other" }, cache)!.zones, ["dev"])
})

test("eventForHook: prompt classified in a zone → redacted summary; share_prompt_summaries=false → never a summary", () => {
  const p = "How do I deploy the Supabase migration to production?"
  const ev = eventForHook(prompt(p), CACHE)!
  assert.deepEqual(ev.zones, ["dev"])
  assert.equal(ev.summary, p)
  const off = eventForHook(prompt(p), CACHE, { shareSummaries: false })!
  assert.deepEqual(off.zones, ["dev"])
  assert.equal(off.summary, undefined)
  assert.equal(off.fingerprint, promptFingerprint(p))
})

test("eventForHook: install prompt or the computer's token pasted → nothing of the text goes", () => {
  const install = buildInstallPrompt({ baseUrl: "https://c.example", token: "cb_tqoelDcQG1aiU0jik075v5hdhINhmVhv", name: "Hugo", orgName: "Fournil", zones: ["dev"] })
  assert.deepEqual(eventForHook(prompt(install), CACHE), { agent: "claude-code", type: "query", zones: [], session_id: "s" })
  const pasted = "The production deployment returns 401 with my token cb_tqoelDcQG1aiU0jik075v5hdhINhmVhv, why?"
  assert.deepEqual(eventForHook(prompt(pasted), CACHE), { agent: "claude-code", type: "query", zones: [], session_id: "s" })
  const literal = "The production deployment fails with the key mysecretkey-123456789"
  assert.deepEqual(eventForHook(prompt(literal), CACHE, { secrets: ["mysecretkey-123456789"] }), { agent: "claude-code", type: "query", zones: [], session_id: "s" })
})

test("real hook: share_prompt_summaries=false in the config → event without a summary", async () => {
  const off = tempDir()
  writeFileSync(join(off, "config.json"), JSON.stringify({ url: srv.url, token: "cb_test_token_123456", share_prompt_summaries: false }))
  writeFileSync(join(off, "cache.json"), JSON.stringify({ updated_at: new Date().toISOString(), zones: TEST_ZONES }))
  const p = "How do I deploy the Supabase migration to production?"
  const r = await runHook({ session_id: "sess-off", hook_event_name: "UserPromptSubmit", prompt: p }, { COMPANY_BRAIN_HOME: off })
  assert.equal(r.status, 0)
  const body = lastEvent()!.body as Record<string, unknown>
  assert.equal(body.session_id, "sess-off")
  assert.deepEqual(body.zones, ["dev"])
  assert.equal(body.summary, undefined)
  assert.equal(body.fingerprint, promptFingerprint(p))
})

test("real hook: personal prompt → the event sent does not contain the text", async () => {
  const p = "VRFPRIV1 write a whatsapp message to my wife: I will be late tonight"
  await runHook({ session_id: "sess-personal", hook_event_name: "UserPromptSubmit", prompt: p })
  const ev = lastEvent()!
  assert.deepEqual(ev.body, { agent: "claude-code", type: "query", zones: [], session_id: "sess-personal" })
})

test("eventForHook: a configured secret of the computer (Screenpipe token, Claude Code token) is never sent, even when not recognizable", () => {
  // Assembled at run time: no plain secret pattern in the repo.
  const spTok = ["sp", "-local-", "Kd83hQpz2Lm"].join("")
  const cache: Cache = { updated_at: "", zones: TEST_ZONES.map((z) => ({ ...z })) }
  const prompt = `The API deployment to production fails with ${spTok} in the code`
  // Prompt containing a configured secret: nothing of the text goes.
  const e = eventForHook({ hook_event_name: "UserPromptSubmit", prompt }, cache, { secrets: [spTok] })
  assert.deepEqual(e, { agent: "claude-code", type: "query", zones: [], session_id: undefined })
  // Without the secret in the list, the text goes through redact(): the value is not recognized as a generic secret…
  const plain = eventForHook({ hook_event_name: "UserPromptSubmit", prompt }, cache, {})
  assert.ok(plain?.summary?.includes(spTok))
})
