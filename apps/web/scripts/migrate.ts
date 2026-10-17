// Applies supabase/migrations/*.sql to the database (Supabase or plain Postgres), once each.
//
//   DATABASE_URL=… npm run db:migrate        by hand, or when the Docker container starts
//   tsx scripts/migrate.ts --on-build         at build time (prebuild of @brain/web): only when migrate-policy says so,
//                                             that is in production on Vercel by default
//
// DATABASE_MIGRATE_URL, if set, replaces DATABASE_URL (a direct connection rather than the pooler, for example).
// Safe in parallel (two builds, two containers): each step takes a transaction lock and checks again what is already
// applied; a transaction lock also holds behind a pooler in transaction mode (Neon, Supabase 6543).

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import postgres from "postgres"
import { migrationOnBuild } from "./migrate-policy"

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, "../../../supabase")
/** Migrations lock (distinct from the organization reset's, 7_204_331_117). */
const MIGRATIONS_LOCK = 7_204_331_118

async function main() {
  if (process.argv.includes("--on-build")) {
    const decision = migrationOnBuild(process.env)
    console.log(`Migrations at build time: ${decision.run ? "yes" : "no"}, ${decision.reason}.`)
    if (!decision.run) return
  }
  const url = process.env.DATABASE_MIGRATE_URL || process.env.DATABASE_URL
  if (!url) throw new Error("DATABASE_URL is missing.")
  const local = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url) || url.includes("host=/")
  const sql = postgres(url, { prepare: false, max: 1, ssl: local || process.env.DATABASE_SSL === "disable" ? false : "require", onnotice: () => {} })
  try {
    await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(${MIGRATIONS_LOCK})`
      await tx`create table if not exists brain_migrations (name text primary key, applied_at timestamptz not null default now())`
      const [{ exists }] = await tx`select exists (select 1 from pg_namespace where nspname = 'auth') as exists`
      if (!exists) {
        console.log("→ No auth schema (Postgres outside Supabase): applying supabase/local/auth_stub.sql")
        await tx.unsafe(fs.readFileSync(path.join(root, "local/auth_stub.sql"), "utf8"))
      }
    })
    const files = fs.readdirSync(path.join(root, "migrations")).filter((f) => f.endsWith(".sql")).sort()
    let applied = 0
    for (const f of files) {
      let done: boolean
      try {
        done = await sql.begin(async (tx) => {
          await tx`select pg_advisory_xact_lock(${MIGRATIONS_LOCK})`
          // Checked again under the lock: another instance may have applied it while we were waiting.
          const [already] = await tx`select 1 from brain_migrations where name = ${f}`
          if (already) return false
          await tx.unsafe(fs.readFileSync(path.join(root, "migrations", f), "utf8"))
          await tx`insert into brain_migrations (name) values (${f})`
          return true
        })
      } catch (err) {
        // The faulty file in the message: that is the one to look at (the transaction rolled it back entirely).
        throw new Error(`${f}: ${err instanceof Error ? err.message : String(err)}`)
      }
      if (done) applied++
      console.log(done ? `✓ ${f}` : `· ${f} (already applied)`)
    }
    console.log(applied ? `Migrations: ${applied} applied.` : "Migrations: database already up to date.")
  } finally {
    await sql.end({ timeout: 5 })
  }
}

main().catch((err) => {
  console.error(`Migrations: failed — ${err instanceof Error ? err.message : err}`)
  process.exit(1)
})
