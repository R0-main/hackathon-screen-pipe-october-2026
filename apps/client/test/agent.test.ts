// Screenpipe agent: window looked at, engine choice (Claude Code or Codex), read-only tools, token never as an
// argument, filters before sending, checkpoint that only moves once the knowledge is sent.

import { strict as assert } from "node:assert"
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import {
  AGENT_MAX_WINDOW_MS,
  AGENT_WINDOW_MS,
  SCREENPIPE_READ_TOOLS,
  agentWindow,
  claudeAgentArgs,
  codexAgentArgs,
  pickAgentEngine,
  screenpipeMcpServer,
} from "../src/agent"
import { runSync } from "../src/sync"
import { fakeClaude, withPath } from "./fake-claude"
import { mockServer, tempDir } from "./helpers"
import { mockBrain } from "./mock-brain"

const SP_TOKEN = "sp_local_token_abcdef123456"

function capture() {
  const out: string[] = []
  return { io: { log: (s: string) => out.push(s), warn: (s: string) => out.push(s) }, text: () => out.join("\n") }
}

function workstation(brainUrl: string, spUrl: string, extra: Record<string, unknown> = {}) {
  const home = tempDir()
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({ url: brainUrl, token: "cb_test_token_123456", screenpipe_url: spUrl, screenpipe_token: SP_TOKEN, use_claude_cli: true, sources: ["screenpipe"], ...extra }),
  )
  process.env.COMPANY_BRAIN_HOME = home
  process.env.CLAUDE_CONFIG_DIR = tempDir()
  process.env.CODEX_HOME = tempDir()
  delete process.env.ANTHROPIC_API_KEY
  return { home, state: () => JSON.parse(readFileSync(join(home, "state.json"), "utf8")) }
}

/** Screenpipe reachable, with no capture at all: only the agent has something to say. */
async function screenpipe() {
  return mockServer((req) => {
    const path = req.url.split("?")[0]
    if (path === "/health") return { body: { status: "healthy" } }
    if (path === "/search") return { body: { data: [], pagination: { total: 0 } } }
    if (path === "/meetings") return { body: [] }
    if (path === "/workflows") return { body: { workflows: [] } }
    return undefined
  })
}

/** Fake `codex` CLI: logs the arguments and token received, writes the final answer to the `-o` file. */
function fakeCodex() {
  const dir = tempDir("fake-codex-")
  const bin = join(dir, "bin")
  mkdirSync(bin, { recursive: true })
  writeFileSync(
    join(bin, "codex"),
    `#!${process.execPath}
const fs = require("fs")
const args = process.argv.slice(2)
let input = ""
process.stdin.on("data", (d) => (input += d))
process.stdin.on("end", () => {
  fs.appendFileSync(${JSON.stringify(join(dir, "calls.jsonl"))}, JSON.stringify({ args, key: process.env.SCREENPIPE_LOCAL_API_KEY ?? null, prompt: input }) + "\\n")
  const items = [{ zone: "dev", kind: "decision", title: "Customer reminders on Mondays", body: "Decided in review: reminders go out every Monday.", entities: [], confidence: 0.8 }]
  fs.writeFileSync(args[args.indexOf("-o") + 1], JSON.stringify({ items }))
  console.log("OpenAI Codex (fake)")
})
`,
  )
  chmodSync(join(bin, "codex"), 0o755)
  return {
    bin,
    calls: (): { args: string[]; key: string | null; prompt: string }[] => {
      try {
        return readFileSync(join(dir, "calls.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
      } catch {
        return []
      }
    },
  }
}

const agentCalls = (cli: ReturnType<typeof fakeClaude>) => cli.calls().filter((c) => c.args.includes("--mcp-config"))

test("agentWindow: 15 min the first time, since the previous run afterwards, 60 min at most, nothing under 5 min", () => {
  const now = new Date("2026-10-17T14:00:00Z")
  const first = agentWindow({}, now)!
  assert.equal(now.getTime() - first.start.getTime(), AGENT_WINDOW_MS)
  const next = agentWindow({ screenpipe: { agent_until: "2026-10-17T13:35:00Z" } }, now)!
  assert.equal(next.start.toISOString(), "2026-10-17T13:35:00.000Z")
  const afterSleep = agentWindow({ screenpipe: { agent_until: "2026-10-16T18:00:00Z" } }, now)!
  assert.equal(now.getTime() - afterSleep.start.getTime(), AGENT_MAX_WINDOW_MS)
  assert.equal(agentWindow({ screenpipe: { agent_until: "2026-10-17T13:57:00Z" } }, now), null)
  // Nothing earlier than when the scheduled sync was set up.
  assert.equal(agentWindow({}, now, new Date("2026-10-17T13:58:00Z")), null)
})

test("pickAgentEngine: Claude Code first, otherwise Codex, or the required engine", () => {
  const both = (cmd: string) => `/usr/bin/${cmd}`
  const onlyCodex = (cmd: string) => (cmd === "codex" ? "/usr/bin/codex" : null)
  assert.deepEqual(pickAgentEngine({}, both), { engine: "claude", path: "/usr/bin/claude" })
  assert.deepEqual(pickAgentEngine({}, onlyCodex), { engine: "codex", path: "/usr/bin/codex" })
  assert.deepEqual(pickAgentEngine({ use_claude_cli: false }, both), { engine: "codex", path: "/usr/bin/codex" })
  assert.deepEqual(pickAgentEngine({ screenpipe_agent: "codex" }, both), { engine: "codex", path: "/usr/bin/codex" })
  assert.equal(pickAgentEngine({ screenpipe_agent: "claude" }, onlyCodex), null)
  assert.equal(pickAgentEngine({ screenpipe_agent: false }, both), null)
})

test("arguments: only the Screenpipe MCP, read-only tools, cheap model, token never as an argument", () => {
  const server = screenpipeMcpServer({ screenpipe_url: "http://localhost:3030" }, "codex", "/opt/node/bin/node", "linux", "/usr/bin")
  assert.equal(server.env.PATH, "/opt/node/bin:/usr/bin")
  assert.ok(server.args.includes("screenpipe-mcp@0.20.3"))

  const claude = claudeAgentArgs("/usr/bin/claude", "/tmp/mcp.json")
  assert.equal(claude[claude.indexOf("--model") + 1], "sonnet")
  assert.ok(claude.includes("--strict-mcp-config"))
  const allowed = claude[claude.indexOf("--allowedTools") + 1].split(",")
  assert.deepEqual(allowed, SCREENPIPE_READ_TOOLS.map((t) => `mcp__screenpipe__${t}`))
  assert.ok(claude[claude.indexOf("--disallowedTools") + 1].split(",").includes("Bash"))
  const custom = claudeAgentArgs("/usr/bin/claude", "/tmp/mcp.json", "haiku")
  assert.equal(custom[custom.indexOf("--model") + 1], "haiku")

  const codex = codexAgentArgs(server, "/tmp/agent", "/tmp/agent/out.txt")
  const joined = codex.join(" ")
  assert.ok(!codex.includes("-m"), "Codex keeps its default model")
  assert.match(joined, /--ignore-user-config/)
  assert.match(joined, /--sandbox read-only/)
  assert.match(joined, /--disable shell_tool/)
  assert.match(joined, /approval_policy="never"/)
  assert.match(joined, /model_reasoning_effort="low"/)
  assert.match(joined, /mcp_servers\.screenpipe\.enabled_tools=\["activity-summary","search-content","keyword-search","list-meetings","get-meeting"\]/)
  assert.match(joined, /mcp_servers\.screenpipe\.env_vars=\["SCREENPIPE_LOCAL_API_KEY"\]/)
  assert.equal(codex[codex.length - 1], "-")
  assert.ok(codexAgentArgs(server, "/tmp/agent", "/tmp/agent/out.txt", "gpt-6-luna").join(" ").includes("-m gpt-6-luna"))
})

test("sync + Claude Code agent: work knowledge sent, personal dropped, window moved once sent", async () => {
  const brain = await mockBrain()
  const sp = await screenpipe()
  const cli = fakeClaude()
  try {
    const ws = workstation(brain.url, sp.url)
    const out = capture()
    await withPath(cli.bin, () => runSync({}, out.io))
    assert.match(out.text(), /Screenpipe agent \(Claude Code, .*\): 1 knowledge item proposed, 1 dropped \(personal content\)/)
    const sent = JSON.stringify(brain.received)
    assert.match(sent, /FOUR-42/)
    assert.ok(!/[Dd]octor|sick leave/.test(sent), "personal knowledge sent")
    const item = (brain.received as { source: { tool: string; app: string } }[])[0]
    assert.deepEqual([item.source.tool, item.source.app], ["agent", "Screenpipe"])
    assert.ok(ws.state().screenpipe.agent_until, "agent window not saved")

    const calls = agentCalls(cli)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].internal, "1", "agent session not marked internal")
    const mcpFile = calls[0].args[calls[0].args.indexOf("--mcp-config") + 1]
    assert.equal(statSync(mcpFile).mode & 0o777, 0o600)
    const mcp = JSON.parse(readFileSync(mcpFile, "utf8"))
    assert.equal(mcp.mcpServers.screenpipe.env.SCREENPIPE_LOCAL_API_KEY, SP_TOKEN)
    assert.equal(mcp.mcpServers.screenpipe.env.SCREENPIPE_API_URL, sp.url)
    assert.ok(!calls[0].args.join(" ").includes(SP_TOKEN))

    // Sync run again right away: window too short, the agent waits for the next run.
    await withPath(cli.bin, () => runSync({}, capture().io))
    assert.equal(agentCalls(cli).length, 1)
  } finally {
    await brain.close()
    await sp.close()
  }
})

test("failing agent: nothing sent, window read again on the next run; agent off: no call", async () => {
  const brain = await mockBrain()
  const sp = await screenpipe()
  const cli = fakeClaude()
  try {
    const ws = workstation(brain.url, sp.url)
    cli.setMode("network")
    const out = capture()
    await withPath(cli.bin, () => runSync({}, out.io))
    assert.match(out.text(), /Screenpipe agent \(Claude Code, .*\): failed .*window read again on the next run/)
    assert.equal(brain.received.length, 0)
    assert.equal(ws.state().screenpipe?.agent_until, undefined)

    cli.setMode("")
    await withPath(cli.bin, () => runSync({}, capture().io))
    assert.equal(agentCalls(cli).length, 2)
    assert.match(JSON.stringify(brain.received), /FOUR-42/)

    workstation(brain.url, sp.url, { screenpipe_agent: false })
    await withPath(cli.bin, () => runSync({}, capture().io))
    assert.equal(agentCalls(cli).length, 2)
  } finally {
    await brain.close()
    await sp.close()
  }
})

test("dry run: the agent shows in the preview, --confirm sends it and moves its window", async () => {
  const brain = await mockBrain()
  const sp = await screenpipe()
  const cli = fakeClaude()
  try {
    const ws = workstation(brain.url, sp.url)
    const dry = capture()
    await withPath(cli.bin, () => runSync({ dryRun: true }, dry.io))
    assert.match(dry.text(), /\[dev\] fact — Ticket FOUR-42/)
    assert.equal(brain.received.length, 0)
    await withPath(cli.bin, () => runSync({ confirm: true }, capture().io))
    assert.match(JSON.stringify(brain.received), /FOUR-42/)
    assert.ok(ws.state().screenpipe.agent_until)
  } finally {
    await brain.close()
    await sp.close()
  }
})

test("sync + Codex agent (no Claude Code): token through the environment, final answer read and sent", async () => {
  const brain = await mockBrain()
  const sp = await screenpipe()
  const codex = fakeCodex()
  try {
    const ws = workstation(brain.url, sp.url, { use_claude_cli: false })
    const out = capture()
    await withPath(codex.bin, () => runSync({}, out.io))
    assert.match(out.text(), /Screenpipe agent \(Codex, .*\): 1 knowledge item proposed\./)
    assert.match(JSON.stringify(brain.received), /Customer reminders on Mondays/)
    assert.ok(ws.state().screenpipe.agent_until)
    const [call] = codex.calls()
    assert.equal(call.key, SP_TOKEN)
    assert.ok(!call.args.join(" ").includes(SP_TOKEN))
    assert.match(call.prompt, /activity-summary/)
    assert.equal(call.args[0], "exec")
  } finally {
    await brain.close()
    await sp.close()
  }
})
