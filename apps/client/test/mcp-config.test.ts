// One MCP server per company in Claude Code and Codex: names, addresses, Codex's config.toml, registration.

import { strict as assert } from "node:assert"
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { delimiter, join } from "node:path"
import { after, before, test } from "node:test"
import { companyMcpName, companyMcpUrl, maskedUrl, mcpSpecs, readClaudeMcp, readCodexMcp, registerMcpServers, unregisterMcpServers, writeCodexMcp, type McpCompany } from "../src/mcp-config"
import { tempDir } from "./helpers"

const POSIX = process.platform !== "win32"
const FOURNIL: McpCompany = { url: "https://brain.example/", token: "cb_fournilfournilfournil1234", id: "org-1", name: "Fournil" }
const ACME: McpCompany = { url: "https://brain.example", token: "cb_acmeacmeacmeacmeacme12345", id: "org-2", name: "Acme & Co" }

test("name and address of a company's MCP server: its name, the company id and the token", () => {
  assert.equal(companyMcpName(FOURNIL), "nos-brainer-fournil")
  assert.equal(companyMcpName(ACME), "nos-brainer-acme-co")
  assert.equal(companyMcpName({ ...FOURNIL, name: undefined, id: "63168a75-e4d7" }), "nos-brainer-63168a75", "no name: start of the id")
  assert.equal(companyMcpUrl(FOURNIL), "https://brain.example/api/mcp/org-1/cb_fournilfournilfournil1234")
  const twins = mcpSpecs([FOURNIL, { ...ACME, name: "Fournil" }])
  assert.deepEqual(
    twins.map((s) => s.name),
    ["nos-brainer-fournil", "nos-brainer-fournil-2"],
    "two companies with the same name: distinct names",
  )
  assert.equal(maskedUrl(companyMcpUrl(FOURNIL)), "https://brain.example/api/mcp/org-1/cb_four…", "the logs do not show the token")
})

test("Codex: config.toml completed without touching the rest, updated, then cleaned up; mode 600", () => {
  const file = join(tempDir("codex-"), "config.toml")
  const original = [
    'model = "gpt-5"',
    "",
    "[mcp_servers.figma]",
    'url = "https://mcp.figma.com/mcp"',
    "",
    "[mcp_servers.figma.http_headers]",
    '"X-Region" = "eu"',
    "",
    "[profiles.fast]",
    'model = "gpt-5-mini"',
    "",
  ].join("\n")
  writeFileSync(file, original)
  const specs = mcpSpecs([FOURNIL, ACME])
  assert.equal(writeCodexMcp(specs, file), true)
  const text = readFileSync(file, "utf8")
  assert.ok(text.startsWith(original.trimEnd()), "the rest of the file is intact")
  assert.match(text, /# NOS Brainer, company: Fournil\n\[mcp_servers\.nos-brainer-fournil\]\nurl = "https:\/\/brain\.example\/api\/mcp\/org-1\/cb_fournil/)
  assert.deepEqual(readCodexMcp(file), { "nos-brainer-fournil": companyMcpUrl(FOURNIL), "nos-brainer-acme-co": companyMcpUrl(ACME) })
  if (POSIX) assert.equal(statSync(file).mode & 0o777, 0o600, "it contains the tokens")
  assert.equal(writeCodexMcp(specs, file), false, "nothing to change: file not rewritten")

  // Acme removed from the computer, new token for Fournil: a single table, up to date.
  const fresh = { ...FOURNIL, token: "cb_newtokennewtokennewtoken99" }
  assert.equal(writeCodexMcp(mcpSpecs([fresh]), file), true)
  assert.deepEqual(readCodexMcp(file), { "nos-brainer-fournil": companyMcpUrl(fresh) })
  assert.equal((readFileSync(file, "utf8").match(/\[mcp_servers\.nos-brainer-/g) ?? []).length, 1)
  assert.match(readFileSync(file, "utf8"), /\[mcp_servers\.figma\.http_headers\]\n"X-Region" = "eu"/, "the other servers and their subtables stay")

  writeCodexMcp([], file)
  assert.equal(readFileSync(file, "utf8"), `${original.trimEnd()}\n`, "removing everything gives back the original file")

  // A table written by an earlier (French) version: replaced, its comment too.
  writeFileSync(file, `${original}\n# NOS Brainer, entreprise : Fournil\n[mcp_servers.nos-brainer-fournil]\nurl = ${JSON.stringify(companyMcpUrl(FOURNIL))}\n`)
  writeCodexMcp([], file)
  assert.equal(readFileSync(file, "utf8"), `${original.trimEnd()}\n`, "legacy comment removed")
})

test("Claude Code: only our servers (prefix and brain endpoint address) are read", () => {
  const file = join(tempDir("claude-json-"), ".claude.json")
  assert.deepEqual(readClaudeMcp(file), {}, "no file: nothing")
  writeFileSync(
    file,
    JSON.stringify({
      mcpServers: {
        "company-brain": { type: "stdio", command: "node", args: ["brain.mjs", "mcp"] },
        "nos-brainer-fournil": { type: "http", url: companyMcpUrl(FOURNIL) },
        "nos-brainer-other": { type: "http", url: "https://other.example/mcp" },
        figma: { type: "http", url: "https://mcp.figma.com/mcp" },
      },
    }),
  )
  assert.deepEqual(readClaudeMcp(file), { "nos-brainer-fournil": companyMcpUrl(FOURNIL) })
  writeFileSync(file, "{ not json")
  assert.equal(readClaudeMcp(file), undefined)
})

// Fake `claude` CLI: logs its arguments and keeps ~/.claude.json like the real one (mcp add / remove).
let home: string
let saved: Record<string, string | undefined>
before(() => {
  home = tempDir("mcp-register-")
  const bin = join(home, "bin")
  mkdirSync(bin)
  const claude = join(bin, "claude")
  writeFileSync(
    claude,
    `#!${process.execPath}
const fs = require("fs"), path = require("path")
const file = path.join(process.env.CLAUDE_CONFIG_DIR, ".claude.json")
fs.appendFileSync(path.join(${JSON.stringify(home)}, "calls.log"), JSON.stringify(process.argv.slice(2)) + "\\n")
const data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {}
data.mcpServers ??= {}
const [cmd, sub, ...rest] = process.argv.slice(2)
// mcp add --transport http --scope user <name> <address>
if (cmd === "mcp" && sub === "add") data.mcpServers[rest[4]] = { type: "http", url: rest[5] }
if (cmd === "mcp" && sub === "remove") { if (!data.mcpServers[rest[0]]) process.exit(1); delete data.mcpServers[rest[0]] }
fs.writeFileSync(file, JSON.stringify(data))
`,
  )
  chmodSync(claude, 0o755)
  mkdirSync(join(home, "claude"))
  mkdirSync(join(home, "codex"))
  saved = { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME }
  process.env.PATH = `${bin}${delimiter}${process.env.PATH}`
  process.env.CLAUDE_CONFIG_DIR = join(home, "claude")
  process.env.CODEX_HOME = join(home, "codex")
})
after(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

const calls = () => (existsSync(join(home, "calls.log")) ? readFileSync(join(home, "calls.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]) : [])

test("registration: each company in Claude Code (claude mcp add --transport http) and in Codex; nothing twice", { skip: !POSIX }, () => {
  const out: string[] = []
  assert.equal(registerMcpServers(mcpSpecs([FOURNIL, ACME]), (s) => out.push(s)), true)
  assert.deepEqual(calls(), [
    ["mcp", "add", "--transport", "http", "--scope", "user", "nos-brainer-fournil", companyMcpUrl(FOURNIL)],
    ["mcp", "add", "--transport", "http", "--scope", "user", "nos-brainer-acme-co", companyMcpUrl(ACME)],
  ])
  assert.deepEqual(Object.keys(readClaudeMcp() ?? {}), ["nos-brainer-fournil", "nos-brainer-acme-co"])
  assert.deepEqual(Object.keys(readCodexMcp()), ["nos-brainer-fournil", "nos-brainer-acme-co"])
  assert.ok(!out.join("\n").includes(FOURNIL.token), "the token does not show in the messages")
  assert.match(out.join("\n"), /MCP nos-brainer-fournil \(Fournil\) plugged into Claude Code/)

  // Run again: nothing to redo. Acme removed: its server disappears on both sides.
  const before = calls().length
  registerMcpServers(mcpSpecs([FOURNIL]), () => {})
  assert.deepEqual(calls().slice(before), [["mcp", "remove", "nos-brainer-acme-co", "--scope", "user"]])
  assert.deepEqual(Object.keys(readClaudeMcp() ?? {}), ["nos-brainer-fournil"])
  assert.deepEqual(Object.keys(readCodexMcp()), ["nos-brainer-fournil"])

  // uninstall: everything of ours goes.
  unregisterMcpServers(() => {})
  assert.deepEqual(readClaudeMcp(), {})
  assert.deepEqual(readCodexMcp(), {})
})

test("Claude desktop app alone (no `claude` CLI in the PATH): servers written into ~/.claude.json, the rest kept", { skip: !POSIX }, () => {
  const file = join(process.env.CLAUDE_CONFIG_DIR!, ".claude.json")
  const path = process.env.PATH
  process.env.PATH = tempDir("no-claude-")
  try {
    const figma = { type: "http", url: "https://mcp.figma.com/mcp" }
    writeFileSync(file, JSON.stringify({ numStartups: 3, projects: { "/work": { allowedTools: [] } }, mcpServers: { figma } }))
    const callsBefore = calls().length
    const out: string[] = []
    assert.equal(registerMcpServers(mcpSpecs([FOURNIL, ACME]), (s) => out.push(s)), true)
    assert.equal(calls().length, callsBefore, "no CLI run")
    const data = JSON.parse(readFileSync(file, "utf8"))
    assert.equal(data.numStartups, 3)
    assert.deepEqual(data.projects, { "/work": { allowedTools: [] } })
    assert.deepEqual(data.mcpServers.figma, figma)
    assert.deepEqual(data.mcpServers["nos-brainer-fournil"], { type: "http", url: companyMcpUrl(FOURNIL) })
    assert.deepEqual(Object.keys(readClaudeMcp() ?? {}), ["nos-brainer-fournil", "nos-brainer-acme-co"])
    assert.equal(statSync(file).mode & 0o777, 0o600)
    assert.ok(!out.join("\n").includes(FOURNIL.token), "the token does not show in the messages")
    assert.match(out.join("\n"), /MCP nos-brainer-fournil \(Fournil\) plugged into Claude Code/)

    // Acme removed: its server disappears, Fournil's is already there.
    out.length = 0
    assert.equal(registerMcpServers(mcpSpecs([FOURNIL]), (s) => out.push(s)), true)
    assert.deepEqual(Object.keys(readClaudeMcp() ?? {}), ["nos-brainer-fournil"])
    assert.match(out.join("\n"), /nos-brainer-fournil \(Fournil\): already plugged/)
    assert.match(out.join("\n"), /nos-brainer-acme-co removed/)

    // uninstall: ours go, the others stay.
    unregisterMcpServers(() => {})
    assert.deepEqual(readClaudeMcp(), {})
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).mcpServers, { figma })

    // Unreadable file: never overwritten.
    writeFileSync(file, "{ not json")
    out.length = 0
    assert.equal(registerMcpServers(mcpSpecs([FOURNIL]), (s) => out.push(s)), false)
    assert.equal(readFileSync(file, "utf8"), "{ not json")
    assert.ok(!out.join("\n").includes(FOURNIL.token))
  } finally {
    process.env.PATH = path
  }
})
