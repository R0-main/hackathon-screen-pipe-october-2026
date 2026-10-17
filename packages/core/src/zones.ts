import type { Zone } from "./types"
import { normalize, tokenize } from "./text"

/** Zones offered by default. Onboarding can replace them or add more. */
export const DEFAULT_ZONES: Zone[] = [
  {
    id: "dev",
    name: "Dev",
    description: "Code, architecture, infrastructure, deployments, bugs.",
    color: "#2a78d6",
    keywords: [
      "code", "bug", "bugs", "deploy", "deployment", "api", "repo", "git", "github", "gitlab", "pull", "merge", "test", "tests", "build",
      "ci", "cicd",
      "backend", "frontend", "database", "sql", "postgres", "supabase", "migration", "server",
      "production", "docker", "typescript", "react", "next", "node", "python", "endpoint", "refactor", "prod", "staging",
      "infra", "infrastructure", "kubernetes", "aws", "vercel", "auth", "webhook", "stack", "lib", "library", "function",
      "error", "crash", "logs", "performance", "schema", "commit", "branch", "release",
    ],
    position: 0,
  },
  {
    id: "product",
    name: "Product",
    description: "Roadmap, specs, design, user feedback.",
    color: "#eb6834",
    keywords: [
      "product", "roadmap", "feature", "features", "spec", "specs", "user", "users",
      "ux", "ui", "design", "mockup", "wireframe", "figma", "persona", "feedback", "onboarding", "journey",
      "prioritization", "backlog", "sprint", "mvp", "experiment", "metric", "metrics", "retention", "activation", "interview",
    ],
    position: 1,
  },
  {
    id: "sales",
    name: "Sales",
    description: "Prospects, customers, pipeline, quotes, partnerships.",
    color: "#1baf7a",
    keywords: [
      "client", "clients", "customer", "customers", "prospect", "prospects", "prospecting", "quote", "quotes", "crm", "hubspot",
      "pipeline", "deal", "deals", "sale", "sales", "meeting", "demo", "proposal", "pricing", "price", "prices", "contract",
      "signature", "lead", "leads", "partner", "partnership", "tradeshow", "followup", "churn", "upsell", "subscription",
    ],
    position: 2,
  },
  {
    id: "finance",
    name: "Finance",
    description: "Invoicing, cash, closing, VAT, payroll.",
    color: "#eda100",
    keywords: [
      "finance", "accounting", "accountant", "bookkeeping", "invoice", "invoices", "invoicing", "billing", "vat", "tax", "closing",
      "balance", "cash", "treasury", "bank", "statement", "statements", "reconciliation", "reconcile", "qonto", "pennylane",
      "payroll", "salary", "salaries", "budget", "expense", "expenses", "receipt", "fiscal", "burn", "runway", "refund", "credit",
    ],
    position: 3,
  },
  {
    id: "support",
    name: "Support",
    description: "Tickets, customer incidents, FAQ, support procedures.",
    color: "#e87ba4",
    keywords: [
      "support", "ticket", "tickets", "incident", "incidents", "faq", "zendesk", "intercom", "helpdesk", "complaint",
      "refund", "outage", "blocked", "help", "question", "escalation", "sla", "hotline",
    ],
    position: 4,
  },
  {
    id: "leadership",
    name: "Leadership",
    description: "Strategy, goals, fundraising, hiring, organization.",
    color: "#008300",
    keywords: [
      "strategy", "goal", "goals", "objective", "objectives", "okr", "okrs", "fundraising", "funding", "investor", "investors",
      "board", "hiring", "recruiting", "recruitment", "hr", "organization", "vision", "kpi", "kpis", "quarter", "q1", "q2", "q3", "q4",
      "committee", "founders", "valuation", "plan", "leadership",
    ],
    position: 5,
  },
]

// Fixed-order categorical palette, validated (color blindness, contrast) on a light background. Same list as ZONE_PALETTE in the web app.
const ZONE_COLORS = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948", "#0e9aa7", "#9c4dcc"]

export function zoneColor(index: number): string {
  return ZONE_COLORS[index % ZONE_COLORS.length]
}

export function slugify(s: string): string {
  return (
    normalize(s)
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32)
      .replace(/-+$/, "") || "zone"
  )
}

export type ClassifyOptions = {
  /** Tie-breaker: these zones first, in this order (otherwise the order of the zone list). */
  prefer?: (string | undefined)[]
}

/**
 * Classifies a text into zones by keywords (accent-insensitive, prefixes tolerated).
 * Returns zones sorted by decreasing score, at most `max`.
 */
export function classifyZones(text: string, zones: Pick<Zone, "id" | "name" | "keywords">[], max = 2, opts: ClassifyOptions = {}): string[] {
  const scored = scoreZones(text, zones, opts)
  if (scored.length === 0) return []
  const best = scored[0].score
  return scored
    .filter((s) => s.score >= Math.max(0.5, best * 0.5))
    .slice(0, max)
    .map((s) => s.zone)
}

export function scoreZones(text: string, zones: Pick<Zone, "id" | "name" | "keywords">[], opts: ClassifyOptions = {}): { zone: string; score: number }[] {
  return zoneScorer(zones)(text, opts)
}

export type ZoneScorer = (text: string, opts?: ClassifyOptions) => { zone: string; score: number }[]

/**
 * scoreZones with the zone keywords normalized once: to classify many texts against the same zones
 * (each item of a distillation) without normalizing every keyword on every call.
 */
export function zoneScorer(zones: Pick<Zone, "id" | "name" | "keywords">[]): ZoneScorer {
  const prepared = zones.map((z) => {
    const kws = new Set([...z.keywords.map(normalize), normalize(z.id), normalize(z.name)])
    return { id: z.id, kws, long: [...kws].filter((k) => k.length >= 5) }
  })
  return (text, opts = {}) => {
    const tokens = tokenize(text)
    if (tokens.length === 0) return []
    const out: { zone: string; score: number }[] = []
    for (const z of prepared) {
      let score = 0
      for (const t of tokens) {
        if (z.kws.has(t)) score += 1
        else if (t.length >= 5 && z.long.some((k) => t.startsWith(k) || k.startsWith(t))) score += 0.5
      }
      if (score > 0) out.push({ zone: z.id, score })
    }
    const prefer = (opts.prefer ?? []).filter((z): z is string => Boolean(z))
    const rank = (id: string) => (prefer.includes(id) ? prefer.indexOf(id) : prefer.length)
    return out.sort((a, b) => b.score - a.score || rank(a.zone) - rank(b.zone))
  }
}
