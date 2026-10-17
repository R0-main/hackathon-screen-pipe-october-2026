import { test } from "node:test"
import assert from "node:assert/strict"
import { LATE_AFTER_MS, workstationHealth } from "./monitoring"

const now = Date.parse("2026-10-17T12:00:00Z")
const ago = (ms: number) => new Date(now - ms).toISOString()

test("workstationHealth: never connected, late, error, ok", () => {
  assert.equal(workstationHealth({ report: null, lastEventAt: null, now }).status, "never")
  assert.equal(workstationHealth({ report: null, lastEventAt: ago(60_000), now }).status, "late")
  assert.equal(workstationHealth({ report: { at: ago(60_000), ok: false, error: "token expired" }, lastEventAt: null, now }).status, "error")
  assert.equal(workstationHealth({ report: { at: ago(60_000), ok: false, error: "token expired" }, lastEventAt: null, now }).reason, "token expired")
  assert.equal(workstationHealth({ report: { at: ago(LATE_AFTER_MS + 1), ok: true }, lastEventAt: null, now }).status, "late")
  assert.equal(workstationHealth({ report: { at: ago(LATE_AFTER_MS - 1), ok: true }, lastEventAt: null, now }).status, "ok")
  assert.equal(workstationHealth({ report: { at: "not a date", ok: true }, lastEventAt: null, now }).status, "late")
})
