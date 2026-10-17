// Stockage pas prêt (migration non appliquée…) : erreur de configuration, pas un bug.
// Les routes répondent 503 avec son message ; une session de dashboard qu'on ne peut pas vérifier est refusée (401).

export const STORE_SETUP_ERROR = "BRAIN_STORE_SETUP"

export class StoreSetupError extends Error {
  readonly code = STORE_SETUP_ERROR
  readonly status = 503
  constructor(message: string) {
    super(message)
    this.name = "StoreSetupError"
  }
}

/** Par le code plutôt que par `instanceof` : en `next dev`, deux copies du module peuvent coexister. */
export function isStoreSetupError(err: unknown): err is StoreSetupError {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === STORE_SETUP_ERROR
}

/** Table absente (code Postgres 42P01) : la migration correspondante n'a pas été appliquée. */
export function missingTable(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "42P01"
}

export const SETTINGS_MISSING_MESSAGE =
  "Base de données à mettre à jour : la table brain_settings est absente. Appliquez les migrations (npm run db:migrate) ou définissez BRAIN_SESSION_SECRET."

export const JOIN_MISSING_MESSAGE =
  "Base de données à mettre à jour : la table join_requests est absente. Appliquez les migrations (npm run db:migrate)."
