import { test } from "node:test"
import assert from "node:assert/strict"
import { DEFAULT_ZONES, classifyZones, detectAutomations, planSchedule, promptFingerprint, scoreZones, slugify, tokenize, type AgentEvent } from "./index"
import { normalizeOnboardingZones, synthesizeOnboarding } from "./claude"

test("zones: explicit tie-breaking", () => {
  const text = "fix the error on the invoice"
  assert.deepEqual(scoreZones(text, DEFAULT_ZONES).map((s) => s.score), [1, 1])
  assert.equal(classifyZones(text, DEFAULT_ZONES, 1, { prefer: ["finance"] })[0], "finance")
  assert.equal(classifyZones(text, DEFAULT_ZONES, 1, { prefer: [undefined, "dev"] })[0], "dev")
  assert.equal(slugify("Customer_service"), "customer-service")
  assert.equal(slugify("a".repeat(31) + " b"), "a".repeat(31), "no trailing dash after cutting")
})

test("automation: the suggested slot follows the real rhythm (weekly, twice a week, daily)", () => {
  let id = 0
  const mk = (iso: string, text = "Do the weekly sales review"): AgentEvent => ({
    id: ++id, org_id: "o", user_id: "u1", agent: "claude-code", type: "query", zones: ["sales"], summary: text,
    fingerprint: promptFingerprint(text), at: new Date(iso).toISOString(),
  })
  const people = [{ id: "u1", name: "Sarah" }]
  // Once a week, but not always the same day (Mon 5, Tue 13, Wed 21 October).
  const sparse = detectAutomations(["2026-10-05T07:00:00Z", "2026-10-13T07:02:00Z", "2026-10-21T07:01:00Z"].map((s) => mk(s)), people, { now: new Date("2026-10-21T12:00:00Z") })
  assert.equal(sparse.length, 1)
  assert.equal(sparse[0].schedule, "Every Monday at 08:56")
  assert.match(sparse[0].description, /about once a week/)
  assert.doesNotMatch(sparse[0].description, /almost every day|Monday to Friday/)
  assert.equal(sparse[0].minutes_saved_per_week, 12)
  // Always the same day.
  const weekly = detectAutomations(["2026-10-05T07:00:00Z", "2026-10-12T07:02:00Z", "2026-10-19T07:01:00Z"].map((s) => mk(s)), people, { now: new Date("2026-10-19T12:00:00Z") })
  assert.equal(weekly[0].schedule, "Every Monday at 08:56")
  assert.match(weekly[0].description, /every Monday/)
  // Monday and Thursday for two weeks.
  const twice = ["2026-10-05T07:00:00Z", "2026-10-08T07:01:00Z", "2026-10-12T07:00:00Z", "2026-10-15T07:02:00Z"].map((s) => mk(s))
  const t = detectAutomations(twice, people, { now: new Date("2026-10-16T12:00:00Z") })
  assert.equal(t[0].schedule, "Every Monday and Thursday at 08:56")
  assert.match(t[0].description, /about 2 times a week/)
  assert.equal(t[0].minutes_saved_per_week, 24)
  // Every working day.
  const daily = ["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16"].map((d) => mk(`${d}T07:00:00Z`))
  const d = detectAutomations(daily, people, { now: new Date("2026-10-16T12:00:00Z") })
  assert.equal(d[0].schedule, "Monday to Friday at 08:55")
  assert.match(d[0].description, /almost every day/)
  assert.match(d[0].description, /run it automatically Monday to Friday at 08:55/, "day names keep their capital")
  assert.equal(d[0].minutes_saved_per_week, 60)
  assert.equal(planSchedule([{ weekday: 1, e: { at: "2026-10-05T07:00:00Z" } }, { weekday: 3, e: { at: "2026-10-28T07:00:00Z" } }], "09:00").runsPerWeek, 1)
})

test("onboarding: items follow the renaming of zone ids", async () => {
  const fake = {
    beta: {
      messages: {
        parse: async () => ({
          stop_reason: "end_turn",
          parsed_output: {
            company_name: "Fournil",
            description: "Bakeries",
            zones: [
              { id: "leadership", name: "Leadership", description: "", keywords: ["strategy"] },
              { id: "customer_service", name: "Customer service", description: "", keywords: ["helpdesk", "ticket"] },
              { id: "HR_Recruiting", name: "HR", description: "", keywords: ["recruiting"] },
            ],
            items: [
              { zone: "customer_service", kind: "procedure", title: "Unsold items are taken back the next day before 10am", body: "Take-back procedure.", entities: [], confidence: 0.8 },
              { zone: "HR_Recruiting", kind: "fact", title: "The probation period for bakers is two months", body: "Contract rule.", entities: [], confidence: 0.8 },
              { zone: "Customer service", kind: "fact", title: "Support answers within 24 hours", body: "Published commitment.", entities: [], confidence: 0.7 },
            ],
          },
        }),
      },
    },
  }
  const draft = await synthesizeOnboarding(fake as never, { answers: [], pages: [], existingZones: [] })
  assert.ok(draft)
  assert.deepEqual(draft.zones.map((z) => z.id), ["leadership", "customer-service", "hr-recruiting"])
  assert.deepEqual(draft.items.map((i) => i.zone), ["customer-service", "hr-recruiting", "customer-service"])
  // Duplicates after normalization: distinct ids, and a name never shadows another zone's id.
  const { zones, zoneId } = normalizeOnboardingZones([
    { id: "selling", name: "Sales" },
    { id: "Selling", name: "Commerce" },
    { id: "sales", name: "Partnerships" },
  ])
  assert.deepEqual(zones.map((z) => z.id), ["selling", "selling-2", "sales"])
  assert.equal(zoneId("sales"), "sales")
  assert.equal(zoneId("Commerce"), "selling-2")
})

test("zones: the CI acronym stays a Dev signal", () => {
  // Zones already stored in production: "ci" and "pr" in Dev, neither "gitlab" nor "cicd".
  const stored = DEFAULT_ZONES.map((z) =>
    z.id === "dev" ? { ...z, keywords: [...z.keywords.filter((k) => !["ci", "cicd", "github", "gitlab"].includes(k)), "ci", "pr"] } : z,
  )
  // [text, expected first zone]; outside Dev, "dev" must not appear anywhere. Default zones then stored ones.
  const cases: [string, string][] = [
    ["The CI/CD pipeline is failing", "dev"],
    ["Why is the CI so slow?", "dev"],
    ["gitlab-ci.yml does not pass", "dev"],
    ["GitHub's CI-CD is red", "dev"],
    ["The .github-ci job breaks on main", "dev"],
    ["What is the amount of unpaid invoices this month?", "finance"],
    ["Send the attached quote to the customer", "sales"],
  ]
  for (const zones of [DEFAULT_ZONES, stored]) {
    const wrong = cases
      .map(([t, want]) => ({ t, want, got: classifyZones(t, zones, 2) }))
      .filter(({ want, got }) => got[0] !== want || (want !== "dev" && got.includes("dev")))
    assert.deepEqual(wrong, [], zones === stored ? "stored zones" : "default zones")
  }
  assert.deepEqual(tokenize("gitlab-ci.yml"), ["gitlab", "ci", "yml"])
  assert.ok(tokenize("CI/CD").includes("cicd"))
  assert.ok(tokenize("the CI is broken").includes("ci"), "the acronym alone stays a word (search)")
})
