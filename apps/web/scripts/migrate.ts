// Applique supabase/migrations/*.sql sur DATABASE_URL (Supabase ou Postgres « nu »), une seule fois chacune.
// Usage : DATABASE_URL=… npm run db:migrate

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import postgres from "postgres"

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, "../../../supabase")

async function main() {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error("DATABASE_URL manquant.")
  const local = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url) || url.includes("host=/")
  const sql = postgres(url, { prepare: false, max: 1, ssl: local || process.env.DATABASE_SSL === "disable" ? false : "require", onnotice: () => {} })
  try {
    await sql`create table if not exists brain_migrations (name text primary key, applied_at timestamptz not null default now())`
    const [{ exists }] = await sql`select exists (select 1 from pg_namespace where nspname = 'auth') as exists`
    if (!exists) {
      console.log("→ Pas de schéma auth (Postgres hors Supabase) : application de supabase/local/auth_stub.sql")
      await sql.unsafe(fs.readFileSync(path.join(root, "local/auth_stub.sql"), "utf8"))
    }
    const applied = new Set((await sql`select name from brain_migrations`).map((r) => r.name as string))
    const files = fs.readdirSync(path.join(root, "migrations")).filter((f) => f.endsWith(".sql")).sort()
    for (const f of files) {
      if (applied.has(f)) {
        console.log(`· ${f} (déjà appliquée)`)
        continue
      }
      await sql.begin(async (tx) => {
        await tx.unsafe(fs.readFileSync(path.join(root, "migrations", f), "utf8"))
        await tx`insert into brain_migrations (name) values (${f})`
      })
      console.log(`✓ ${f}`)
    }
  } finally {
    await sql.end({ timeout: 5 })
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
