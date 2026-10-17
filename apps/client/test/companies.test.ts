// Several companies on one computer: init adds them next to the first one, the MCP tools take `company`.

import { strict as assert } from "node:assert"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { after, before, test } from "node:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { cmdInit } from "../src/commands"
import { cmdCompanies, describeCompanies, pickCompany } from "../src/companies"
import { companiesOf, loadCache, loadConfig, saveConfig, type Company } from "../src/config"
import { mockServer, tempDir } from "./helpers"
import { mockBrain } from "./mock-brain"

const clientDir = fileURLToPath(new URL("..", import.meta.url))
const FOURNIL_TOKEN = "cb_test_token_123456"
const ACME_TOKEN = "cb_acme_token_6543210"
const ACME_ITEM = {
  id: "a1",
  zone: "ops",
  kind: "procedure",
  title: "Weekend on-call at Acme",
  body: "The on-call phone rotates every Friday.",
  entities: [],
  source: { app: "Terminal", tool: "claude-code", at: "2026-10-10T09:00:00.000Z" },
  confidence: 0.8,
  created_at: "2026-10-10T09:00:00.000Z",
  author_id: "a",
  author: "Alice Martin",
}

/** Acme's fake brain: its tokens (two accounts of the same company), its "ops" zone. */
async function acmeBrain() {
  const ingested: { zone: string; title: string }[] = []
  const people: Record<string, string> = { [ACME_TOKEN]: "Alice Martin", cb_acme_other_9876543: "Bruno Petit" }
  const srv = await mockServer((req) => {
    const token = req.headers.authorization?.replace(/^Bearer /, "") ?? ""
    if (!people[token]) return { status: 401, body: { error: "Not authenticated" } }
    const path = req.url.split("?")[0]
    if (path === "/api/whoami")
      return {
        body: {
          org: { id: "org-acme", name: "Acme", description: "Web agency: sites and apps for clients" },
          profile: { id: token, org_id: "org-acme", name: people[token], role: "admin", created_at: "" },
          access: { isAdmin: true, readable: ["ops"], writable: ["ops"] },
          context: null,
        },
      }
    if (path === "/api/zones") return { body: { zones: [{ id: "ops", name: "Ops", description: "Operations", color: "#000", position: 0, readable: true, keywords: ["on-call"], count: 1 }] } }
    if (path === "/api/query") {
      const q = String((req.body as { query: string }).query)
      return { body: { query: q, zones_searched: ["ops"], zones_hit: ["ops"], zones_restricted: [], items: /on-call/i.test(q) ? [ACME_ITEM] : [] } }
    }
    if (path === "/api/ingest") {
      const items = (req.body as { items: { zone: string; title: string }[] }).items
      ingested.push(...items)
      return { status: 201, body: { inserted: items.length, skipped: 0, ids: items.map((_, i) => `n${i}`), zones: [...new Set(items.map((i) => i.zone))] } }
    }
    return undefined
  })
  return { ...srv, ingested }
}

type TextResult = { content: { type: string; text: string }[]; isError?: boolean }
const text = (r: unknown) => (r as TextResult).content.map((c) => c.text).join("\n")

let fournil: Awaited<ReturnType<typeof mockBrain>>
let acme: Awaited<ReturnType<typeof acmeBrain>>
let client: Client

before(async () => {
  fournil = await mockBrain()
  acme = await acmeBrain()
  const home = tempDir()
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      url: fournil.url,
      token: FOURNIL_TOKEN,
      org: { name: "Fournil", description: "Artisan bakery, three shops in Lyon" },
      companies: [{ url: acme.url, token: ACME_TOKEN, id: "org-acme", name: "Acme", description: "Web agency: sites and apps for clients" }],
      use_claude_cli: false,
    }),
  )
  client = new Client({ name: "test", version: "0" })
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "src/cli.ts", "mcp"],
      cwd: clientDir,
      env: { ...(process.env as Record<string, string>), COMPANY_BRAIN_HOME: home },
      stderr: "ignore",
    }),
  )
})

after(async () => {
  await client?.close()
  await fournil.close()
  await acme.close()
})

test("MCP, several companies: each tool takes `company`, described with each one's name and description", async () => {
  const { tools } = await client.listTools()
  for (const t of tools) assert.ok("company" in (t.inputSchema.properties ?? {}), `${t.name}: company parameter`)
  const search = tools.find((t) => t.name === "search_brain")!
  assert.deepEqual(search.inputSchema.required, ["query"], "company stays optional")
  const desc = (search.inputSchema.properties as Record<string, { description?: string }>).company.description ?? ""
  assert.match(desc, /the first one by default \("Fournil"\)/)
  assert.match(desc, /1\. Fournil \(default\): Artisan bakery/)
  assert.match(desc, /2\. Acme: Web agency/)
  const instructions = client.getInstructions() ?? ""
  assert.match(instructions, /connected to 2 companies/)
  assert.match(instructions, /2\. Acme: Web agency/)
})

test("MCP, several companies: the first by default, another by name or number, the company at the top of the answer", async () => {
  const byDefault = text(await client.callTool({ name: "search_brain", arguments: { query: "deploy to production" } }))
  assert.match(byDefault, /^Company: Fournil\n/)
  assert.match(byDefault, /Deploy Fournil to production/)

  const before = fournil.requests.length
  const byName = text(await client.callTool({ name: "search_brain", arguments: { query: "on-call", company: "acme" } }))
  assert.match(byName, /^Company: Acme\n/)
  assert.match(byName, /Weekend on-call at Acme/)
  assert.equal(fournil.requests.length, before, "Fournil is not queried")
  assert.equal(acme.requests.find((r) => r.url === "/api/query")?.headers.authorization, `Bearer ${ACME_TOKEN}`, "with Acme's token")

  assert.match(text(await client.callTool({ name: "list_zones", arguments: { company: "2" } })), /\*\*Ops\*\* \(`ops`\)/)
  assert.match(text(await client.callTool({ name: "whoami_context", arguments: { company: "Acme" } })), /Alice Martin/)

  const unknown = (await client.callTool({ name: "search_brain", arguments: { query: "x", company: "Initech" } })) as TextResult
  assert.equal(unknown.isError, true)
  assert.match(text(unknown), /Unknown company: "Initech"/)
  assert.match(text(unknown), /1\. Fournil \(default\)/)
})

test("MCP, several companies: remember saves in the requested company, with its zones", async () => {
  const r = text(await client.callTool({ name: "remember", arguments: { title: "New on-call", body: "The on-call number changes on Monday.", kind: "fact", company: "Acme" } }))
  assert.match(r, /^Company: Acme\n/)
  assert.match(r, /Ops \(`ops`\) zone/)
  assert.equal(acme.ingested.at(-1)?.title, "New on-call")
  assert.ok(!fournil.ingested.some((i) => (i as { title: string }).title === "New on-call"), "nothing at Fournil")
})

test("pickCompany: number, name without accents or case, start of name; ambiguous or unknown = error", () => {
  const list: Company[] = [
    { url: "https://a", token: "t1", name: "Fournil" },
    { url: "https://b", token: "t2", name: "Énergie Verte" },
    { url: "https://c", token: "t3", name: "Énergie Bleue" },
  ]
  assert.equal(pickCompany(list).token, "t1")
  assert.equal(pickCompany(list, "  ").token, "t1")
  assert.equal(pickCompany(list, "2").token, "t2")
  assert.equal(pickCompany(list, "energie verte").token, "t2")
  assert.equal(pickCompany(list, "bleue").token, "t3")
  assert.throws(() => pickCompany(list, "energie"), /Ambiguous company: "energie"/)
  assert.throws(() => pickCompany(list, "9"), /Unknown company/)
  assert.equal(describeCompanies(list).split("\n")[0], "1. Fournil (default)")
})

test("init: another company's token adds it next to the first one; a new token of the same one replaces it", async () => {
  process.env.COMPANY_BRAIN_HOME = tempDir()
  const out: string[] = []
  const log = (s: string) => out.push(s)
  assert.equal(await cmdInit({ url: fournil.url, token: FOURNIL_TOKEN }, log), 0)
  assert.deepEqual(loadConfig()?.org, { name: "Fournil" }, "init notes the first company's name")

  out.length = 0
  assert.equal(await cmdInit({ url: acme.url, token: ACME_TOKEN }, log), 0)
  let cfg = loadConfig()!
  assert.equal(cfg.token, FOURNIL_TOKEN, "the first one stays the default")
  assert.equal(cfg.url, fournil.url)
  assert.deepEqual(cfg.companies, [{ url: acme.url, token: ACME_TOKEN, id: "org-acme", name: "Acme", description: "Web agency: sites and apps for clients" }])
  assert.match(out.join("\n"), /Company added on this computer: Acme, next to Fournil, which stays the default/)
  assert.match(out.join("\n"), /setup connects each company's MCP server in Claude Code and Codex/)
  assert.equal(loadCache()?.whoami?.org, "Fournil", "the hooks' cache stays the first one's")

  // Another account of the same company (Acme): it replaces Acme's entry, in place.
  out.length = 0
  assert.equal(await cmdInit({ url: acme.url, token: "cb_acme_other_9876543" }, log), 0)
  cfg = loadConfig()!
  assert.deepEqual(
    companiesOf(cfg).map((c) => [c.name, c.token]),
    [
      ["Fournil", FOURNIL_TOKEN],
      ["Acme", "cb_acme_other_9876543"],
    ],
  )
  assert.match(out.join("\n"), /Company updated on this computer: Acme/)

  // Token refused (regenerated) for the first one: the new one replaces it, as before.
  saveConfig({ ...cfg, token: "cb_regenerated_0000000000" })
  assert.equal(await cmdInit({ url: fournil.url, token: FOURNIL_TOKEN }, log), 0)
  cfg = loadConfig()!
  assert.equal(cfg.token, FOURNIL_TOKEN)
  assert.equal(cfg.companies?.length, 1)
})

test("companies: list, --default changes the first one (and the hooks' cache), --remove removes one", async () => {
  process.env.COMPANY_BRAIN_HOME = tempDir()
  saveConfig({
    url: fournil.url,
    token: FOURNIL_TOKEN,
    org: { name: "Fournil" },
    companies: [{ url: acme.url, token: ACME_TOKEN, id: "org-acme", name: "Acme" }],
    use_claude_cli: false,
  })
  const out: string[] = []
  const log = (s: string) => out.push(s)
  assert.equal(await cmdCompanies({}, log), 0)
  assert.match(out.join("\n"), /1\. Fournil \(default\)\n2\. Acme/)

  out.length = 0
  assert.equal(await cmdCompanies({ default: "acme" }, log), 0)
  let cfg = loadConfig()!
  assert.equal(cfg.token, ACME_TOKEN)
  assert.deepEqual(cfg.org, { id: "org-acme", name: "Acme" })
  assert.deepEqual(cfg.companies, [{ url: fournil.url, token: FOURNIL_TOKEN, name: "Fournil" }])
  assert.equal(loadCache()?.whoami?.org, "Acme")
  assert.match(out.join("\n"), /Default company: Acme/)

  out.length = 0
  assert.equal(await cmdCompanies({ remove: "Fournil" }, log), 0)
  cfg = loadConfig()!
  assert.equal(cfg.companies, undefined)
  assert.equal(cfg.token, ACME_TOKEN)
  await assert.rejects(cmdCompanies({ remove: "1" }, log), /only company on this computer/)
  await assert.rejects(cmdCompanies({ default: true }, log), /give the company's name or number/)
})
