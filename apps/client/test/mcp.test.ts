import { strict as assert } from "node:assert"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { after, before, test } from "node:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { tempDir } from "./helpers"
import { mockBrain } from "./mock-brain"

const clientDir = fileURLToPath(new URL("..", import.meta.url))
let brain: Awaited<ReturnType<typeof mockBrain>>
let client: Client

type TextResult = { content: { type: string; text: string }[]; isError?: boolean }
const text = (r: unknown) => (r as TextResult).content.map((c) => c.text).join("\n")

before(async () => {
  brain = await mockBrain()
  const home = tempDir()
  writeFileSync(join(home, "config.json"), JSON.stringify({ url: brain.url, token: "cb_test_token_123456", use_claude_cli: false }))
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
  await brain.close()
})

test("MCP : liste des outils", async () => {
  const { tools } = await client.listTools()
  assert.deepEqual(tools.map((t) => t.name).sort(), ["company_status", "get_zone_summary", "list_zones", "remember", "search_brain", "whoami_context"])
  const search = tools.find((t) => t.name === "search_brain")!
  assert.match(search.description ?? "", /décisions, procédures/)
  assert.deepEqual(search.inputSchema.required, ["query"])
})

test("MCP search_brain : résultats en markdown, puis « rien trouvé » + zones restreintes", async () => {
  const r = await client.callTool({ name: "search_brain", arguments: { query: "déployer en production" } })
  const t = text(r)
  assert.match(t, /### 1\. Déployer Fournil en production/)
  assert.match(t, /Zone : Dev · Type : procédure · Par : Hugo Bernard · Date : 08\/10\/2026/)
  const q = brain.requests.find((x) => x.url === "/api/query")!
  assert.equal((q.body as { agent: string }).agent, "mcp")

  const empty = text(await client.callTool({ name: "search_brain", arguments: { query: "clôture TVA facture" } }))
  assert.match(empty, /Aucune connaissance trouvée/)
  assert.match(empty, /des zones auxquelles vous n'avez pas accès pourraient en savoir plus/)
  assert.ok(!empty.includes("compta"), "ne doit pas nommer la zone restreinte")
})

test("MCP get_zone_summary / list_zones / whoami_context / company_status", async () => {
  assert.match(text(await client.callTool({ name: "get_zone_summary", arguments: { zone: "Dev" } })), /Tâches ouvertes\n- Écrire le runbook \(Hugo\)/)
  const denied = (await client.callTool({ name: "get_zone_summary", arguments: { zone: "compta" } })) as TextResult
  assert.equal(denied.isError, true)
  assert.match(text(denied), /pas accès/)
  assert.match(text(await client.callTool({ name: "list_zones", arguments: {} })), /\*\*Compta\*\* \(`compta`\) : Factures — non accessible/)
  const who = text(await client.callTool({ name: "whoami_context", arguments: {} }))
  assert.match(who, /Hugo Bernard — Lead dev \(Fournil\)/)
  assert.equal(who.match(/Prépare la migration Supabase/g)?.length, 1)
  assert.match(text(await client.callTool({ name: "company_status", arguments: {} })), /pas encore été généré/)
})

test("MCP remember : POST /api/ingest avec agent mcp, source agent, secret masqué", async () => {
  const r = text(
    await client.callTool({
      name: "remember",
      arguments: { title: "On déploie le vendredi avant 16h", body: "Décision d'équipe pour la migration de l'API ; clé sk-ant-api03-ZZZZZZZZZZZZZZZZZZZZ", kind: "decision" },
    }),
  )
  assert.match(r, /Connaissance enregistrée dans la zone Dev/)
  const req = brain.requests.filter((x) => x.url === "/api/ingest").at(-1)!
  const body = req.body as { agent: string; items: { zone: string; source: { tool: string; app: string }; confidence: number; body: string }[] }
  assert.equal(body.agent, "mcp")
  assert.equal(body.items[0].zone, "dev")
  assert.equal(body.items[0].source.tool, "agent")
  assert.equal(body.items[0].source.app, "claude-code")
  assert.equal(body.items[0].confidence, 0.8)
  assert.ok(!body.items[0].body.includes("sk-ant"))
})
