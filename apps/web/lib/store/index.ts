import path from "node:path"
import type { BrainStore } from "./types"
import { FileStore } from "./file"
import { PostgresStore } from "./postgres"

export type { BrainStore } from "./types"

// À incrémenter quand l'interface ou le comportement des stockages change : en `next dev`, le singleton survit au
// rechargement à chaud et garderait sinon une instance de l'ancienne classe (méthodes manquantes).
const STORE_VERSION = 2

const g = globalThis as unknown as { __brainStore?: BrainStore; __brainStoreVersion?: number }

/** Postgres si DATABASE_URL est défini, sinon fichier local (BRAIN_DATA_DIR, par défaut .brain/). */
export function getStore(): BrainStore {
  if (!g.__brainStore || g.__brainStoreVersion !== STORE_VERSION) {
    const previous = g.__brainStore as (BrainStore & { end?: () => Promise<void> }) | undefined
    if (previous && typeof previous.end === "function") previous.end().catch(() => {})
    const url = process.env.DATABASE_URL
    g.__brainStore = url ? new PostgresStore(url) : new FileStore(path.resolve(process.env.BRAIN_DATA_DIR ?? ".brain"))
    g.__brainStoreVersion = STORE_VERSION
  }
  return g.__brainStore
}
