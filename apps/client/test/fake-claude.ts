// Fake `claude` CLI (Node script) for the tests: never the real one. Every call is logged (arguments, token,
// QZX… tags of the prompt); the answer depends on the `mode` file (can change during a test) and on the prompt.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { delimiter, join } from "node:path"
import { tempDir } from "./helpers"

export type FakeClaudeCall = { args: string[]; token: string | null; internal: string | null; simple: string | null; mode: string; tags: string[]; status: boolean }

/**
 * Modes: "" (normal), "expired" (expired OAuth token, stderr, code 1), "revoked-json" (is_error 401 envelope, code 1),
 * "login" (is_error envelope "Please run /login", code 0), "network" (Connection error), "weird" (same unknown error
 * on every call), "limit" (subscription limit of the current CLI: is_error envelope with api_error_status 429, code 1),
 * "limit-text" (same limit, text only on stderr, no status), "limit-ok" (the limit text returned as a normal
 * answer, is_error false, code 0). In normal mode: a prompt with QZXBAD gets a refusal in prose (unreadable
 * output), a prompt with QZXERR an unknown error (code 1); otherwise one decision per QZX… tag found (dev zone).
 * `allow(n)`: the next n calls answer normally whatever the mode (limit reached during a sync).
 */
export function fakeClaude(opts: { help?: string } = {}) {
  const dir = tempDir("fake-claude-")
  const bin = join(dir, "bin")
  mkdirSync(bin, { recursive: true })
  const script = `#!${process.execPath}
const fs = require("fs")
const dir = ${JSON.stringify(dir)}
if (process.argv[2] === "--help") { console.log(${JSON.stringify(opts.help ?? "--no-session-persistence --tools")}); process.exit(0) }
let input = ""
process.stdin.on("data", (d) => (input += d))
process.stdin.on("end", () => {
  let mode = ""
  try { mode = fs.readFileSync(dir + "/mode", "utf8").trim() } catch {}
  const tags = [...new Set(input.match(/QZX[A-Z]*\\d+/g) || [])]
  const status = input.includes('"headline"')
  fs.appendFileSync(dir + "/calls.jsonl", JSON.stringify({ args: process.argv.slice(2), token: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null, internal: process.env.COMPANY_BRAIN_INTERNAL ?? null, simple: process.env.CLAUDE_CODE_SIMPLE ?? null, mode, tags, status }) + "\\n")
  const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n")
  // allow(n): normal answer as long as this is not past the n-th call since allow().
  let allowUntil = 0
  try { allowUntil = Number(fs.readFileSync(dir + "/allow", "utf8")) || 0 } catch {}
  if (fs.readFileSync(dir + "/calls.jsonl", "utf8").split("\\n").filter(Boolean).length <= allowUntil) mode = ""
  if (mode === "expired") { process.stderr.write("OAuth token has expired. Please obtain a new token or refresh your existing token.\\n"); process.exit(1) }
  if (mode === "revoked-json") { out({ type: "result", subtype: "success", is_error: true, duration_ms: 401, result: 'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token revoked · Please run /login"}}' }); process.exit(1) }
  if (mode === "login") { out({ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login" }); return }
  if (mode === "network") { process.stderr.write("API Error: Connection error.\\n"); process.exit(1) }
  if (mode === "weird") { process.stderr.write("Unexpected error\\n"); process.exit(1) }
  const limit = "You've hit your session limit · resets 3pm"
  if (mode === "limit") { out({ type: "result", subtype: "success", is_error: true, api_error_status: 429, duration_ms: 640, result: limit }); process.exit(1) }
  if (mode === "limit-text") { process.stderr.write("You've hit your weekly limit · resets Oct 20, 3pm\\n"); process.exit(1) }
  if (mode === "limit-ok") { out({ type: "result", subtype: "success", is_error: false, result: limit }); return }
  if (/QZXBAD/.test(input)) { out({ type: "result", is_error: false, result: "Sorry, I would rather not process this conversation." }); return }
  if (/QZXERR/.test(input)) { process.stderr.write("Unexpected error\\n"); process.exit(1) }
  if (status) {
    const s = { headline: "Fournil is moving forward.", zones: [{ zone: "dev", summary: "Supabase chosen.", objectives: [], progress: "In progress", next_steps: [], who_did_what: [] }] }
    out({ type: "result", is_error: false, result: JSON.stringify(s) })
    return
  }
  const items = tags.map((t) => ({ zone: "dev", kind: "decision", title: "Decision " + t, body: "We keep Supabase (" + t + ").", entities: [], confidence: 0.9 }))
  out({ type: "result", is_error: false, result: JSON.stringify({ items }) })
})
`
  writeFileSync(join(bin, "claude"), script)
  chmodSync(join(bin, "claude"), 0o755)
  return {
    bin,
    setMode: (mode: string) => writeFileSync(join(dir, "mode"), mode),
    allow: (n: number) => writeFileSync(join(dir, "allow"), String((existsSync(join(dir, "calls.jsonl")) ? readFileSync(join(dir, "calls.jsonl"), "utf8").split("\n").filter(Boolean).length : 0) + n)),
    calls: (): FakeClaudeCall[] =>
      existsSync(join(dir, "calls.jsonl"))
        ? readFileSync(join(dir, "calls.jsonl"), "utf8")
            .split("\n")
            .filter(Boolean)
            .map((l) => JSON.parse(l) as FakeClaudeCall)
        : [],
  }
}

/** PATH limited to the fake CLI and the system tools (never the real `claude`, installed next to node on this machine). */
export async function withPath<T>(bin: string | null, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.PATH
  process.env.PATH = [bin, "/usr/bin", "/bin"].filter(Boolean).join(delimiter)
  try {
    return await fn()
  } finally {
    process.env.PATH = prev
  }
}
