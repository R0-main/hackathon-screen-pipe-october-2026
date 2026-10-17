import { DEFAULT_ZONES } from "@brain/core"
import type { ZoneView } from "@/lib/brain"

/**
 * Butine's brain (the demo's fictional company) as the home page shows it: same zones and
 * same volumes as `scripts/demo-data.ts`, without a server call since the visitor is not signed in.
 */
const COUNTS: Record<string, number> = { dev: 9, product: 6, sales: 6, finance: 6, support: 3, leadership: 4 }

export const LANDING_ZONES: ZoneView[] = DEFAULT_ZONES.map((z) => ({
  ...z,
  count: COUNTS[z.id] ?? 0,
  last_at: null,
  contributors: 0,
  locked: false,
  entities: [],
}))

export const LANDING_TOTAL = LANDING_ZONES.reduce((n, z) => n + z.count, 0)

/** Zones that share entities in the demo (customer, tool, project). */
export const LANDING_SYNAPSES = [
  { a: "dev", b: "product", weight: 4, via: ["swarm alert"] },
  { a: "sales", b: "product", weight: 3, via: ["Miellerie Roussel"] },
  { a: "finance", b: "sales", weight: 2, via: ["Stripe"] },
  { a: "dev", b: "support", weight: 3, via: ["B2 scale"] },
  { a: "finance", b: "leadership", weight: 2, via: ["runway"] },
  { a: "sales", b: "leadership", weight: 1, via: ["MRR"] },
]

/**
 * Three agents that fetch context during the last chapter. `from`/`to` are fractions of the
 * pinned scene; the queries target real knowledge of the demo.
 */
export const LANDING_AGENTS = [
  { zone: "dev", from: 0.6, to: 0.69, label: "Hugo's Claude Code is searching “deploy to production”" },
  { zone: "finance", from: 0.68, to: 0.77, label: "Jean-Marc's Codex is searching “Qonto reconciliation”" },
  { zone: "sales", from: 0.76, to: 0.85, label: "Sarah's Claude is searching “price per hive”" },
]
