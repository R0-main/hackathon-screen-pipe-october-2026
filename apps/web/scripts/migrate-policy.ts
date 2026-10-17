// Quand appliquer les migrations automatiquement au build (`npm run build` de @brain/web, prebuild).
// Module pur (aucun import), testé par scripts/migrate-policy.test.ts.

export type MigrationDecision = { run: boolean; reason: string }

/**
 * - BRAIN_MIGRATE_ON_BUILD=0 : jamais au build.
 * - Pas de base (ni DATABASE_MIGRATE_URL ni DATABASE_URL) : rien à migrer (stockage fichier, build Docker, CI).
 * - BRAIN_MIGRATE_ON_BUILD=1 : toujours, où que ce soit (preview Vercel avec sa propre base, autre hébergeur).
 * - Vercel en production : oui. C'est le cas par défaut qui compte : chaque fusion dans master migre la base avant
 *   que le nouveau code ne soit servi ; si la migration échoue, le build échoue et Vercel garde l'ancien déploiement.
 * - Vercel en preview : non par défaut, car une preview partage souvent la base de production et une PR pas encore
 *   fusionnée ne doit pas en modifier le schéma.
 * - Ailleurs (build local, Docker) : non ; le conteneur migre à son démarrage (deploy/local/entrypoint.sh).
 */
export function migrationOnBuild(env: Record<string, string | undefined>): MigrationDecision {
  const flag = env.BRAIN_MIGRATE_ON_BUILD?.trim().toLowerCase()
  if (flag === "0" || flag === "false" || flag === "non") return { run: false, reason: "désactivées (BRAIN_MIGRATE_ON_BUILD=0)" }
  if (!(env.DATABASE_MIGRATE_URL || env.DATABASE_URL)) return { run: false, reason: "pas de base de données configurée (stockage fichier)" }
  if (flag === "1" || flag === "true" || flag === "oui") return { run: true, reason: "forcées (BRAIN_MIGRATE_ON_BUILD=1)" }
  if (env.VERCEL) {
    if (env.VERCEL_ENV === "production") return { run: true, reason: "déploiement de production Vercel" }
    return {
      run: false,
      reason: `déploiement Vercel « ${env.VERCEL_ENV ?? "?"} » : la base peut être celle de la production (BRAIN_MIGRATE_ON_BUILD=1 si cette preview a sa propre base)`,
    }
  }
  return { run: false, reason: "build hors Vercel : lancez npm run db:migrate (le conteneur Docker le fait à son démarrage)" }
}
