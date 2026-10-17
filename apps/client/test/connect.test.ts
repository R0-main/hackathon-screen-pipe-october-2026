// `connect-claude`: token asked for at install, tried with the fake CLI, kept on the computer only if it works.

import { strict as assert } from "node:assert"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import { cmdConnectClaude, hasScheduledClaude } from "../src/connect"
import { fakeClaude, withPath } from "./fake-claude"
import { tempDir } from "./helpers"

const TOKEN = ["sk-ant-oat01-", "A".repeat(60)].join("")

function workstation() {
  const home = tempDir()
  writeFileSync(join(home, "config.json"), JSON.stringify({ url: "http://127.0.0.1:9", token: "cb_test_token_123456", sources: ["claude"] }))
  process.env.COMPANY_BRAIN_HOME = home
  delete process.env.ANTHROPIC_API_KEY
  return { config: () => JSON.parse(readFileSync(join(home, "config.json"), "utf8")) }
}

test("connect-claude: setup-token run, token pasted, tried then kept on the computer", async () => {
  const ws = workstation()
  const cli = fakeClaude()
  let setupRan = false
  const out: string[] = []
  assert.equal(hasScheduledClaude(), false)
  const code = await withPath(cli.bin, () =>
    cmdConnectClaude((s) => out.push(s), { isTTY: true, runSetupToken: () => (setupRan = true), readToken: async () => TOKEN }),
  )
  assert.equal(code, 0)
  assert.ok(setupRan, "claude setup-token run")
  assert.equal(ws.config().claude_oauth_token, TOKEN)
  assert.ok(hasScheduledClaude())
  assert.equal(cli.calls()[0].token, TOKEN, "the token is tried with claude -p")
  assert.ok(!out.join("\n").includes(TOKEN), "never shown in full")
})

test("connect-claude: token refused by Claude, wrong format or no terminal → nothing saved", async () => {
  const ws = workstation()
  const cli = fakeClaude()
  cli.setMode("expired")
  const deps = { isTTY: true, runSetupToken: () => true, readToken: async () => TOKEN }
  await assert.rejects(withPath(cli.bin, () => cmdConnectClaude(() => {}, deps)), /Claude/)
  await assert.rejects(withPath(cli.bin, () => cmdConnectClaude(() => {}, { ...deps, readToken: async () => "not-a-token" })), /sk-ant-oat/)
  await assert.rejects(withPath(cli.bin, () => cmdConnectClaude(() => {}, { ...deps, isTTY: false })), /terminal/)
  assert.equal(ws.config().claude_oauth_token, undefined)
})
