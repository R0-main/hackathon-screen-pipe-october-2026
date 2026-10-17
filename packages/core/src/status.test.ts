import { test } from "node:test"
import assert from "node:assert/strict"
import {
  DISTILL_MARKER,
  STATUS_SYSTEM,
  StatusPayloadSchema,
  buildCliStatusPrompt,
  buildStatusInput,
  buildStatusPrompt,
  heuristicStatus,
  parseStatusJson,
  type KnowledgeItem,
  type StatusInput,
  type Task,
} from "./index"

const INPUT: StatusInput = {
  company_name: "Fournil",
  generated_for: "2026-10-16",
  zones: [
    { id: "dev", name: "Dev", description: "Code and deployments" },
    { id: "finance", name: "Finance", description: "Invoices and payroll" },
  ],
  items: [
    { zone: "dev", kind: "decision", title: "We're going with Stripe Billing", body: "Native proration.", author: "Hugo", created_at: "2026-10-15T09:00:00Z" },
    { zone: "finance", kind: "fact", title: "September VAT: €18,240", body: "VAT return ready.", author: "Jean-Marc", created_at: "2026-10-14T09:00:00Z" },
  ],
  tasks: [
    { zone: "dev", title: "Migrate the webhook", status: "open", assignee: "Inès" },
    { zone: "finance", title: "Chase Maison Kayser", status: "done" },
  ],
}

test("status: the CLI prompt starts with the marker, carries the instructions and only asks for JSON", () => {
  const p = buildCliStatusPrompt(INPUT)
  assert.ok(p.startsWith(DISTILL_MARKER), "brain-sync must never ingest this session")
  assert.ok(p.includes(STATUS_SYSTEM))
  assert.match(p, /Reply ONLY with a JSON object/)
  assert.match(p, /\{"headline":"…","zones":\[\{"zone":"<id>","summary":"…","objectives":\["…"\],"progress":"…","next_steps":\["…"\],"who_did_what":\[\{"person":"…","did":"…"\}\]\}\]\}/)
  assert.match(p, /exact id \(dev, finance\)/)
  assert.match(p, /Company: Fournil\nDate: 2026-10-16/)
})

test("status: each zone section only contains ITS knowledge and ITS tasks; the instructions require it", () => {
  const p = buildStatusPrompt(INPUT)
  const dev = p.slice(p.indexOf("## Zone dev"), p.indexOf("## Zone finance"))
  const finance = p.slice(p.indexOf("## Zone finance"))
  assert.ok(dev.includes("Stripe Billing") && dev.includes("Migrate the webhook (Inès)") && dev.includes("by Hugo, 2026-10-15"))
  assert.ok(!dev.includes("VAT") && !dev.includes("Kayser"))
  assert.ok(finance.includes("September VAT") && finance.includes("[done] Chase Maison Kayser"))
  assert.ok(!finance.includes("Stripe") && !finance.includes("webhook"))
  assert.match(STATUS_SYSTEM, /ONLY on the knowledge and tasks listed under that zone/)
  assert.match(STATUS_SYSTEM, /headline[^\n]*summarize all zones/)
  assert.match(STATUS_SYSTEM, /gender/)
})

test("status: buildStatusInput keeps 30 days, 400 items at most, most recent first, with names", () => {
  const now = new Date("2026-10-16T12:00:00Z")
  const mk = (i: number, daysAgo: number, zone = "dev"): KnowledgeItem => ({
    id: `k${i}`, org_id: "o", author_id: i % 2 ? "u1" : "u2", zone, kind: "fact", title: `Item ${i}`, body: "x".repeat(2000), entities: [],
    source: { app: "t", tool: "claude-code", at: "" }, confidence: 0.6, created_at: new Date(now.getTime() - daysAgo * 86400_000 - i * 1000).toISOString(),
  })
  const items = [...Array.from({ length: 450 }, (_, i) => mk(i, 1)), mk(999, 40), mk(1000, 2, "unknown")]
  const tasks: Task[] = [{ id: "t", title: "Do it", zone: "dev", assignee_id: "u2", status: "open", created_at: "", updated_at: "" }]
  const input = buildStatusInput({
    companyName: "Fournil", now, items, tasks,
    zones: [{ id: "dev", name: "Dev", description: "" }],
    profiles: [{ id: "u1", name: "Hugo" }, { id: "u2", name: "Inès" }],
  })
  assert.equal(input.generated_for, "2026-10-16")
  assert.equal(input.items.length, 400)
  assert.ok(input.items.every((i, n) => n === 0 || input.items[n - 1].created_at >= i.created_at), "most recent first")
  assert.ok(!input.items.some((i) => i.title === "Item 999" || i.zone === "unknown"))
  assert.deepEqual([input.items[0].author, input.items[1].author], ["Inès", "Hugo"])
  assert.ok(input.items[0].body.length <= 1200)
  assert.deepEqual(input.tasks, [{ zone: "dev", title: "Do it", status: "open", assignee: "Inès" }])
})

const GOOD = {
  headline: "Busy week: Stripe in progress, VAT ready.",
  zones: [
    { zone: "dev", summary: "Stripe migration.", objectives: ["Billing in prod"], progress: "1/2", next_steps: ["Webhook"], who_did_what: [{ person: "Hugo", did: "chose Stripe" }] },
    { zone: "finance", summary: "VAT ready.", objectives: [], progress: "ok", next_steps: [], who_did_what: [] },
  ],
}

test("status: parseStatusJson reads raw JSON, surrounded by text, in a code block or in the CLI envelope", () => {
  const ids = ["dev", "finance"]
  const raw = JSON.stringify(GOOD)
  const variants: [string, string][] = [
    ["raw", raw],
    ["code block", "```json\n" + raw + "\n```"],
    ["text around", `Here is the summary you asked for:\n${raw}\nEnjoy!`],
    ["text with braces before", `Note {draft}: ${raw}`],
    ["CLI envelope", JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "```json\n" + raw + "\n```", session_id: "x" })],
    ["trailing comma", raw.replace(/\]\}$/, ",]}")],
  ]
  for (const [name, text] of variants) {
    const r = parseStatusJson(text, ids)
    assert.ok(r, name)
    assert.equal(r.headline, GOOD.headline, name)
    assert.deepEqual(r.zones.map((z) => z.zone), ["dev", "finance"], name)
    assert.ok(StatusPayloadSchema.safeParse({ status: r }).success, `${name}: matches the POST /api/status schema`)
  }
})

test("status: parseStatusJson drops unknown or duplicate zones, fills in missing fields, null if unusable", () => {
  const partial = {
    headline: "  A   quiet week.  ",
    zones: [
      { zone: "Dev", summary: 12, objectives: ["Ship", 3, null, { x: 1 }], who_did_what: [{ person: "Hugo", did: "shipped" }, { person: "", did: "nothing" }, "Inès"] },
      { zone: "dev", summary: "duplicate" },
      { zone: "marketing", summary: "unknown zone" },
      { summary: "no id" },
      "not an object",
    ],
  }
  const r = parseStatusJson(JSON.stringify(partial), ["dev", "finance"])
  assert.deepEqual(r, {
    headline: "A quiet week.",
    zones: [{ zone: "dev", summary: "", objectives: ["Ship", "3"], progress: "", next_steps: [], who_did_what: [{ person: "Hugo", did: "shipped" }] }],
  })
  // Unusable: nothing, plain text, truncated JSON, no headline, envelope in error.
  const unusable = [
    "",
    "I can't help with this request.",
    JSON.stringify(GOOD).slice(0, 60),
    JSON.stringify({ zones: GOOD.zones }),
    JSON.stringify({ headline: "   ", zones: GOOD.zones }),
    JSON.stringify({ type: "result", is_error: true, result: "Credit balance is too low" }),
    JSON.stringify({ type: "result", is_error: false, result: "Sorry, I have no data." }),
  ]
  for (const t of unusable) assert.equal(parseStatusJson(t, ["dev"]), null, t)
  // Bounded lengths.
  const long = parseStatusJson(JSON.stringify({ headline: "h".repeat(5000), zones: [{ zone: "dev", summary: "s".repeat(5000), next_steps: Array(30).fill("x") }] }), ["dev"])
  assert.ok(long && long.headline.length <= 600 && long.zones[0].summary.length <= 1500 && long.zones[0].next_steps.length <= 10)
})

test("status: an author without a profile is \"Unknown person\", without assuming gender", () => {
  const now = new Date("2026-10-16T12:00:00Z")
  const item: KnowledgeItem = {
    id: "k", org_id: "o", author_id: "deleted", zone: "dev", kind: "decision", title: "We're going with Stripe Billing", body: "Proration.",
    entities: [], source: { app: "t", tool: "claude-code", at: "" }, confidence: 0.6, created_at: "2026-10-15T09:00:00Z",
  }
  const input = buildStatusInput({ companyName: "Fournil", now, items: [item], tasks: [], zones: [{ id: "dev", name: "Dev", description: "" }], profiles: [] })
  assert.equal(input.items[0].author, "Unknown person")
  assert.match(buildStatusPrompt(input), /by Unknown person, 2026-10-15/)
  const status = heuristicStatus({
    zones: [{ id: "dev", name: "Dev", description: "", color: "#fff", keywords: [], position: 0 }],
    items: [item], tasks: [], profiles: [], now,
  })
  assert.equal(status.zones[0].who_did_what[0].person, "Unknown person")
})
