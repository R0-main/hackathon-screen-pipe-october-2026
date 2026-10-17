import { test } from "node:test"
import assert from "node:assert/strict"
import { buildSyncReport, reportError } from "../src/report"
import type { SyncSummary } from "../src/sync"

const summary: SyncSummary = { conversations: { claude: 3, screenpipe: 1 }, items: [], sent: 4, duplicates: 1, zones: { dev: 4 }, distiller: "claude-cli", deferred: 2, failed: 1 }

test("buildSyncReport : compteurs d'une synchro réussie", () => {
  const r = buildSyncReport({ summary, startedAt: 1_000, now: 4_500, version: "0.1.0" })
  assert.equal(r.ok, true)
  assert.equal(r.duration_ms, 3_500)
  assert.equal(r.items_sent, 4)
  assert.equal(r.duplicates, 1)
  assert.deepEqual(r.conversations, { claude: 3, screenpipe: 1 })
  assert.equal(r.distiller, "claude-cli")
  assert.equal(r.failed, 1)
  assert.equal(r.deferred, 2)
  assert.equal(r.error, undefined)
  assert.equal(r.client_version, "0.1.0")
  assert.equal(r.at, new Date(4_500).toISOString())
})

test("buildSyncReport : une synchro en échec rapporte l'erreur, masquée et courte", () => {
  const err = new Error(["Impossible de joindre le cerveau : jeton cb_", "ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 refusé, postgres://u:s3cret@db/app"].join(""))
  const r = buildSyncReport({ summary: null, startedAt: 0, now: 10, error: err, version: "0.1.0" })
  assert.equal(r.ok, false)
  assert.equal(r.items_sent, 0)
  assert.ok(r.error && !r.error.includes("ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"), "jeton masqué")
  assert.ok(r.error && !r.error.includes("s3cret"), "mot de passe masqué")
  assert.ok(reportError("x".repeat(2000)).length <= 500)
})
