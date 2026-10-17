import { test } from "node:test"
import assert from "node:assert/strict"
import { migrationOnBuild } from "./migrate-policy"

const DB = "postgresql://u:p@db.example.com/brain"

test("migrations au build : production Vercel oui, preview non, sans base jamais", () => {
  assert.equal(migrationOnBuild({ VERCEL: "1", VERCEL_ENV: "production", DATABASE_URL: DB }).run, true)
  assert.equal(migrationOnBuild({ VERCEL: "1", VERCEL_ENV: "preview", DATABASE_URL: DB }).run, false)
  assert.equal(migrationOnBuild({ VERCEL: "1", VERCEL_ENV: "production" }).run, false, "stockage fichier : rien à migrer")
  assert.equal(migrationOnBuild({ DATABASE_URL: DB }).run, false, "build local ou Docker : le conteneur migre au démarrage")
})

test("migrations au build : forcées ou coupées par BRAIN_MIGRATE_ON_BUILD, URL dédiée acceptée", () => {
  assert.equal(migrationOnBuild({ VERCEL: "1", VERCEL_ENV: "preview", DATABASE_URL: DB, BRAIN_MIGRATE_ON_BUILD: "1" }).run, true)
  assert.equal(migrationOnBuild({ DATABASE_URL: DB, BRAIN_MIGRATE_ON_BUILD: "oui" }).run, true)
  assert.equal(migrationOnBuild({ VERCEL: "1", VERCEL_ENV: "production", DATABASE_URL: DB, BRAIN_MIGRATE_ON_BUILD: "0" }).run, false)
  assert.equal(migrationOnBuild({ BRAIN_MIGRATE_ON_BUILD: "1" }).run, false, "forcé mais sans base : rien à faire")
  assert.equal(migrationOnBuild({ VERCEL: "1", VERCEL_ENV: "production", DATABASE_MIGRATE_URL: DB }).run, true)
})
