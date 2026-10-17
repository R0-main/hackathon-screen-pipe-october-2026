// Storage not ready (migration not applied…): a configuration error, not a bug.
// Routes answer 503 with its message; a dashboard session that cannot be verified is refused (401).

export const STORE_SETUP_ERROR = "BRAIN_STORE_SETUP"

export class StoreSetupError extends Error {
  readonly code = STORE_SETUP_ERROR
  readonly status = 503
  constructor(message: string) {
    super(message)
    this.name = "StoreSetupError"
  }
}

/** By code rather than by `instanceof`: in `next dev`, two copies of the module may coexist. */
export function isStoreSetupError(err: unknown): err is StoreSetupError {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === STORE_SETUP_ERROR
}

/** Missing table (Postgres code 42P01): the corresponding migration was not applied. */
export function missingTable(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "42P01"
}

export const SETTINGS_MISSING_MESSAGE =
  "The database needs an update: the brain_settings table is missing. Apply the migrations (npm run db:migrate) or set BRAIN_SESSION_SECRET."

export const JOIN_MISSING_MESSAGE =
  "The database needs an update: the join_requests table is missing. Apply the migrations (npm run db:migrate)."
