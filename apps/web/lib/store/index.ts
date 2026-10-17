import path from "node:path"
import { AsyncLocalStorage } from "node:async_hooks"
import type { BrainStore } from "./types"
import { FileStore } from "./file"
import { PostgresStore } from "./postgres"

export type { BrainStore } from "./types"
export { StoreSetupError, isStoreSetupError } from "./errors"

// À incrémenter quand l'interface ou le comportement des stockages change : en `next dev`, le singleton survit au
// rechargement à chaud et garderait sinon une instance de l'ancienne classe (méthodes manquantes).
const STORE_VERSION = 6

const g = globalThis as unknown as { __brainStore?: BrainStore; __brainStoreVersion?: number; __brainOrgContext?: AsyncLocalStorage<string> }

// Entreprise de la requête en cours : posée par withViewer (routes API) et runInOrg (pages), d'après le compte connecté.
// Partagée par globalThis : en `next dev`, deux copies de ce module peuvent coexister.
const orgContext = (g.__brainOrgContext ??= new AsyncLocalStorage<string>())

/** Stockage racine : l'organisation de la base (la démo, le cerveau déployé), et l'annuaire des entreprises créées. */
export function getRootStore(): BrainStore {
  if (!g.__brainStore || g.__brainStoreVersion !== STORE_VERSION) {
    const previous = g.__brainStore as (BrainStore & { end?: () => Promise<void> }) | undefined
    if (previous && typeof previous.end === "function") previous.end().catch(() => {})
    const url = process.env.DATABASE_URL
    g.__brainStore = url ? new PostgresStore(url) : new FileStore(path.resolve(process.env.BRAIN_DATA_DIR ?? ".brain"))
    g.__brainStoreVersion = STORE_VERSION
  }
  return g.__brainStore
}

/** Le stockage d'une entreprise donnée (celle d'un compte : `profile.org_id`). */
export function storeForOrg(orgId: string): BrainStore {
  return getRootStore().forOrg(orgId)
}

/**
 * Le stockage de l'entreprise de la requête en cours ; hors requête authentifiée (scripts, démo, connexion), celui de
 * la base. Postgres si DATABASE_URL est défini, sinon fichier local (BRAIN_DATA_DIR, par défaut .brain/).
 */
export function getStore(): BrainStore {
  const orgId = orgContext.getStore()
  return orgId ? storeForOrg(orgId) : getRootStore()
}

/** Exécute `fn` dans le contexte d'une entreprise : tous les `getStore()` qu'elle déclenche visent cette entreprise. */
export function runInOrg<T>(orgId: string, fn: () => T): T {
  return orgContext.run(orgId, fn)
}
