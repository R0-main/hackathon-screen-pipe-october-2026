import { test } from "node:test"
import assert from "node:assert/strict"
import { LATE_AFTER_MS, posteHealth } from "./monitoring"

const now = Date.parse("2026-10-17T12:00:00Z")
const ago = (ms: number) => new Date(now - ms).toISOString()

test("posteHealth : jamais branché, en retard, en erreur, ok", () => {
  assert.equal(posteHealth({ report: null, lastEventAt: null, now }).status, "never")
  assert.equal(posteHealth({ report: null, lastEventAt: ago(60_000), now }).status, "late")
  assert.equal(posteHealth({ report: { at: ago(60_000), ok: false, error: "jeton expiré" }, lastEventAt: null, now }).status, "error")
  assert.equal(posteHealth({ report: { at: ago(60_000), ok: false, error: "jeton expiré" }, lastEventAt: null, now }).reason, "jeton expiré")
  assert.equal(posteHealth({ report: { at: ago(LATE_AFTER_MS + 1), ok: true }, lastEventAt: null, now }).status, "late")
  assert.equal(posteHealth({ report: { at: ago(LATE_AFTER_MS - 1), ok: true }, lastEventAt: null, now }).status, "ok")
  assert.equal(posteHealth({ report: { at: "pas une date", ok: true }, lastEventAt: null, now }).status, "late")
})
