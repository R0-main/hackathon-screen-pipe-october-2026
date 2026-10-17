// Un serveur MCP par entreprise dans Claude Code et Codex : noms, adresses, config.toml de Codex, enregistrement.

import { strict as assert } from "node:assert"
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { delimiter, join } from "node:path"
import { after, before, test } from "node:test"
import { companyMcpName, companyMcpUrl, maskedUrl, mcpSpecs, readClaudeMcp, readCodexMcp, registerMcpServers, unregisterMcpServers, writeCodexMcp, type McpCompany } from "../src/mcp-config"
import { tempDir } from "./helpers"

const POSIX = process.platform !== "win32"
const FOURNIL: McpCompany = { url: "https://cerveau.exemple/", token: "cb_fournilfournilfournil1234", id: "org-1", name: "Fournil" }
const ACME: McpCompany = { url: "https://cerveau.exemple", token: "cb_acmeacmeacmeacmeacme12345", id: "org-2", name: "Acme & Cie" }

test("nom et adresse du serveur MCP d'une entreprise : son nom, l'identifiant de l'entreprise et le jeton", () => {
  assert.equal(companyMcpName(FOURNIL), "nos-brainer-fournil")
  assert.equal(companyMcpName(ACME), "nos-brainer-acme-cie")
  assert.equal(companyMcpName({ ...FOURNIL, name: undefined, id: "63168a75-e4d7" }), "nos-brainer-63168a75", "sans nom : début de l'identifiant")
  assert.equal(companyMcpUrl(FOURNIL), "https://cerveau.exemple/api/mcp/org-1/cb_fournilfournilfournil1234")
  const twins = mcpSpecs([FOURNIL, { ...ACME, name: "Fournil" }])
  assert.deepEqual(
    twins.map((s) => s.name),
    ["nos-brainer-fournil", "nos-brainer-fournil-2"],
    "deux entreprises du même nom : noms distincts",
  )
  assert.equal(maskedUrl(companyMcpUrl(FOURNIL)), "https://cerveau.exemple/api/mcp/org-1/cb_four…", "les journaux ne montrent pas le jeton")
})

test("Codex : config.toml complété sans toucher au reste, mis à jour, puis nettoyé ; mode 600", () => {
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
    "[profiles.rapide]",
    'model = "gpt-5-mini"',
    "",
  ].join("\n")
  writeFileSync(file, original)
  const specs = mcpSpecs([FOURNIL, ACME])
  assert.equal(writeCodexMcp(specs, file), true)
  const text = readFileSync(file, "utf8")
  assert.ok(text.startsWith(original.trimEnd()), "le reste du fichier est intact")
  assert.match(text, /# NOS Brainer, entreprise : Fournil\n\[mcp_servers\.nos-brainer-fournil\]\nurl = "https:\/\/cerveau\.exemple\/api\/mcp\/org-1\/cb_fournil/)
  assert.deepEqual(readCodexMcp(file), { "nos-brainer-fournil": companyMcpUrl(FOURNIL), "nos-brainer-acme-cie": companyMcpUrl(ACME) })
  if (POSIX) assert.equal(statSync(file).mode & 0o777, 0o600, "il contient les jetons")
  assert.equal(writeCodexMcp(specs, file), false, "rien à changer : fichier non réécrit")

  // Acme retirée du poste, nouveau jeton pour Fournil : une seule table, à jour.
  const fresh = { ...FOURNIL, token: "cb_nouveaujetonnouveaujeton99" }
  assert.equal(writeCodexMcp(mcpSpecs([fresh]), file), true)
  assert.deepEqual(readCodexMcp(file), { "nos-brainer-fournil": companyMcpUrl(fresh) })
  assert.equal((readFileSync(file, "utf8").match(/\[mcp_servers\.nos-brainer-/g) ?? []).length, 1)
  assert.match(readFileSync(file, "utf8"), /\[mcp_servers\.figma\.http_headers\]\n"X-Region" = "eu"/, "les autres serveurs et leurs sous-tables restent")

  writeCodexMcp([], file)
  assert.equal(readFileSync(file, "utf8"), `${original.trimEnd()}\n`, "tout retirer rend le fichier d'origine")
})

test("Claude Code : seuls nos serveurs (préfixe et adresse d'endpoint de cerveau) sont lus", () => {
  const file = join(tempDir("claude-json-"), ".claude.json")
  assert.deepEqual(readClaudeMcp(file), {}, "pas de fichier : rien")
  writeFileSync(
    file,
    JSON.stringify({
      mcpServers: {
        "company-brain": { type: "stdio", command: "node", args: ["brain.mjs", "mcp"] },
        "nos-brainer-fournil": { type: "http", url: companyMcpUrl(FOURNIL) },
        "nos-brainer-autre": { type: "http", url: "https://autre.exemple/mcp" },
        figma: { type: "http", url: "https://mcp.figma.com/mcp" },
      },
    }),
  )
  assert.deepEqual(readClaudeMcp(file), { "nos-brainer-fournil": companyMcpUrl(FOURNIL) })
  writeFileSync(file, "{ pas du json")
  assert.equal(readClaudeMcp(file), undefined)
})

// Fausse CLI `claude` : journalise ses arguments et tient ~/.claude.json comme la vraie (mcp add / remove).
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
// mcp add --transport http --scope user <nom> <adresse>
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

test("enregistrement : chaque entreprise dans Claude Code (claude mcp add --transport http) et dans Codex ; rien en double", { skip: !POSIX }, () => {
  const out: string[] = []
  assert.equal(registerMcpServers(mcpSpecs([FOURNIL, ACME]), (s) => out.push(s)), true)
  assert.deepEqual(calls(), [
    ["mcp", "add", "--transport", "http", "--scope", "user", "nos-brainer-fournil", companyMcpUrl(FOURNIL)],
    ["mcp", "add", "--transport", "http", "--scope", "user", "nos-brainer-acme-cie", companyMcpUrl(ACME)],
  ])
  assert.deepEqual(Object.keys(readClaudeMcp() ?? {}), ["nos-brainer-fournil", "nos-brainer-acme-cie"])
  assert.deepEqual(Object.keys(readCodexMcp()), ["nos-brainer-fournil", "nos-brainer-acme-cie"])
  assert.ok(!out.join("\n").includes(FOURNIL.token), "le jeton n'apparaît pas dans les messages")
  assert.match(out.join("\n"), /MCP nos-brainer-fournil \(Fournil\) branché dans Claude Code/)

  // Relancé : rien à refaire. Acme retirée : son serveur disparaît des deux côtés.
  const before = calls().length
  registerMcpServers(mcpSpecs([FOURNIL]), () => {})
  assert.deepEqual(calls().slice(before), [["mcp", "remove", "nos-brainer-acme-cie", "--scope", "user"]])
  assert.deepEqual(Object.keys(readClaudeMcp() ?? {}), ["nos-brainer-fournil"])
  assert.deepEqual(Object.keys(readCodexMcp()), ["nos-brainer-fournil"])

  // uninstall : tout ce qui est à nous part.
  unregisterMcpServers(() => {})
  assert.deepEqual(readClaudeMcp(), {})
  assert.deepEqual(readCodexMcp(), {})
})
