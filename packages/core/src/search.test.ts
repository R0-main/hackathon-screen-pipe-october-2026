import { test } from "node:test"
import assert from "node:assert/strict"
import { cosine, expandQuery, jaccard, likeness, matchStrength, rrf, strongEnough } from "./search"

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
