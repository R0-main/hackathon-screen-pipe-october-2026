import { test } from "node:test"
import assert from "node:assert/strict"
import { migrationOnBuild } from "./migrate-policy"

const DB = "postgresql://u:p@db.example.com/brain"

test("migrations at build time: Vercel production yes, preview no, without a database never", () => {
  assert.equal(migrationOnBuild({ VERCEL: "1", VERCEL_ENV: "production", DATABASE_URL: DB }).run, true)
  assert.equal(migrationOnBuild({ VERCEL: "1", VERCEL_ENV: "preview", DATABASE_URL: DB }).run, false)
  assert.equal(migrationOnBuild({ VERCEL: "1", VERCEL_ENV: "production" }).run, false, "file storage: nothing to migrate")
  assert.equal(migrationOnBuild({ DATABASE_URL: DB }).run, false, "local or Docker build: the container migrates when it starts")
})

test("migrations at build time: forced or turned off by BRAIN_MIGRATE_ON_BUILD, dedicated URL accepted", () => {
  assert.equal(migrationOnBuild({ VERCEL: "1", VERCEL_ENV: "preview", DATABASE_URL: DB, BRAIN_MIGRATE_ON_BUILD: "1" }).run, true)
  assert.equal(migrationOnBuild({ DATABASE_URL: DB, BRAIN_MIGRATE_ON_BUILD: "yes" }).run, true)
  assert.equal(migrationOnBuild({ VERCEL: "1", VERCEL_ENV: "production", DATABASE_URL: DB, BRAIN_MIGRATE_ON_BUILD: "0" }).run, false)
  assert.equal(migrationOnBuild({ BRAIN_MIGRATE_ON_BUILD: "1" }).run, false, "forced but without a database: nothing to do")
  assert.equal(migrationOnBuild({ VERCEL: "1", VERCEL_ENV: "production", DATABASE_MIGRATE_URL: DB }).run, true)
})
