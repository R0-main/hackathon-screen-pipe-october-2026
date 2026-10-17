import { test } from "node:test"
import assert from "node:assert/strict"
import {
  DEFAULT_ZONES,
  classifyZones,
  detectAutomations,
  distillHeuristic,
  heuristicStatus,
  isAllowedApp,
  promptFingerprint,
  redact,
  type AgentEvent,
  type Conversation,
} from "./index"

test("redact hides secrets and personal data, without touching the rest", () => {
  const input = [
    // fake tokens assembled at runtime (GitHub secret scanning protection)
    ["key sk-", "ant-api03-AbCdEfGhIjKlMnOpQrStUv and ghp", "_abcdefghijklmnopqrstuvwxyz0123"].join(""),
    "write to jane.doe@example.com or call 06 12 34 56 78",
    "DATABASE_PASSWORD=hunter2hunter2",
    "postgres://admin:s3cret@db.example.com:5432/app",
    "IBAN FR76 3000 6000 0112 3456 7890 189",
    "card 4111 1111 1111 1111, timestamp 1697456789123",
    "we're going with Stripe Billing",
  ].join("\n")
  const { text, redactions } = redact(input)
  for (const leaked of ["sk-ant-api03", "ghp_", "jane.doe@", "06 12 34", "hunter2", "s3cret", "FR76 3000", "4111 1111"]) {
    assert.ok(!text.includes(leaked), `leak: ${leaked}`)
  }
  assert.ok(text.includes("1697456789123"), "a timestamp is not a card number (Luhn)")
  assert.ok(text.includes("we're going with Stripe Billing"))
  assert.ok(Object.keys(redactions).length >= 7)
})

test("app allowlist: AI sessions yes, personal no", () => {
  assert.ok(isAllowedApp("Terminal", "claude — ~/code/fournil"))
  assert.ok(isAllowedApp("Google Chrome", "Claude — New chat"))
  assert.ok(!isAllowedApp("Google Chrome", "Chase — My accounts"))
  assert.ok(!isAllowedApp("WhatsApp", "Mom"))
  assert.ok(!isAllowedApp("Spotify", ""))
})

test("zone classification (accent-insensitive, prefixes)", () => {
  assert.deepEqual(classifyZones("Prepare the VAT return from Pennylane", DEFAULT_ZONES, 1), ["finance"])
  assert.deepEqual(classifyZones("how do we deploy to production?", DEFAULT_ZONES, 1), ["dev"])
  assert.deepEqual(classifyZones("follow up with the prospect after the demo", DEFAULT_ZONES, 1), ["sales"])
  assert.deepEqual(classifyZones("hello", DEFAULT_ZONES), [])
})

test("prompt fingerprint stable despite dates and numbers", () => {
  assert.equal(
    promptFingerprint("Reconcile yesterday's Qonto statements with the invoices"),
    promptFingerprint("reconcile yesterday's qonto statements with the invoices"),
  )
  assert.equal(promptFingerprint("Report of 10/12: 3 variances"), promptFingerprint("Report of 10/13: 5 variances"))
})

test("automation detection: same prompt, same slot, ≥ 3 days", () => {
  const fp = promptFingerprint("bank reconciliation")
  const base = Date.parse("2026-10-12T07:05:00Z") // 9:05 in Paris
  const ev = (day: number, minutes: number, id: number): AgentEvent => ({
    id, org_id: "o", user_id: "jm", agent: "claude-code", type: "query", zones: ["finance"],
    summary: "Bank reconciliation", fingerprint: fp, at: new Date(base + day * 86400_000 + minutes * 60_000).toISOString(),
  })
  const regular = [ev(0, 0, 1), ev(1, 3, 2), ev(2, -2, 3), ev(3, 4, 4)]
  const found = detectAutomations(regular, [{ id: "jm", name: "Jean-Marc" }], { now: new Date(base + 4 * 86400_000) })
  assert.equal(found.length, 1)
  assert.equal(found[0].zone, "finance")
  assert.match(found[0].description, /Jean-Marc/)
  const scattered = [ev(0, 0, 1), ev(1, 300, 2), ev(2, -120, 3), ev(3, 420, 4)]
  assert.equal(detectAutomations(scattered, [], { now: new Date(base + 4 * 86400_000) }).length, 0)
})

test("heuristic distillation: decision, task, procedure", () => {
  const conv: Conversation = {
    id: "s1", tool: "claude-code", app: "Terminal", cwd: "/home/hugo/fournil", started_at: "2026-10-16T08:00:00Z", ended_at: "2026-10-16T08:30:00Z",
    messages: [
      { role: "user", text: "How do we handle annual subscriptions with Stripe? And how long do we keep the old prices?" },
      {
        role: "assistant",
        text: "We're going with Stripe Billing to handle proration.\nSteps:\n1. Create the annual prices\n2. Migrate the customers\n3. Turn on the customer portal\nTODO: tell finance about the change",
      },
    ],
  }
  const items = distillHeuristic(conv, DEFAULT_ZONES)
  const kinds = items.map((i) => i.kind)
  assert.ok(kinds.includes("decision"), JSON.stringify(items, null, 1))
  assert.ok(items.filter((i) => i.kind === "decision").every((i) => !i.title.includes("?")), "a question is not a decision")
  assert.ok(kinds.includes("task"))
  assert.ok(kinds.includes("procedure"))
  assert.ok(items.every((i) => i.entities.some((e) => e.name === "Stripe")))
  assert.ok(items.some((i) => i.entities.some((e) => e.type === "project" && e.name === "fournil")))
})

test("heuristic status summary", () => {
  const status = heuristicStatus({ zones: DEFAULT_ZONES, items: [], tasks: [], profiles: [] })
  assert.equal(status.zones.length, DEFAULT_ZONES.length)
  assert.equal(status.generator, "heuristic")
})
