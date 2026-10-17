import path from "node:path"
import { AsyncLocalStorage } from "node:async_hooks"
import type { BrainStore } from "./types"
import { FileStore } from "./file"
import { PostgresStore } from "./postgres"

export type { BrainStore } from "./types"
export { StoreSetupError, isStoreSetupError } from "./errors"

// Bump when the stores' interface or behavior changes: in `next dev`, the singleton survives
// hot reload and would otherwise keep an instance of the old class (missing methods).
const STORE_VERSION = 7

const g = globalThis as unknown as { __brainStore?: BrainStore; __brainStoreVersion?: number; __brainOrgContext?: AsyncLocalStorage<string> }

// Company of the current request: set by withViewer (API routes) and runInOrg (pages), from the signed-in account.
// Shared through globalThis: in `next dev`, two copies of this module may coexist.
const orgContext = (g.__brainOrgContext ??= new AsyncLocalStorage<string>())

/** Root store: the base organization (the demo, the deployed brain), and the directory of created companies. */
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

/** The store of a given company (an account's: `profile.org_id`). */
export function storeForOrg(orgId: string): BrainStore {
  return getRootStore().forOrg(orgId)
}

/**
 * The store of the current request's company; outside an authenticated request (scripts, demo, sign-in), the
 * base's. Postgres if DATABASE_URL is set, otherwise a local file (BRAIN_DATA_DIR, .brain/ by default).
 */
export function getStore(): BrainStore {
  const orgId = orgContext.getStore()
  return orgId ? storeForOrg(orgId) : getRootStore()
}

/** Runs `fn` in the context of a company: every `getStore()` it triggers targets that company. */
export function runInOrg<T>(orgId: string, fn: () => T): T {
  return orgContext.run(orgId, fn)
}
