import { strict as assert } from "node:assert"
import { spawn } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { after, before, test } from "node:test"
import { promptFingerprint } from "@brain/core"
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

// spawn asynchrone : le faux serveur tourne dans ce processus et doit pouvoir répondre.
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

test("UserPromptSubmit : envoie zones + empreinte + résumé masqué, n'écrit rien sur stdout", async () => {
  const before = srv.requests.length
  const prompt = "Comment déployer la migration Supabase en production ? ma clé sk-ant-api03-abcdefghijklmnopqrstuvwxyz"
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
  assert.match(String(body.summary), /\[secret masqué\]/)
})

test("SessionStart : une seule ligne de contexte + événement started", async () => {
  const r = await runHook({ session_id: "sess-2", hook_event_name: "SessionStart", source: "startup" })
  assert.equal(r.status, 0)
  const lines = r.stdout.trim().split("\n")
  assert.equal(lines.length, 1)
  assert.match(lines[0], /Cerveau d'entreprise de Fournil connecté/)
  assert.match(lines[0], /Dev/)
  assert.match(lines[0], /search_brain/)
  assert.match(lines[0], /company-brain/)
  assert.deepEqual(lastEvent()!.body, { agent: "claude-code", type: "started", session_id: "sess-2" })
})

test("Stop : événement stopped ; événement inconnu ignoré", async () => {
  await runHook({ session_id: "sess-3", hook_event_name: "Stop" })
  assert.deepEqual(lastEvent()!.body, { agent: "claude-code", type: "stopped", session_id: "sess-3" })
  const n = srv.requests.length
  const r = await runHook({ session_id: "sess-3", hook_event_name: "PreToolUse" })
  assert.equal(r.status, 0)
  assert.equal(srv.requests.length, n)
})

test("COMPANY_BRAIN_INTERNAL=1 : aucune requête, aucune sortie", async () => {
  const n = srv.requests.length
  const r = await runHook({ hook_event_name: "SessionStart" }, { COMPANY_BRAIN_INTERNAL: "1" })
  assert.equal(r.status, 0)
  assert.equal(r.stdout, "")
  assert.equal(srv.requests.length, n)
})

test("JSON invalide ou cerveau injoignable : code 0, rapide", async () => {
  assert.equal((await runHook("pas du json")).status, 0)
  const badHome = tempDir()
  writeFileSync(join(badHome, "config.json"), JSON.stringify({ url: "http://10.255.255.1:81", token: "cb_x" }))
  const r = await runHook({ hook_event_name: "UserPromptSubmit", prompt: "test" }, { COMPANY_BRAIN_HOME: badHome })
  assert.equal(r.status, 0)
  assert.equal(r.stdout, "")
  assert.ok(r.ms < 6000, `trop lent : ${r.ms} ms`)
})
