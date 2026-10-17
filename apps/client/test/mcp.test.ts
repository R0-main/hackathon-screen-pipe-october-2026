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
// Local Screenpipe token of the computer, assembled at run time (no recognizable secret form in clear).
const SP_TOKEN = ["sp", "-local-", "Kd83hQpz2Lm"].join("")
let brain: Awaited<ReturnType<typeof mockBrain>>
let client: Client

type TextResult = { content: { type: string; text: string }[]; isError?: boolean }
const text = (r: unknown) => (r as TextResult).content.map((c) => c.text).join("\n")

before(async () => {
  brain = await mockBrain()
  const home = tempDir()
  writeFileSync(join(home, "config.json"), JSON.stringify({ url: brain.url, token: "cb_test_token_123456", use_claude_cli: false, screenpipe_token: SP_TOKEN }))
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

test("MCP: list of tools", async () => {
  const { tools } = await client.listTools()
  assert.deepEqual(tools.map((t) => t.name).sort(), ["company_status", "get_zone_summary", "list_zones", "remember", "search_brain", "whoami_context"])
  const search = tools.find((t) => t.name === "search_brain")!
  assert.match(search.description ?? "", /decisions, procedures/)
  assert.deepEqual(search.inputSchema.required, ["query"])
})

test("MCP search_brain: results in markdown, then \"nothing found\" + restricted zones", async () => {
  const r = await client.callTool({ name: "search_brain", arguments: { query: "deploy to production" } })
  const t = text(r)
  assert.match(t, /### 1\. Deploy Fournil to production/)
  assert.match(t, /Zone: Dev · Type: procedure · By: Hugo Bernard · Date: 08 Oct 2026/)
  const q = brain.requests.find((x) => x.url === "/api/query")!
  assert.equal((q.body as { agent: string }).agent, "mcp")

  const empty = text(await client.callTool({ name: "search_brain", arguments: { query: "VAT closing invoice" } }))
  assert.match(empty, /No knowledge found/)
  assert.match(empty, /zones you do not have access to might know more/)
  assert.ok(!empty.includes("finance"), "must not name the restricted zone")
})

test("MCP get_zone_summary / list_zones / whoami_context / company_status", async () => {
  assert.match(text(await client.callTool({ name: "get_zone_summary", arguments: { zone: "Dev" } })), /Open tasks\n- Write the runbook \(Hugo\)/)
  const denied = (await client.callTool({ name: "get_zone_summary", arguments: { zone: "finance" } })) as TextResult
  assert.equal(denied.isError, true)
  assert.match(text(denied), /access/)
  assert.match(text(await client.callTool({ name: "list_zones", arguments: {} })), /\*\*Finance\*\* \(`finance`\): Invoices — not accessible/)
  const who = text(await client.callTool({ name: "whoami_context", arguments: {} }))
  assert.match(who, /Hugo Bernard — Lead dev \(Fournil\)/)
  assert.equal(who.match(/Prepare the Supabase migration/g)?.length, 1)
  assert.match(text(await client.callTool({ name: "company_status", arguments: {} })), /has not been generated yet/)
})

test("MCP remember: POST /api/ingest with agent mcp, agent source, secret redacted", async () => {
  const r = text(
    await client.callTool({
      name: "remember",
      arguments: { title: "We deploy on Friday before 4pm", body: "Team decision for the API migration; key sk-ant-api03-ZZZZZZZZZZZZZZZZZZZZ", kind: "decision" },
    }),
  )
  assert.match(r, /Knowledge saved in the Dev \(`dev`\) zone/)
  const req = brain.requests.filter((x) => x.url === "/api/ingest").at(-1)!
  const body = req.body as { agent: string; items: { zone: string; source: { tool: string; app: string }; confidence: number; body: string }[] }
  assert.equal(body.agent, "mcp")
  assert.equal(body.items[0].zone, "dev")
  assert.equal(body.items[0].source.tool, "agent")
  assert.equal(body.items[0].source.app, "claude-code")
  assert.equal(body.items[0].confidence, 0.8)
  assert.ok(!body.items[0].body.includes("sk-ant"))
})

test("MCP remember: the answer names the zone chosen, flags a zone outside reading, and a duplicate", async () => {
  // Classified automatically in Finance, which the user (Hugo) cannot read.
  const auto = text(await client.callTool({ name: "remember", arguments: { title: "Monthly VAT closing", body: "The VAT invoice closes on the 5th.", kind: "procedure" } }))
  assert.match(auto, /Knowledge saved in the Finance \(`finance`\) zone — zone chosen automatically from the content/)
  assert.match(auto, /is not one of your readable zones/)
  assert.match(auto, /your own searches and in "My context"/)
  assert.match(auto, /your zones: Dev/)
  const req = brain.requests.filter((x) => x.url === "/api/ingest").at(-1)!
  assert.equal((req.body as { items: { zone: string }[] }).items[0].zone, "finance")

  // Zone asked for explicitly (by its name).
  const asked = text(await client.callTool({ name: "remember", arguments: { title: "Rollback runbook", body: "We use Promote on Vercel.", kind: "procedure", zone: "Dev" } }))
  assert.match(asked, /Dev \(`dev`\) zone — zone requested/)
  assert.match(asked, /found by search_brain/)

  // Already known: the brain skips it and the answer says so.
  const dup = text(await client.callTool({ name: "remember", arguments: { title: "Rollback runbook", body: "We use Promote on Vercel.", kind: "procedure", zone: "dev" } }))
  assert.match(dup, /Already in the brain: a knowledge item with the same title and the same content already exists in the Dev \(`dev`\) zone/)
  // Same title, different content: the brain saves it (deduplication on title AND content), and so does the answer.
  const sameTitle = text(await client.callTool({ name: "remember", arguments: { title: "Rollback runbook", body: "From now on we roll back with git revert.", kind: "procedure", zone: "dev" } }))
  assert.match(sameTitle, /Knowledge saved in the Dev \(`dev`\) zone/)
})

test("MCP remember: a configured secret of the computer (Screenpipe token) is redacted as is", async () => {
  await client.callTool({
    name: "remember",
    arguments: { title: "Screenpipe access of the demo computer", body: `For the local API, the token is ${SP_TOKEN} (do not share).`, kind: "fact", zone: "dev" },
  })
  const req = brain.requests.filter((x) => x.url === "/api/ingest").at(-1)!
  const body = JSON.stringify(req.body)
  assert.ok(!body.includes(SP_TOKEN), body)
  assert.match(body, /redacted/)
})
