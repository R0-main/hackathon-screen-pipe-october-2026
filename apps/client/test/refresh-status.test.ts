// refresh-status ("where does the company stand" summary produced on an admin's computer) and Claude Code token (init --claude-token).
// Never the real CLI: a fake `claude` records its environment, its arguments and its standard input.

import { strict as assert } from "node:assert"
import { spawn } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { delimiter, join } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import { DISTILL_MARKER, STATUS_SYSTEM, type StatusInput } from "@brain/core"
import { cmdInit, cmdStatus } from "../src/commands"
import { cmdRefreshStatus } from "../src/refresh-status"
import { runSync } from "../src/sync"
import { TEST_ZONES, mockServer, tempDir, type Recorded } from "./helpers"

const clientDir = fileURLToPath(new URL("..", import.meta.url))
const ADMIN = "cb_admin_token_abcdef"
const MEMBER = "cb_member_token_abcdef"
// Assembled at run time: no plain token pattern in the repo.
const CLAUDE_TOKEN = ["sk-ant-", "oat01-", "Rr7", "q".repeat(48)].join("")

const INPUT: StatusInput = {
  company_name: "Fournil",
  generated_for: "2026-10-16",
  zones: [
    { id: "dev", name: "Dev", description: "Code" },
    { id: "finance", name: "Finance", description: "Invoices" },
  ],
  items: [{ zone: "dev", kind: "decision", title: "We go with Supabase", body: "Choice approved.", author: "Hugo Bernard", created_at: "2026-10-15T10:00:00Z" }],
  tasks: [{ zone: "finance", title: "Close September", status: "open", assignee: "Jean-Marc" }],
}

/** Fake brain: /api/status/input and POST /api/status reserved to the admin (403 otherwise). */
async function statusBrain() {
  const saved: unknown[] = []
  const srv = await mockServer((req) => {
    const auth = req.headers.authorization
    if (auth !== `Bearer ${ADMIN}` && auth !== `Bearer ${MEMBER}`) return { status: 401, body: { error: "Not authenticated" } }
    const admin = auth === `Bearer ${ADMIN}`
    const path = req.url.split("?")[0]
    if (req.method === "GET" && path === "/api/whoami")
      return {
        body: {
          org: { name: "Fournil", description: "" },
          profile: { id: "u1", org_id: "o", name: "Claire Martin", role: admin ? "admin" : "member", created_at: "" },
          access: { isAdmin: admin, readable: ["dev", "finance"], writable: ["dev", "finance"] },
          context: null,
        },
      }
    if (req.method === "GET" && path === "/api/zones") return { body: { zones: TEST_ZONES } }
    if (path === "/api/status/input" || (path === "/api/status" && req.method === "POST")) {
      if (!admin) return { status: 403, body: { error: "Reserved to admins." } }
    }
    if (req.method === "GET" && path === "/api/status/input") return { body: INPUT }
    if (req.method === "POST" && path === "/api/status") {
      const status = (req.body as { status: { headline: string; zones: unknown[] } }).status
      saved.push(status)
      return { body: { ...status, generated_at: new Date().toISOString(), generator: "claude" } }
    }
    return undefined
  })
  return { ...srv, saved }
}

/** Fake `claude` CLI: records env, arguments and prompt; answers a summary (code block, unknown zone included). */
function fakeClaude() {
  const dir = tempDir()
  const bin = join(dir, "bin")
  mkdirSync(bin, { recursive: true })
  const status = {
    headline: "Fournil is moving forward: Supabase chosen, September closing in progress.",
    zones: [
      { zone: "dev", summary: "Supabase chosen.", objectives: ["Migrate"], progress: "In progress", next_steps: ["Write the runbook"], who_did_what: [{ person: "Hugo Bernard", did: "decided on Supabase" }] },
      { zone: "hr", summary: "Unknown zone", objectives: [], progress: "", next_steps: [], who_did_what: [] },
    ],
  }
  const items = { items: [{ zone: "dev", kind: "decision", title: "We go with Supabase", body: "Choice approved by the team.", entities: [], confidence: 0.9 }] }
  writeFileSync(join(dir, "status.json"), JSON.stringify({ type: "result", is_error: false, result: "Here is the summary:\n```json\n" + JSON.stringify(status) + "\n```" }))
  writeFileSync(join(dir, "items.json"), JSON.stringify({ result: JSON.stringify(items) }))
  writeFileSync(
    join(bin, "claude"),
    `#!/bin/sh
if [ "$1" = "--help" ]; then echo "--no-session-persistence --tools"; exit 0; fi
n=$(ls "${dir}" | grep -c '^call-')
d="${dir}/call-$n"
mkdir -p "$d"
cat > "$d/stdin"
echo "$@" > "$d/args"
printf '%s' "\${CLAUDE_CODE_OAUTH_TOKEN-<absent>}" > "$d/token"
printf '%s' "\${COMPANY_BRAIN_INTERNAL-<absent>}" > "$d/internal"
if grep -q '"headline"' "$d/stdin"; then cat "${dir}/status.json"; else cat "${dir}/items.json"; fi
`,
  )
  chmodSync(join(bin, "claude"), 0o755)
  const calls = () =>
    Array.from({ length: 20 }, (_, i) => join(dir, `call-${i}`))
      .filter((d) => existsSync(d))
      .map((d) => ({
        stdin: readFileSync(join(d, "stdin"), "utf8"),
        args: readFileSync(join(d, "args"), "utf8").trim(),
        token: readFileSync(join(d, "token"), "utf8"),
        internal: readFileSync(join(d, "internal"), "utf8"),
      }))
  return { bin, calls }
}

function station(url: string, token: string, extra: Record<string, unknown> = {}) {
  const home = tempDir()
  writeFileSync(join(home, "config.json"), JSON.stringify({ url, token, screenpipe_url: "http://127.0.0.1:9", sources: ["claude"], ...extra }), { mode: 0o600 })
  process.env.COMPANY_BRAIN_HOME = home
  process.env.CLAUDE_CONFIG_DIR = tempDir()
  process.env.CODEX_HOME = tempDir()
  delete process.env.ANTHROPIC_API_KEY
  return { home, config: () => JSON.parse(readFileSync(join(home, "config.json"), "utf8")) }
}

async function withPath<T>(bin: string | null, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.PATH
  process.env.PATH = [bin, "/usr/bin", "/bin"].filter(Boolean).join(delimiter)
  try {
    return await fn()
  } finally {
    process.env.PATH = prev
  }
}

function logs() {
  const out: string[] = []
  return { log: (s: string) => out.push(s), text: () => out.join("\n") }
}

test("F-claude-token: init --claude-token saves it (config 600), status redacts it, \"none\" removes it", async () => {
  const brain = await statusBrain()
  try {
    const st = station(brain.url, ADMIN)
    const l = logs()
    assert.equal(await cmdInit({ "claude-token": CLAUDE_TOKEN }, l.log), 0)
    assert.equal(st.config().claude_oauth_token, CLAUDE_TOKEN)
    assert.equal(statSync(join(st.home, "config.json")).mode & 0o777, 0o600)
    assert.match(l.text(), /Claude Code token saved/)
    assert.ok(!l.text().includes(CLAUDE_TOKEN))
    const s = logs()
    await cmdStatus(s.log)
    assert.match(s.text(), /Claude Code token : sk-ant…qqqq/)
    assert.ok(!s.text().includes(CLAUDE_TOKEN))
    await assert.rejects(cmdInit({ "claude-token": true }, () => {}), /give the token/)
    await assert.rejects(cmdInit({ "claude-token": "two words" }, () => {}), /invalid token/)
    await cmdInit({ "claude-token": "none" }, () => {})
    assert.equal(st.config().claude_oauth_token, undefined)
    assert.equal(st.config().token, ADMIN)
  } finally {
    await brain.close()
  }
})

test("F-refresh-status: Claude (claude -p) writes the summary on the computer, with the config token, then POST /api/status", async () => {
  const brain = await statusBrain()
  const claude = fakeClaude()
  try {
    station(brain.url, ADMIN, { claude_oauth_token: CLAUDE_TOKEN })
    const l = logs()
    assert.equal(await withPath(claude.bin, () => cmdRefreshStatus({}, l.log)), 0)
    const [call] = claude.calls()
    // The prompt arrives on standard input, starts with DISTILL_MARKER (session never ingested) and contains STATUS_SYSTEM.
    assert.ok(call.stdin.startsWith(DISTILL_MARKER))
    assert.ok(call.stdin.includes(STATUS_SYSTEM))
    assert.match(call.stdin, /We go with Supabase/)
    assert.match(call.args, /^-p --output-format json/)
    assert.equal(call.token, CLAUDE_TOKEN)
    assert.equal(call.internal, "1")
    // Only the known zones go (the made-up "hr" zone is dropped).
    assert.equal(brain.saved.length, 1)
    const sent = brain.saved[0] as { headline: string; zones: { zone: string }[] }
    assert.match(sent.headline, /Supabase chosen/)
    assert.deepEqual(sent.zones.map((z) => z.zone), ["dev"])
    assert.match(l.text(), /Company status updated \(Claude Code/)
    assert.ok(!l.text().includes(CLAUDE_TOKEN))
    const post = brain.requests.find((r: Recorded) => r.method === "POST" && r.url === "/api/status")
    assert.deepEqual(Object.keys(post?.body as object), ["status"])
  } finally {
    await brain.close()
  }
})

test("F-refresh-status --dry-run: shows the summary, sends nothing", async () => {
  const brain = await statusBrain()
  const claude = fakeClaude()
  try {
    station(brain.url, ADMIN)
    const l = logs()
    await withPath(claude.bin, () => cmdRefreshStatus({ dryRun: true }, l.log))
    assert.match(l.text(), /Where does the company stand\?/)
    assert.match(l.text(), /Supabase chosen/)
    assert.match(l.text(), /Nothing was sent \(dry run\)/)
    assert.equal(brain.saved.length, 0)
    // Without a token in the config, no CLAUDE_CODE_OAUTH_TOKEN is made up (the terminal's, if any, is kept).
    assert.equal(claude.calls()[0].token, process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "<absent>")
  } finally {
    await brain.close()
  }
})

test("F-refresh-status: reserved to admins (403 → clear message), without Claude or a key → clear message", async () => {
  const brain = await statusBrain()
  const claude = fakeClaude()
  try {
    station(brain.url, MEMBER)
    await assert.rejects(
      withPath(claude.bin, () => cmdRefreshStatus({}, () => {})),
      /reserved to the brain's administrators: your token does not have admin rights/,
    )
    station(brain.url, ADMIN)
    await assert.rejects(
      withPath(null, () => cmdRefreshStatus({}, () => {})),
      /Neither a `claude` CLI in the PATH nor an API key/,
    )
    assert.equal(brain.saved.length, 0)
  } finally {
    await brain.close()
  }
})

test("F-refresh-status: without a CLI but with an API key, the Anthropic SDK writes the summary", async () => {
  const brain = await statusBrain()
  const status = { headline: "Summary through the API.", zones: [{ zone: "finance", summary: "Closing in progress.", objectives: [], progress: "50%", next_steps: [], who_did_what: [] }] }
  const anthropic = await mockServer((req) =>
    req.method === "POST" && req.url.startsWith("/v1/messages")
      ? {
          body: {
            id: "msg_test",
            type: "message",
            role: "assistant",
            model: "claude-sonnet-5-5",
            content: [{ type: "text", text: JSON.stringify(status) }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 10 },
          },
        }
      : undefined,
  )
  const prevBase = process.env.ANTHROPIC_BASE_URL
  process.env.ANTHROPIC_BASE_URL = anthropic.url
  try {
    station(brain.url, ADMIN, { anthropic_api_key: ["sk-ant-", "api03-", "t".repeat(30)].join("") })
    const l = logs()
    await withPath(null, () => cmdRefreshStatus({}, l.log))
    assert.equal(anthropic.requests.length, 1)
    assert.match(String((anthropic.requests[0].body as { messages: { content: string }[] }).messages[0].content), /Close September/)
    assert.deepEqual(brain.saved, [{ headline: "Summary through the API.", zones: status.zones }])
    assert.match(l.text(), /Claude \(Anthropic API\)/)
  } finally {
    if (prevBase === undefined) delete process.env.ANTHROPIC_BASE_URL
    else process.env.ANTHROPIC_BASE_URL = prevBase
    await brain.close()
    await anthropic.close()
  }
})

test("F-claude-token: the distillation (claude -p) also receives CLAUDE_CODE_OAUTH_TOKEN", async () => {
  const brain = await mockServer((req) => {
    const path = req.url.split("?")[0]
    if (path === "/api/whoami") return { body: { org: { name: "F", description: "" }, profile: { id: "u", name: "Hugo" }, access: { isAdmin: false, readable: ["dev"], writable: ["dev"] }, context: null } }
    if (path === "/api/zones") return { body: { zones: TEST_ZONES } }
    if (path === "/api/ingest") return { status: 201, body: { inserted: 1, skipped: 0, ids: ["x"], zones: ["dev"] } }
    return undefined
  })
  const claude = fakeClaude()
  try {
    station(brain.url, MEMBER, { claude_oauth_token: CLAUDE_TOKEN, use_claude_cli: true })
    const proj = join(process.env.CLAUDE_CONFIG_DIR!, "projects", "p")
    mkdirSync(proj, { recursive: true })
    const at = (m: number) => new Date(Date.now() - m * 60_000).toISOString()
    writeFileSync(
      join(proj, "s.jsonl"),
      JSON.stringify({ type: "user", sessionId: "s", timestamp: at(30), message: { role: "user", content: "Which database do we go with?" } }) +
        "\n" +
        JSON.stringify({ type: "assistant", sessionId: "s", timestamp: at(29), message: { role: "assistant", content: [{ type: "text", text: "We go with Supabase." }], stop_reason: "end_turn" } }) +
        "\n",
    )
    const out: string[] = []
    const r = await withPath(claude.bin, () => runSync({}, { log: (s) => out.push(s), warn: (s) => out.push(s) }))
    assert.equal(r.distiller, "claude-cli")
    assert.match(out.join("\n"), /Claude Code token from the config/)
    const calls = claude.calls()
    assert.ok(calls.length >= 1)
    for (const c of calls) {
      assert.equal(c.token, CLAUDE_TOKEN)
      assert.equal(c.internal, "1")
    }
    assert.ok(!out.join("\n").includes(CLAUDE_TOKEN))
    assert.equal(r.sent, 1)
  } finally {
    await brain.close()
  }
})

test("CLI: refresh-status and --claude-token in the help; refresh-status as a non-admin → code 1 and a clear message", async () => {
  const brain = await statusBrain()
  const claude = fakeClaude()
  try {
    const st = station(brain.url, MEMBER)
    const run = (args: string[]) =>
      new Promise<{ code: number | null; out: string }>((resolve) => {
        const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
          cwd: clientDir,
          // PATH without node's folder (the real `claude` CLI is there on this computer): only the fake one is visible.
          env: { HOME: tempDir(), PATH: `${claude.bin}${delimiter}/usr/bin${delimiter}/bin`, COMPANY_BRAIN_HOME: st.home },
        })
        let out = ""
        child.stdout.on("data", (d) => (out += d))
        child.stderr.on("data", (d) => (out += d))
        child.on("close", (code) => resolve({ code, out }))
      })
    const help = await run(["help"])
    assert.match(help.out, /refresh-status \[--dry-run\]/)
    assert.match(help.out, /--claude-token <token>/)
    const denied = await run(["refresh-status"])
    assert.equal(denied.code, 1)
    assert.match(denied.out, /reserved to the brain's administrators/)
    assert.ok(!denied.out.includes("at "), "stack trace shown")
  } finally {
    await brain.close()
  }
})
