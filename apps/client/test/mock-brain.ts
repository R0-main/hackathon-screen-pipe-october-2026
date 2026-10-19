// Fake brain (minimal API) for the sync and MCP tests.

import { createHash } from "node:crypto"
import { TEST_ZONES, mockServer } from "./helpers"

export const DEPLOY_ITEM = {
  id: "i1",
  zone: "dev",
  kind: "procedure",
  title: "Deploy Fournil to production",
  body: "1. Merge into main.\n2. Tag vX.Y.Z.\n3. Watch Sentry.",
  entities: [{ type: "tool", name: "Vercel" }],
  source: { app: "Terminal", tool: "claude-code", at: "2026-10-08T13:40:00.000Z" },
  confidence: 0.8,
  created_at: "2026-10-08T13:40:00.000Z",
  author_id: "u1",
  author: "Hugo Bernard",
}

/** Fake brain. `failIngestAt`: numbers (1, 2…) of the /api/ingest calls that fail with a 500. */
export async function mockBrain(opts: { failIngestAt?: number[]; zones?: ((typeof TEST_ZONES)[number] & { projects?: string[] })[] } = {}) {
  const ingested: unknown[] = []
  const received: unknown[] = []
  const automations: unknown[] = []
  /** POST /api/items/rezone received. */
  const rezones: { moves: { session_id: string; zone: string }[]; dry_run?: boolean }[] = []
  /** Item key → its id (like the real brain, a duplicate gives back the id of the item already there). */
  const keys = new Map<string, string>()
  /** POST /api/documents received, and the documents kept (by fingerprint). */
  const uploads: { name: string; sha256?: string; content?: string; item_ids: string[]; zone?: string; auto?: boolean }[] = []
  const documents = new Map<string, { id: string; name: string; zone: string; item_ids: string[] }>()
  let ingestCalls = 0
  const srv = await mockServer((req) => {
    if (req.headers.authorization !== "Bearer cb_test_token_123456") return { status: 401, body: { error: "Not authenticated" } }
    const path = req.url.split("?")[0]
    if (req.method === "GET" && path === "/api/whoami")
      return {
        body: {
          org: { name: "Fournil", description: "" },
          profile: { id: "u1", org_id: "o", name: "Hugo Bernard", title: "Lead dev", role: "member", created_at: "" },
          access: { isAdmin: false, readable: ["dev"], writable: ["dev"] },
          context: {
            person: {},
            zones: [{ zone: "dev", weight: 10 }],
            entities: [{ type: "tool", name: "Supabase", count: 3, zones: ["dev"] }],
            frequent_prompts: [
              { summary: "Prepare the Supabase migration", count: 4, last: "2026-10-16T12:00:00Z" },
              { summary: "Prepare the Supabase migration", count: 4, last: "2026-10-16T12:01:00Z" },
            ],
            items: [],
            decisions: [{ ...DEPLOY_ITEM, kind: "decision", title: "We go with Supabase" }],
            procedures: [DEPLOY_ITEM],
          },
        },
      }
    if (req.method === "GET" && path === "/api/zones") return { body: { zones: (opts.zones ?? TEST_ZONES).map((z) => ({ ...z, count: z.readable ? 3 : undefined })) } }
    if (req.method === "GET" && path === "/api/zones/dev")
      return { body: { zone: TEST_ZONES[0], status: null, items: [DEPLOY_ITEM], entities: [{ type: "tool", name: "Vercel", count: 2 }], tasks: [{ id: "t", title: "Write the runbook", status: "open", assignee: "Hugo" }] } }
    if (req.method === "GET" && path === "/api/zones/finance") return { status: 403, body: { error: "You don't have access to this zone." } }
    if (req.method === "GET" && path === "/api/status") return { body: null }
    if (req.method === "GET" && path === "/api/documents/d1")
      return {
        body: {
          document: {
            id: "d1", org_id: "o", name: "runbook.pdf", mime: "application/pdf", size: 2048, sha256: "0".repeat(64), zone: "dev",
            title: "Production runbook", summary: "Merge into main", pages: 1, author_id: "u1", author: "Hugo Bernard",
            source: { app: "Claude Code", tool: "claude-code", at: "2026-10-08T13:40:00.000Z" }, item_ids: ["i1"],
            created_at: "2026-10-08T13:40:00.000Z", text: "Merge into main, then tag vX.Y.Z and watch Sentry.",
          },
          items: [DEPLOY_ITEM],
        },
      }
    if (req.method === "GET" && path.startsWith("/api/documents/")) return { status: 404, body: { error: "Document not found." } }
    if (req.method === "POST" && path === "/api/query") {
      const q = String((req.body as { query: string }).query)
      const found = /deploy/i.test(q)
      return {
        body: { query: q, zones_searched: ["dev"], zones_hit: found ? ["dev"] : [], zones_restricted: /vat|invoice/i.test(q) ? ["finance"] : [], items: found ? [DEPLOY_ITEM] : [] },
      }
    }
    if (req.method === "POST" && path === "/api/ingest") {
      ingestCalls++
      if (opts.failIngestAt?.includes(ingestCalls)) return { status: 500, body: { error: "simulated outage" } }
      const items = (req.body as { items: { zone: string; title: string; body: string }[] }).items
      received.push(...items)
      // Like the real brain (E1): an item already received (same zone, same title AND same content) is skipped, counted in `skipped`.
      const ids: string[] = []
      const fresh = items.filter((i) => {
        const k = JSON.stringify([i.zone, i.title.toLowerCase().trim(), (i.body ?? "").replace(/\s+/g, " ").toLowerCase().trim()])
        const known = keys.get(k)
        if (known) {
          ids.push(known)
          return false
        }
        const id = `n${keys.size + 1}`
        keys.set(k, id)
        ids.push(id)
        return true
      })
      ingested.push(...fresh)
      return {
        status: 201,
        body: { inserted: fresh.length, skipped: items.length - fresh.length, ids: fresh.map((_, i) => `n${i}`), item_ids: ids, zones: [...new Set(fresh.map((i) => i.zone))] },
      }
    }
    if (req.method === "POST" && path === "/api/documents") {
      const b = req.body as (typeof uploads)[number]
      uploads.push(b)
      const sha = b.content ? createHash("sha256").update(Buffer.from(b.content, "base64")).digest("hex") : b.sha256!
      const doc = documents.get(sha)
      if (!doc && !b.content) return { status: 404, body: { error: "Unknown document: send its content." } }
      const kept = doc ?? { id: `doc${documents.size + 1}`, name: b.name, zone: b.zone ?? "dev", item_ids: [] }
      kept.item_ids = [...new Set([...kept.item_ids, ...b.item_ids])]
      documents.set(sha, kept)
      return { status: doc ? 200 : 201, body: { document: kept, created: !doc, linked: b.item_ids.length } }
    }
    if (req.method === "POST" && path === "/api/automations") {
      const list = (req.body as { workflows: unknown[] }).workflows
      automations.push(...list)
      return { status: 201, body: { saved: list.length } }
    }
    if (req.method === "POST" && path === "/api/events") return { status: 201, body: { recorded: 1, zones: [] } }
    if (req.method === "POST" && path === "/api/items/rezone") {
      const b = req.body as { moves: { session_id: string; zone: string }[]; dry_run?: boolean }
      rezones.push(b)
      const zones: Record<string, number> = {}
      for (const m of b.moves) zones[m.zone] = (zones[m.zone] ?? 0) + 2
      return { body: { dry_run: Boolean(b.dry_run), moved: b.moves.length * 2, zones, already: 0, sessions: b.moves.length, unknown_zones: [] } }
    }
    return undefined
  })
  return { ...srv, ingested, received, automations, uploads, documents, rezones, ingestCalls: () => ingestCalls }
}
