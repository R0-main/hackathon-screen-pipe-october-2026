import { test } from "node:test"
import assert from "node:assert/strict"
import { MAX_KEYWORDS, buildCliKeywordsPrompt, buildKeywordsPrompt, cleanKeywords, keywordsSearchText, parseKeywords } from "./index"

const item = {
  zone: "finance",
  zoneName: "Finance",
  kind: "fact" as const,
  title: "The buyers' Qonto cards are capped at €20,000 a month",
  body: "Raised to €35,000 in October and November for the Black Friday stock.",
  entities: [{ type: "tool" as const, name: "Qonto" }],
  source: { app: "Terminal", tool: "claude-code" as const, at: "2026-10-06T08:00:00.000Z" },
  author: 'Jean-Marc "JM" Dubois',
}

test("buildKeywordsPrompt: one item, with where it comes from; quotes never break the attributes", () => {
  const p = buildKeywordsPrompt(item)
  assert.match(p, /^<knowledge zone="Finance" type="fact" author="Jean-Marc 'JM' Dubois" app="Terminal" tool="claude-code" date="2026-10-06">/)
  assert.ok(p.includes("title: The buyers' Qonto cards") && p.includes("entities: Qonto (tool)"))
  assert.ok(buildCliKeywordsPrompt(item).includes('{"keywords":['), "the CLI version asks for raw JSON")
})

test("cleanKeywords: trimmed, deduplicated whatever the case or accents, bounded, never the bare title", () => {
  const kept = cleanKeywords(['  "plafond carte" ', "Plafond Carte", "plafond carté", "", 42, "x".repeat(61), "The buyers' Qonto cards are capped at €20,000 a month", "spending limit."], item.title)
  assert.deepEqual(kept, ["plafond carte", "spending limit"])
  assert.equal(cleanKeywords(Array.from({ length: 40 }, (_, n) => `term ${n}`)).length, MAX_KEYWORDS)
  assert.deepEqual(cleanKeywords("not a list"), [])
})

test("parseKeywords: the JSON asked for, a code block around it, a bare array or a plain list", () => {
  assert.deepEqual(parseKeywords('{"keywords":["spending limit","plafond"]}'), ["spending limit", "plafond"])
  assert.deepEqual(parseKeywords('Here:\n```json\n{"keywords":["a b","c d"]}\n```'), ["a b", "c d"])
  assert.deepEqual(parseKeywords('["one", "two"]'), ["one", "two"])
  assert.deepEqual(parseKeywords("- spending limit\n- plafond de carte\n- card cap"), ["spending limit", "plafond de carte", "card cap"])
  assert.equal(parseKeywords("Sorry, I cannot help with that."), null, "a sentence is not a list")
})

test("keywordsSearchText: normalized like the title and the body", () => {
  assert.equal(keywordsSearchText(["Plafond de dépense", "TVA"]), "plafond de depense tva")
  assert.equal(keywordsSearchText(undefined), "")
})
