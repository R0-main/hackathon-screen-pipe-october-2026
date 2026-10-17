// Plusieurs entreprises sur un poste : init les ajoute à côté de la première, les outils MCP prennent `company`.

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
  title: "Astreinte du week-end chez Acme",
  body: "Le téléphone d'astreinte tourne chaque vendredi.",
  entities: [],
  source: { app: "Terminal", tool: "claude-code", at: "2026-10-10T09:00:00.000Z" },
  confidence: 0.8,
  created_at: "2026-10-10T09:00:00.000Z",
  author_id: "a",
  author: "Alice Martin",
}

/** Faux cerveau d'Acme : ses jetons (deux comptes de la même entreprise), sa zone « ops ». */
async function acmeBrain() {
  const ingested: { zone: string; title: string }[] = []
  const people: Record<string, string> = { [ACME_TOKEN]: "Alice Martin", cb_acme_other_9876543: "Bruno Petit" }
  const srv = await mockServer((req) => {
    const token = req.headers.authorization?.replace(/^Bearer /, "") ?? ""
    if (!people[token]) return { status: 401, body: { error: "Non authentifié" } }
    const path = req.url.split("?")[0]
    if (path === "/api/whoami")
      return {
        body: {
          org: { id: "org-acme", name: "Acme", description: "Agence web : sites et applis pour des clients" },
          profile: { id: token, org_id: "org-acme", name: people[token], role: "admin", created_at: "" },
          access: { isAdmin: true, readable: ["ops"], writable: ["ops"] },
          context: null,
        },
      }
    if (path === "/api/zones") return { body: { zones: [{ id: "ops", name: "Ops", description: "Exploitation", color: "#000", position: 0, readable: true, keywords: ["astreinte"], count: 1 }] } }
    if (path === "/api/query") {
      const q = String((req.body as { query: string }).query)
      return { body: { query: q, zones_searched: ["ops"], zones_hit: ["ops"], zones_restricted: [], items: /astreinte/i.test(q) ? [ACME_ITEM] : [] } }
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
      org: { name: "Fournil", description: "Boulangerie artisanale, trois boutiques à Lyon" },
      companies: [{ url: acme.url, token: ACME_TOKEN, id: "org-acme", name: "Acme", description: "Agence web : sites et applis pour des clients" }],
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

test("MCP, plusieurs entreprises : chaque outil prend `company`, décrit avec le nom et la description de chacune", async () => {
  const { tools } = await client.listTools()
  for (const t of tools) assert.ok("company" in (t.inputSchema.properties ?? {}), `${t.name} : paramètre company`)
  const search = tools.find((t) => t.name === "search_brain")!
  assert.deepEqual(search.inputSchema.required, ["query"], "company reste facultatif")
  const desc = (search.inputSchema.properties as Record<string, { description?: string }>).company.description ?? ""
  assert.match(desc, /par défaut la première \(« Fournil »\)/)
  assert.match(desc, /1\. Fournil \(par défaut\) : Boulangerie artisanale/)
  assert.match(desc, /2\. Acme : Agence web/)
  const instructions = client.getInstructions() ?? ""
  assert.match(instructions, /branché sur 2 entreprises/)
  assert.match(instructions, /2\. Acme : Agence web/)
})

test("MCP, plusieurs entreprises : la première par défaut, une autre par nom ou numéro, l'entreprise en tête de réponse", async () => {
  const byDefault = text(await client.callTool({ name: "search_brain", arguments: { query: "déployer en production" } }))
  assert.match(byDefault, /^Entreprise : Fournil\n/)
  assert.match(byDefault, /Déployer Fournil en production/)

  const before = fournil.requests.length
  const byName = text(await client.callTool({ name: "search_brain", arguments: { query: "astreinte", company: "acme" } }))
  assert.match(byName, /^Entreprise : Acme\n/)
  assert.match(byName, /Astreinte du week-end chez Acme/)
  assert.equal(fournil.requests.length, before, "Fournil n'est pas interrogé")
  assert.equal(acme.requests.find((r) => r.url === "/api/query")?.headers.authorization, `Bearer ${ACME_TOKEN}`, "avec le jeton d'Acme")

  assert.match(text(await client.callTool({ name: "list_zones", arguments: { company: "2" } })), /\*\*Ops\*\* \(`ops`\)/)
  assert.match(text(await client.callTool({ name: "whoami_context", arguments: { company: "Acme" } })), /Alice Martin/)

  const unknown = (await client.callTool({ name: "search_brain", arguments: { query: "x", company: "Initech" } })) as TextResult
  assert.equal(unknown.isError, true)
  assert.match(text(unknown), /Entreprise inconnue : « Initech »/)
  assert.match(text(unknown), /1\. Fournil \(par défaut\)/)
})

test("MCP, plusieurs entreprises : remember enregistre dans l'entreprise demandée, avec ses zones", async () => {
  const r = text(await client.callTool({ name: "remember", arguments: { title: "Nouvelle astreinte", body: "Le numéro d'astreinte change lundi.", kind: "fact", company: "Acme" } }))
  assert.match(r, /^Entreprise : Acme\n/)
  assert.match(r, /zone Ops \(`ops`\)/)
  assert.equal(acme.ingested.at(-1)?.title, "Nouvelle astreinte")
  assert.ok(!fournil.ingested.some((i) => (i as { title: string }).title === "Nouvelle astreinte"), "rien chez Fournil")
})

test("pickCompany : numéro, nom sans accents ni casse, début de nom ; ambiguë ou inconnue = erreur", () => {
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
  assert.throws(() => pickCompany(list, "energie"), /Entreprise ambiguë : « energie »/)
  assert.throws(() => pickCompany(list, "9"), /Entreprise inconnue/)
  assert.equal(describeCompanies(list).split("\n")[0], "1. Fournil (par défaut)")
})

test("init : le jeton d'une autre entreprise l'ajoute à côté de la première ; un nouveau jeton de la même la remplace", async () => {
  process.env.COMPANY_BRAIN_HOME = tempDir()
  const out: string[] = []
  const log = (s: string) => out.push(s)
  assert.equal(await cmdInit({ url: fournil.url, token: FOURNIL_TOKEN }, log), 0)
  assert.deepEqual(loadConfig()?.org, { name: "Fournil" }, "init relève le nom de la première entreprise")

  out.length = 0
  assert.equal(await cmdInit({ url: acme.url, token: ACME_TOKEN }, log), 0)
  let cfg = loadConfig()!
  assert.equal(cfg.token, FOURNIL_TOKEN, "la première reste celle par défaut")
  assert.equal(cfg.url, fournil.url)
  assert.deepEqual(cfg.companies, [{ url: acme.url, token: ACME_TOKEN, id: "org-acme", name: "Acme", description: "Agence web : sites et applis pour des clients" }])
  assert.match(out.join("\n"), /Entreprise ajoutée sur ce poste : Acme, à côté de Fournil, qui reste celle par défaut/)
  assert.match(out.join("\n"), /setup branche le serveur MCP de chaque entreprise dans Claude Code et Codex/)
  assert.equal(loadCache()?.whoami?.org, "Fournil", "le cache des hooks reste celui de la première")

  // Autre compte de la même entreprise (Acme) : il remplace l'entrée d'Acme, à sa place.
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
  assert.match(out.join("\n"), /Entreprise mise à jour sur ce poste : Acme/)

  // Jeton refusé (régénéré) pour la première : le nouveau la remplace, comme avant.
  saveConfig({ ...cfg, token: "cb_regenere_00000000000" })
  assert.equal(await cmdInit({ url: fournil.url, token: FOURNIL_TOKEN }, log), 0)
  cfg = loadConfig()!
  assert.equal(cfg.token, FOURNIL_TOKEN)
  assert.equal(cfg.companies?.length, 1)
})

test("companies : liste, --default change la première (et le cache des hooks), --remove en retire une", async () => {
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
  assert.match(out.join("\n"), /1\. Fournil \(par défaut\)\n2\. Acme/)

  out.length = 0
  assert.equal(await cmdCompanies({ default: "acme" }, log), 0)
  let cfg = loadConfig()!
  assert.equal(cfg.token, ACME_TOKEN)
  assert.deepEqual(cfg.org, { id: "org-acme", name: "Acme" })
  assert.deepEqual(cfg.companies, [{ url: fournil.url, token: FOURNIL_TOKEN, name: "Fournil" }])
  assert.equal(loadCache()?.whoami?.org, "Acme")
  assert.match(out.join("\n"), /Entreprise par défaut : Acme/)

  out.length = 0
  assert.equal(await cmdCompanies({ remove: "Fournil" }, log), 0)
  cfg = loadConfig()!
  assert.equal(cfg.companies, undefined)
  assert.equal(cfg.token, ACME_TOKEN)
  await assert.rejects(cmdCompanies({ remove: "1" }, log), /seule entreprise de ce poste/)
  await assert.rejects(cmdCompanies({ default: true }, log), /donnez le nom ou le numéro/)
})
