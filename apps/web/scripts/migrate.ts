// Applique supabase/migrations/*.sql sur la base (Supabase ou Postgres « nu »), une seule fois chacune.
//
//   DATABASE_URL=… npm run db:migrate        à la main, ou au démarrage du conteneur Docker
//   tsx scripts/migrate.ts --on-build         au build (prebuild de @brain/web) : seulement quand migrate-policy le dit,
//                                             c'est-à-dire en production sur Vercel par défaut
//
// DATABASE_MIGRATE_URL, si défini, remplace DATABASE_URL (connexion directe plutôt que le pooler, par exemple).
// Sûr en parallèle (deux builds, deux conteneurs) : chaque étape prend un verrou transactionnel et revérifie ce qui est
// déjà appliqué ; un verrou de transaction tient aussi derrière un pooler en mode transaction (Neon, Supabase 6543).

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import postgres from "postgres"
import { migrationOnBuild } from "./migrate-policy"

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, "../../../supabase")
/** Verrou des migrations (distinct de celui du reset de l'organisation, 7_204_331_117). */
const MIGRATIONS_LOCK = 7_204_331_118

async function main() {
  if (process.argv.includes("--on-build")) {
    const decision = migrationOnBuild(process.env)
    console.log(`Migrations au build : ${decision.run ? "oui" : "non"}, ${decision.reason}.`)
    if (!decision.run) return
  }
  const url = process.env.DATABASE_MIGRATE_URL || process.env.DATABASE_URL
  if (!url) throw new Error("DATABASE_URL manquant.")
  const local = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url) || url.includes("host=/")
  const sql = postgres(url, { prepare: false, max: 1, ssl: local || process.env.DATABASE_SSL === "disable" ? false : "require", onnotice: () => {} })
  try {
    await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(${MIGRATIONS_LOCK})`
      await tx`create table if not exists brain_migrations (name text primary key, applied_at timestamptz not null default now())`
      const [{ exists }] = await tx`select exists (select 1 from pg_namespace where nspname = 'auth') as exists`
      if (!exists) {
        console.log("→ Pas de schéma auth (Postgres hors Supabase) : application de supabase/local/auth_stub.sql")
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
          // Revérifié sous le verrou : une autre instance a pu l'appliquer pendant qu'on attendait.
          const [already] = await tx`select 1 from brain_migrations where name = ${f}`
          if (already) return false
          await tx.unsafe(fs.readFileSync(path.join(root, "migrations", f), "utf8"))
          await tx`insert into brain_migrations (name) values (${f})`
          return true
        })
      } catch (err) {
        // Le fichier fautif dans le message : c'est lui qu'il faut regarder (la transaction l'a entièrement annulé).
        throw new Error(`${f} : ${err instanceof Error ? err.message : String(err)}`)
      }
      if (done) applied++
      console.log(done ? `✓ ${f}` : `· ${f} (déjà appliquée)`)
    }
    console.log(applied ? `Migrations : ${applied} appliquée(s).` : "Migrations : base déjà à jour.")
  } finally {
    await sql.end({ timeout: 5 })
  }
}

main().catch((err) => {
  console.error(`Migrations : échec — ${err instanceof Error ? err.message : err}`)
  process.exit(1)
})
