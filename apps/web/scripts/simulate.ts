// Activity simulator for the demo: agents "work" and the brain lights up live.
// Usage: npm run simulate                 (loop, Ctrl-C to stop)
//        npm run simulate -- --once       (a single scene)
//        npm run simulate -- --speed 2    (twice as fast)

import { normalize, promptFingerprint, type KnowledgeItemInput } from "@brain/core"
import { getStore } from "../lib/store"
import { getAccess } from "../lib/access"
import { ingestItems, queryBrain, recordEvents } from "../lib/brain"
import type { Viewer } from "../lib/auth"
import { DEMO_PROMPTS, DEMO_USERS } from "./demo-data"

const args = process.argv.slice(2)
const once = args.includes("--once")
const speed = Number(args[args.indexOf("--speed") + 1]) || 1
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms / speed))
const pick = <T,>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)]

/** Questions an agent asks the brain through the MCP (search_brain). */
const AGENT_QUERIES: Record<string, string[]> = {
  dev: ["production deployment procedure", "Stripe invoice.paid webhook", "Supabase RLS isolation", "restore a backup"],
  product: ["quarter priority preorders", "La Mie Dorée feedback Excel export", "morning app usage"],
  sales: ["October pipeline negotiations", "new yearly pricing", "prepare a demo"],
  finance: ["Qonto Pennylane reconciliation", "month-end close Durand Accounting", "Stripe payouts on Qonto"],
  support: ["reset the receipt printer", "top October tickets"],
  leadership: ["Q4 goals MRR", "seed round postponed", "quarterly board KPIs"],
}

/** Fresh knowledge that brain-sync "distills" during the demo. */
const FRESH: (KnowledgeItemInput & { author: string })[] = [
  {
    author: "hugo", zone: "dev", kind: "decision", title: "Preorders use a Supabase Queues queue for SMS notifications",
    body: "Avoids blocking the order request; SMS go out in under 30 seconds through Brevo.",
    entities: [{ type: "tool", name: "Supabase" }, { type: "tool", name: "Brevo" }, { type: "project", name: "Preorders" }],
    source: { app: "Terminal", tool: "claude-code", at: "" }, confidence: 0.82,
  },
  {
    author: "sarah", zone: "sales", kind: "fact", title: "Au Pain d'Antan asks for a discount for 3 shops",
    body: "They would sign at €44/shop yearly. To validate with Claire before Friday.",
    entities: [{ type: "client", name: "Au Pain d'Antan" }, { type: "person", name: "Claire Martin" }],
    source: { app: "Claude", tool: "claude", at: "" }, confidence: 0.78,
  },
  {
    author: "jeanmarc", zone: "finance", kind: "procedure", title: "Prepare the monthly export for Durand Accounting",
    body: "1. Close the Qonto reconciliations.\n2. Export the general ledger from Pennylane.\n3. Attach the Swile receipts.\n4. Send before the 5th of the month.",
    entities: [{ type: "tool", name: "Pennylane" }, { type: "client", name: "Durand Accounting" }, { type: "tool", name: "Swile" }],
    source: { app: "Claude", tool: "claude", at: "" }, confidence: 0.85,
  },
  {
    author: "leo", zone: "product", kind: "decision", title: "Preorder pickup slots in 30-minute blocks",
    body: "Bakers want to smooth out the Saturday morning rush; 30 minutes is the best compromise according to the interviews.",
    entities: [{ type: "project", name: "Preorders" }],
    source: { app: "Claude", tool: "claude", at: "" }, confidence: 0.8,
  },
  {
    author: "ines", zone: "dev", kind: "fact", title: "The POS offline mode loses receipts beyond 500 sales",
    body: "The IndexedDB queue is capped; to fix before the PWA. Repro: e2e script pos-offline.spec.ts.",
    entities: [{ type: "project", name: "POS" }, { type: "tool", name: "Playwright" }],
    source: { app: "Terminal", tool: "claude-code", at: "" }, confidence: 0.76,
  },
  {
    author: "sarah", zone: "support", kind: "procedure", title: "Answer a subscription refund request",
    body: "1. Check the subscription date in Stripe.\n2. Refund pro rata if under 14 days.\n3. Note the reason in HubSpot for churn tracking.",
    entities: [{ type: "tool", name: "Stripe" }, { type: "tool", name: "HubSpot" }],
    source: { app: "Claude", tool: "claude", at: "" }, confidence: 0.8,
  },
  {
    author: "claire", zone: "leadership", kind: "decision", title: "Hiring a second support person is moved up to November",
    body: "Ticket volume has doubled since September; budget approved on current cash, without waiting for the round.",
    entities: [{ type: "project", name: "Hiring" }],
    source: { app: "Claude", tool: "claude", at: "" }, confidence: 0.79,
  },
  {
    author: "hugo", zone: "dev", kind: "procedure", title: "Replay a Stripe webhook locally",
    body: "stripe listen --forward-to localhost:3000/api/stripe then stripe events resend <id>. Never replay in production without checking idempotency.",
    entities: [{ type: "tool", name: "Stripe" }],
    source: { app: "Terminal", tool: "claude-code", at: "" }, confidence: 0.84,
  },
]

const titleKey = (zone: string, title: string) => `${zone}|${normalize(title).replace(/\s+/g, " ").trim()}`

/**
 * Fresh knowledge not yet in the brain: each item is distilled only once (restarting the simulator or
 * leaving it running for a long time creates no duplicates; the server deduplicates too).
 */
async function freshQueue(): Promise<typeof FRESH> {
  const since = new Date(Date.now() - 30 * 86400_000).toISOString()
  const known = new Set((await getStore().listItems({ sinceIso: since, limit: 100_000 })).map((i) => titleKey(i.zone, i.title)))
  return FRESH.filter((f) => !known.has(titleKey(f.zone, f.title)))
}

async function viewers(): Promise<Record<string, Viewer>> {
  const store = getStore()
  const profiles = await store.listProfiles()
  const out: Record<string, Viewer> = {}
  for (const u of DEMO_USERS) {
    const p = profiles.find((x) => x.name === u.name)
    if (p) out[u.key] = { profile: p, real: p, access: await getAccess(p) }
  }
  if (Object.keys(out).length === 0) throw new Error("No demo accounts: run `npm run seed` first.")
  return out
}

async function scene(vs: Record<string, Viewer>, queue: typeof FRESH) {
  const zone = pick(Object.keys(DEMO_PROMPTS))
  const prompt = pick(DEMO_PROMPTS[zone])
  const v = vs[prompt.user]
  if (!v) return
  const session = `sim-${Date.now()}`
  const agent = prompt.user === "hugo" && Math.random() < 0.4 ? "codex" : "claude-code"
  console.log(`· ${v.profile.name} (${agent}): "${prompt.text}"`)
  await recordEvents(v, [{ agent, type: "started", session_id: session }])
  await sleep(900)
  await recordEvents(v, [{ agent, type: "query", zones: [zone], summary: prompt.text, fingerprint: promptFingerprint(prompt.text), session_id: session }])
  await sleep(1600)
  // The agent fetches context from the brain through the MCP.
  const q = pick(AGENT_QUERIES[zone] ?? [prompt.text])
  const res = await queryBrain(v, { query: q, agent: "mcp" })
  console.log(`  ↳ MCP search_brain "${q}" → ${res.items.length} result(s) in ${res.zones_hit.join(", ") || "no zone"}`)
  await sleep(2200)
  // From time to time, brain-sync sends up a new knowledge item (never the same one twice).
  if (queue.length > 0 && Math.random() < 0.45) {
    const f = queue.shift()!
    const author = vs[f.author] ?? v
    const { author: _a, ...item } = f
    const res = await ingestItems(author, [{ ...item, source: { ...item.source, at: new Date().toISOString() } }])
    console.log(res.inserted ? `  ↳ brain-sync: "${f.title}" (${f.zone})` : `  ↳ brain-sync: "${f.title}" already known, skipped`)
    if (queue.length === 0) console.log("  (all the fresh knowledge has been distilled: from now on, searches only)")
  }
  await recordEvents(v, [{ agent, type: "stopped", session_id: session }])
}

async function main() {
  const vs = await viewers()
  const queue = await freshQueue()
  console.log(`Simulating on the brain (${getStore().kind}). Open the dashboard to watch the zones light up.`)
  console.log(`${queue.length}/${FRESH.length} fresh knowledge item(s) to distill during the demo.`)
  do {
    await scene(vs, queue)
    if (!once) await sleep(1500 + Math.random() * 2500)
  } while (!once)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
