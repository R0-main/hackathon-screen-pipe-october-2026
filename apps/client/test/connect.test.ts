// `connect-claude` : jeton demandé à l'installation, essayé avec la fausse CLI, gardé sur le poste seulement s'il marche.

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

test("connect-claude : setup-token lancé, jeton collé, essayé puis gardé sur le poste", async () => {
  const ws = workstation()
  const cli = fakeClaude()
  let setupRan = false
  const out: string[] = []
  assert.equal(hasScheduledClaude(), false)
  const code = await withPath(cli.bin, () =>
    cmdConnectClaude((s) => out.push(s), { isTTY: true, runSetupToken: () => (setupRan = true), readToken: async () => TOKEN }),
  )
  assert.equal(code, 0)
  assert.ok(setupRan, "claude setup-token lancé")
  assert.equal(ws.config().claude_oauth_token, TOKEN)
  assert.ok(hasScheduledClaude())
  assert.equal(cli.calls()[0].token, TOKEN, "le jeton est essayé avec claude -p")
  assert.ok(!out.join("\n").includes(TOKEN), "jamais affiché en entier")
})

test("connect-claude : jeton refusé par Claude, mauvais format ou pas de terminal → rien d'enregistré", async () => {
  const ws = workstation()
  const cli = fakeClaude()
  cli.setMode("expired")
  const deps = { isTTY: true, runSetupToken: () => true, readToken: async () => TOKEN }
  await assert.rejects(withPath(cli.bin, () => cmdConnectClaude(() => {}, deps)), /Claude/)
  await assert.rejects(withPath(cli.bin, () => cmdConnectClaude(() => {}, { ...deps, readToken: async () => "pas-un-jeton" })), /sk-ant-oat/)
  await assert.rejects(withPath(cli.bin, () => cmdConnectClaude(() => {}, { ...deps, isTTY: false })), /terminal/)
  assert.equal(ws.config().claude_oauth_token, undefined)
})
