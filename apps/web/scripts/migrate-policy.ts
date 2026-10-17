// When to apply the migrations automatically at build time (`npm run build` of @brain/web, prebuild).
// Pure module (no import), tested by scripts/migrate-policy.test.ts.

export type MigrationDecision = { run: boolean; reason: string }

/**
 * - BRAIN_MIGRATE_ON_BUILD=0: never at build time.
 * - No database (neither DATABASE_MIGRATE_URL nor DATABASE_URL): nothing to migrate (file storage, Docker build, CI).
 * - BRAIN_MIGRATE_ON_BUILD=1: always, wherever it is (Vercel preview with its own database, another host).
 * - Vercel in production: yes. It is the default case that matters: each merge into master migrates the database before
 *   the new code is served; if the migration fails, the build fails and Vercel keeps the previous deployment.
 * - Vercel in preview: no by default, since a preview often shares the production database and a PR not merged yet
 *   must not change its schema.
 * - Elsewhere (local build, Docker): no; the container migrates when it starts (deploy/local/entrypoint.sh).
 */
export function migrationOnBuild(env: Record<string, string | undefined>): MigrationDecision {
  const flag = env.BRAIN_MIGRATE_ON_BUILD?.trim().toLowerCase()
  if (flag === "0" || flag === "false" || flag === "no" || flag === "non") return { run: false, reason: "turned off (BRAIN_MIGRATE_ON_BUILD=0)" }
  if (!(env.DATABASE_MIGRATE_URL || env.DATABASE_URL)) return { run: false, reason: "no database configured (file storage)" }
  if (flag === "1" || flag === "true" || flag === "yes" || flag === "oui") return { run: true, reason: "forced (BRAIN_MIGRATE_ON_BUILD=1)" }
  if (env.VERCEL) {
    if (env.VERCEL_ENV === "production") return { run: true, reason: "Vercel production deployment" }
    return {
      run: false,
      reason: `Vercel "${env.VERCEL_ENV ?? "?"}" deployment: the database may be the production one (BRAIN_MIGRATE_ON_BUILD=1 if this preview has its own database)`,
    }
  }
  return { run: false, reason: "build outside Vercel: run npm run db:migrate (the Docker container does it when it starts)" }
}
