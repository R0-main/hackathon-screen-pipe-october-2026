// Faux cerveau (API minimale) pour les tests de sync et du MCP.

import { TEST_ZONES, mockServer } from "./helpers"

export const DEPLOY_ITEM = {
  id: "i1",
  zone: "dev",
  kind: "procedure",
  title: "Déployer Fournil en production",
  body: "1. Merger sur main.\n2. Tagger vX.Y.Z.\n3. Surveiller Sentry.",
  entities: [{ type: "tool", name: "Vercel" }],
  source: { app: "Terminal", tool: "claude-code", at: "2026-10-08T13:40:00.000Z" },
  confidence: 0.8,
  created_at: "2026-10-08T13:40:00.000Z",
  author_id: "u1",
  author: "Hugo Bernard",
}

/** Faux cerveau. `failIngestAt` : numéros (1, 2…) des appels à /api/ingest qui échouent en 500. */
export async function mockBrain(opts: { failIngestAt?: number[] } = {}) {
  const ingested: unknown[] = []
  const received: unknown[] = []
  const automations: unknown[] = []
  const keys = new Set<string>()
  let ingestCalls = 0
  const srv = await mockServer((req) => {
    if (req.headers.authorization !== "Bearer cb_test_token_123456") return { status: 401, body: { error: "Non authentifié" } }
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
              { summary: "Prépare la migration Supabase", count: 4, last: "2026-10-16T12:00:00Z" },
              { summary: "Prépare la migration Supabase", count: 4, last: "2026-10-16T12:01:00Z" },
            ],
            items: [],
            decisions: [{ ...DEPLOY_ITEM, kind: "decision", title: "On part sur Supabase" }],
            procedures: [DEPLOY_ITEM],
          },
        },
      }
    if (req.method === "GET" && path === "/api/zones") return { body: { zones: TEST_ZONES.map((z) => ({ ...z, count: z.readable ? 3 : undefined })) } }
    if (req.method === "GET" && path === "/api/zones/dev")
      return { body: { zone: TEST_ZONES[0], status: null, items: [DEPLOY_ITEM], entities: [{ type: "tool", name: "Vercel", count: 2 }], tasks: [{ id: "t", title: "Écrire le runbook", status: "open", assignee: "Hugo" }] } }
    if (req.method === "GET" && path === "/api/zones/compta") return { status: 403, body: { error: "Vous n'avez pas accès à cette zone." } }
    if (req.method === "GET" && path === "/api/status") return { body: null }
    if (req.method === "POST" && path === "/api/query") {
      const q = String((req.body as { query: string }).query)
      const found = /d[ée]ploy/i.test(q)
      return {
        body: { query: q, zones_searched: ["dev"], zones_hit: found ? ["dev"] : [], zones_restricted: /tva|facture/i.test(q) ? ["compta"] : [], items: found ? [DEPLOY_ITEM] : [] },
      }
    }
    if (req.method === "POST" && path === "/api/ingest") {
      ingestCalls++
      if (opts.failIngestAt?.includes(ingestCalls)) return { status: 500, body: { error: "panne simulée" } }
      const items = (req.body as { items: { zone: string; title: string }[] }).items
      received.push(...items)
      // Comme le vrai cerveau : un item déjà reçu (même zone, même titre) est ignoré et compté dans `skipped`.
      const fresh = items.filter((i) => {
        const k = `${i.zone}:${i.title.toLowerCase()}`
        if (keys.has(k)) return false
        keys.add(k)
        return true
      })
      ingested.push(...fresh)
      return {
        status: 201,
        body: { inserted: fresh.length, skipped: items.length - fresh.length, ids: fresh.map((_, i) => `n${i}`), zones: [...new Set(fresh.map((i) => i.zone))] },
      }
    }
    if (req.method === "POST" && path === "/api/automations") {
      const list = (req.body as { workflows: unknown[] }).workflows
      automations.push(...list)
      return { status: 201, body: { saved: list.length } }
    }
    if (req.method === "POST" && path === "/api/events") return { status: 201, body: { recorded: 1, zones: [] } }
    return undefined
  })
  return { ...srv, ingested, received, automations, ingestCalls: () => ingestCalls }
}
