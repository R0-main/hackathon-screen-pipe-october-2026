// Documents sent with the knowledge, on file storage with the Encore demo: the Q3 revenue PDF comes up with the revenue
// fact for finance and stays invisible to dev; a file with a secret is refused; the same file sent again is only
// linked; an agent reads it through MCP (get_document) and finance lights up.
// BRAIN_TEST_DATABASE_URL (a throwaway database, migrated): the same journey on Postgres; it is reset by the seed.

import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-documents-"))
process.env.BRAIN_DATA_DIR = dir
if (process.env.BRAIN_TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.BRAIN_TEST_DATABASE_URL
else delete process.env.DATABASE_URL
delete process.env.ANTHROPIC_API_KEY
delete process.env.VOYAGE_API_KEY

const { getRootStore, runInOrg } = await import("../lib/store")
const { seedDemoBrain } = await import("../lib/demo-seed")
const { getAccess } = await import("../lib/access")
const { ingestItems, queryBrain } = await import("../lib/brain")
const docs = await import("../lib/documents")
const { simplePdf } = await import("../lib/simple-pdf")
const documentRoute = await import("../app/api/documents/[id]/route")
const documentsRoute = await import("../app/api/documents/route")
const mcpRoute = await import("../app/api/mcp/[orgId]/[token]/route")
type Viewer = import("../lib/auth").Viewer

const root = getRootStore()
let org = ""
let tokens: Record<string, { token: string; id: string }> = {}

async function viewer(key: string): Promise<Viewer> {
  const p = await root.getProfile(tokens[key].id)
  if (!p) throw new Error(`${key} not found`)
  return { profile: p, real: p, access: await getAccess(p) }
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64")
const inOrg = <T>(fn: () => Promise<T>) => runInOrg(org, fn)

async function route(handler: (req: Request, ctx: any) => Promise<Response>, url: string, key: string, opts: { method?: string; body?: unknown; params?: Record<string, string> } = {}) {
  const res = await handler(
    new Request(`http://docs.test${url}`, {
      method: opts.method ?? "GET",
      headers: { authorization: `Bearer ${tokens[key].token}`, "content-type": "application/json" },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    }),
    { params: Promise.resolve(opts.params ?? {}) },
  )
  return res
}

before(async () => {
  const seeded = await seedDemoBrain(root)
  tokens = seeded.tokens
  org = (await root.getOrg()).id
})

after(async () => {
  fs.rmSync(dir, { recursive: true, force: true })
  await (root as { end?: () => Promise<void> }).end?.()
})

test("demo: the Q3 revenue PDF comes with the revenue fact, for finance only", async () => {
  const jm = await viewer("jeanmarc")
  const hugo = await viewer("hugo")
  const r = await inOrg(() => queryBrain(jm, { query: "Q3 revenue" }))
  const fact = r.items.find((i) => i.title.startsWith("Q3 2026 revenue"))
  assert.ok(fact, "the revenue fact is found")
  assert.deepEqual(fact.documents?.map((d) => d.name), ["encore-revenue-Q3-2026.pdf"])
  assert.ok(r.documents.some((d) => d.name === "encore-revenue-Q3-2026.pdf" && d.summary.includes("€1,860,000")), "the PDF matches on its text")
  const dev = await inOrg(() => queryBrain(hugo, { query: "Q3 revenue" }))
  assert.equal(dev.documents.length, 0, "dev does not read finance")
  assert.ok(dev.items.every((i) => !i.documents), "no document attached for dev")
})

test("download: the file itself for a reader, 404 for anyone else", async () => {
  const doc = (await root.listDocuments({})).find((d) => d.name === "encore-revenue-Q3-2026.pdf")!
  const ok = await inOrg(() => route(documentRoute.GET, `/api/documents/${doc.id}?download=1`, "jeanmarc", { params: { id: doc.id } }))
  assert.equal(ok.status, 200)
  assert.equal(ok.headers.get("content-type"), "application/pdf")
  const bytes = Buffer.from(await ok.arrayBuffer())
  assert.equal(createHash("sha256").update(bytes).digest("hex"), doc.sha256)
  const meta = await inOrg(() => route(documentRoute.GET, `/api/documents/${doc.id}`, "jeanmarc", { params: { id: doc.id } }))
  const body = (await meta.json()) as { document: { text: string }; items: { title: string }[] }
  assert.ok(body.document.text.includes("Gross margin: 38%"), "text read by pdf.js")
  assert.ok(body.items.some((i) => i.title.startsWith("Q3 2026 revenue")))
  const denied = await inOrg(() => route(documentRoute.GET, `/api/documents/${doc.id}?download=1`, "hugo", { params: { id: doc.id } }))
  assert.equal(denied.status, 404)
})

test("upload: filed with its knowledge, refused with a secret, linked again by fingerprint", async () => {
  const hugo = await viewer("hugo")
  const ingest = await inOrg(() =>
    ingestItems(hugo, [
      {
        zone: "dev",
        kind: "procedure",
        title: "Staging deploy checklist from the runbook",
        body: "Run the migrations on staging first, then deploy, then check the health page.",
        entities: [],
        source: { app: "Claude Code", tool: "claude-code", at: new Date().toISOString() },
        confidence: 0.8,
      },
    ]),
  )
  assert.equal(ingest.item_ids.length, 1)
  const itemId = ingest.item_ids[0]!
  const again = await inOrg(() =>
    ingestItems(hugo, [
      {
        zone: "dev",
        kind: "procedure",
        title: "Staging deploy checklist from the runbook",
        body: "Run the migrations on staging first, then deploy, then check the health page.",
        entities: [],
        source: { app: "Claude Code", tool: "claude-code", at: new Date().toISOString() },
        confidence: 0.8,
      },
    ]),
  )
  assert.deepEqual(again.item_ids, [itemId], "a duplicate gives the id of the knowledge already there")

  const pdf = simplePdf(["Staging runbook", "1. Run the migrations on staging.", "2. Deploy.", "3. Check /api/health."])
  const created = await inOrg(() => docs.addDocument(hugo, { name: "/Users/hugo/Downloads/staging-runbook.pdf", content: b64(pdf), item_ids: [itemId], auto: true, agent: "brain-sync" }))
  assert.equal(created.created, true)
  assert.equal(created.document.name, "staging-runbook.pdf", "the folders never reach the brain")
  assert.equal(created.document.zone, "dev", "filed in its knowledge's zone")

  const same = await inOrg(() => docs.addDocument(hugo, { name: "staging-runbook.pdf", content: b64(pdf), item_ids: [] }))
  assert.equal(same.created, false)
  const bySha = await inOrg(() => docs.addDocument(hugo, { name: "staging-runbook.pdf", sha256: createHash("sha256").update(pdf).digest("hex"), item_ids: [itemId] }))
  assert.equal(bySha.document.id, created.document.id)
  await assert.rejects(
    inOrg(() => docs.addDocument(hugo, { name: "x.pdf", sha256: "0".repeat(64), item_ids: [] })),
    (e: Error & { status?: number }) => e.status === 404,
  )

  // Split so that no secret scanner takes the fake key for a real one.
  const secret = simplePdf(["Production access", `ANTHROPIC_API_KEY=${"sk-ant"}-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefghij`])
  await assert.rejects(
    inOrg(() => docs.addDocument(hugo, { name: "prod-access.pdf", content: b64(secret), item_ids: [] })),
    (e: Error & { status?: number; details?: string[] }) => e.status === 422 && Boolean(e.details?.some((d) => d.includes("secret"))),
  )
  await assert.rejects(
    inOrg(() => docs.addDocument(hugo, { name: "payslip-september.pdf", content: b64(simplePdf(["September", "Net: 3,120"])), item_ids: [] })),
    (e: Error & { status?: number }) => e.status === 422,
    "a payslip stays on the computer",
  )
  // A scan (no text) sent by the sync on its own cannot be checked: refused; chosen by the person: accepted.
  const scan = simplePdf([])
  await assert.rejects(
    inOrg(() => docs.addDocument(hugo, { name: "scan.pdf", content: b64(scan), item_ids: [], auto: true })),
    (e: Error & { status?: number }) => e.status === 422,
  )
  const csv = "zone,owner\ndev,Hugo\nproduct,Léo\n"
  const list = await inOrg(() => route(documentsRoute.POST, "/api/documents", "hugo", { method: "POST", body: { name: "owners.csv", content: b64(csv), zone: "product" } }))
  assert.equal(list.status, 201)
  const listed = (await (await inOrg(() => route(documentsRoute.GET, "/api/documents?q=owner", "hugo"))).json()) as { documents: { name: string }[] }
  assert.ok(listed.documents.some((d) => d.name === "owners.csv"), "found by its text")
})

test("MCP: search_brain points to the PDF and get_document reads it; finance lights up", async () => {
  const jm = tokens.jeanmarc
  const rpc = async (body: unknown) => {
    const res = await mcpRoute.POST(
      new Request(`http://docs.test/api/mcp/${org}/${jm.token}`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ orgId: org, token: jm.token }) },
    )
    return (await res.json()) as any
  }
  await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } })
  const search = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "search_brain", arguments: { query: "Q3 revenue" } } })
  const text = search.result.content[0].text as string
  const id = text.match(/encore-revenue-Q3-2026\.pdf \([^)]*id `([^`]+)`\)/)?.[1]
  assert.ok(id, "the document's id is given next to the knowledge")
  const before = (await root.listEvents({ limit: 1 }))[0]?.id ?? 0
  const read = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_document", arguments: { id } } })
  const doc = read.result.content[0].text as string
  assert.ok(doc.includes("September: €725,000") && doc.includes("### Knowledge it backs"), doc.slice(0, 300))
  const lit = await root.listEvents({ afterId: before })
  assert.ok(lit.some((e) => e.type === "query" && e.zones.includes("finance") && e.summary?.includes("encore-revenue-Q3-2026.pdf")))

  const hugo = tokens.hugo
  const denied = await mcpRoute.POST(
    new Request(`http://docs.test/api/mcp/${org}/${hugo.token}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_document", arguments: { id } } }),
    }),
    { params: Promise.resolve({ orgId: org, token: hugo.token }) },
  )
  const deniedBody = (await denied.json()) as any
  assert.equal(deniedBody.result.isError, true, "dev cannot open a finance document")
})

test("removal: the author or an admin; the knowledge stays", async () => {
  const hugo = await viewer("hugo")
  const jm = await viewer("jeanmarc")
  const claire = await viewer("claire")
  const doc = (await root.listDocuments({})).find((d) => d.name === "staging-runbook.pdf")!
  await assert.rejects(inOrg(() => docs.removeDocument(jm, doc.id)), (e: Error & { status?: number }) => e.status === 404, "not readable: not found")
  const csv = (await root.listDocuments({})).find((d) => d.name === "owners.csv")!
  await inOrg(() => docs.removeDocument(claire, csv.id))
  await inOrg(() => docs.removeDocument(hugo, doc.id))
  assert.equal(await root.getDocument(doc.id), null)
  assert.ok((await root.listItems({})).some((i) => doc.item_ids.includes(i.id)), "its knowledge stays")
})
