import { test } from "node:test"
import assert from "node:assert/strict"
import { cosine, expandQuery, jaccard, likeness, matchStrength, matchesFilter, rrf, strongEnough } from "./search"

test("expandQuery: synonyms, multi-word expressions, no duplicates", () => {
  const { tokens, added } = expandQuery("how do we deploy to prod?")
  assert.deepEqual(tokens, ["deploy", "prod"])
  for (const t of ["deployment", "ship", "production", "release"]) assert.ok(added.includes(t), `expected ${t}`)
  assert.ok(!added.includes("deploy"), "an original token is not added again")
  const inv = expandQuery("invoice overdue")
  assert.ok(inv.added.includes("billing"))
  assert.deepEqual(expandQuery("xyzzy").added, [])
})

test("jaccard and likeness: duplicate, replacement, unrelated", () => {
  assert.equal(jaccard(["a", "b"], ["a", "b"]), 1)
  assert.equal(jaccard(["a", "b"], ["c"]), 0)
  const a = { kind: "decision", title: "Subscriptions move to Stripe Billing", body: "We migrate from Checkout to Billing for subscription proration." }
  assert.equal(likeness({ ...a, body: `${a.body} ` }, a), "duplicate")
  const revised = { ...a, body: "In the end we stay on Checkout: Billing doesn't handle our annual discounts." }
  assert.equal(likeness(revised, a), "supersedes")
  assert.equal(likeness({ ...revised, kind: "task" }, { ...a, kind: "task" }), "different")
  assert.equal(likeness({ kind: "fact", title: "Monthly burn of €62k", body: "14 months of runway." }, a), "different")
  // A single-word title ("Deployment") is not enough to conclude a replacement.
  assert.equal(likeness({ kind: "procedure", title: "Deployment", body: "Merge into main then tag" }, { kind: "procedure", title: "Deployment", body: "Run the release script" }), "different")
})

test("matchStrength: a synonym that only catches an isolated word of the body is not enough", () => {
  const { tokens, added } = expandQuery("deploy to production")
  const q = [...tokens, ...added]
  const finance = { title: "Month-end close: Pennylane export before the 5th for the Durand firm", body: "The accountant (Durand firm) produces the monthly statement within 10 days from this export.", entities: [{ name: "Pennylane" }] }
  const s = matchStrength(q, finance)
  assert.equal(s.title, 0)
  assert.equal(s.total, 1, "\"prod\" catches \"produces\" in the body, and nothing else")
  assert.equal(strongEnough(s), false)
  const dev = { title: "Deploy Fournil to production", body: "1. Merge into main. 2. Tag. 3. Watch Sentry.", entities: [{ name: "Vercel" }] }
  assert.equal(strongEnough(matchStrength(q, dev)), true)
  const release = matchStrength([...expandQuery("how do we ship a release").tokens, ...expandQuery("how do we ship a release").added], dev)
  assert.ok(release.title >= 1, "\"release\" expands to \"deploy\", found in the title")
})

test("rrf: a result present in two lists rises", () => {
  const out = rrf([
    ["a", "b", "c"],
    ["c", "d"],
  ])
  assert.equal(out[0].id, "c")
  assert.ok(out.find((x) => x.id === "a")!.score > out.find((x) => x.id === "d")!.score)
})

test("cosine", () => {
  assert.ok(Math.abs(cosine([1, 0], [1, 0]) - 1) < 1e-9)
  assert.equal(cosine([1, 0], [0, 1]), 0)
  assert.equal(cosine([1, 0], [1]), 0)
  assert.equal(cosine([0, 0], [1, 1]), 0)
})

test("rrf: a list's weight multiplies its votes; the question as asked can lead its rewordings", () => {
  const asked = ["a", "b"]
  const reworded = ["b", "a"]
  assert.equal(rrf([asked, reworded])[0].score, rrf([asked, reworded])[1].score, "equal weights: a tie")
  assert.deepEqual(rrf([asked, reworded], 60, [2]).map((r) => r.id), ["a", "b"], "the first list weighing 2 wins the tie")
  assert.deepEqual(rrf([asked, reworded, reworded, reworded], 60, [2]).map((r) => r.id), ["b", "a"], "three rewordings agreeing still outvote it")
})

test("matchesFilter: dated by the source, from `since` included to `until` excluded, by one of the authors", () => {
  const item = { author_id: "sarah", created_at: "2026-10-25T09:00:00.000Z", source: { at: "2026-10-10T09:00:00.000Z" } }
  assert.ok(matchesFilter(item, undefined))
  assert.ok(matchesFilter(item, { since: "2026-10-10T09:00:00.000Z", until: "2026-10-11T00:00:00.000Z" }))
  assert.ok(!matchesFilter(item, { since: "2026-10-20T00:00:00.000Z" }), "the date said is the source's, not the ingestion's")
  assert.ok(!matchesFilter(item, { until: "2026-10-10T09:00:00.000Z" }))
  assert.ok(matchesFilter(item, { authors: ["hugo", "sarah"] }))
  assert.ok(!matchesFilter(item, { authors: [] }), "nobody of that name: nothing")
  assert.ok(matchesFilter({ author_id: "x", created_at: "2026-10-25T09:00:00.000Z" }, { since: "2026-10-20T00:00:00.000Z" }), "without a source, the creation date")
})
