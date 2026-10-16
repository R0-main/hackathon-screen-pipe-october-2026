import path from "node:path"
import type { BrainStore } from "./types"
import { FileStore } from "./file"
import { PostgresStore } from "./postgres"

export type { BrainStore } from "./types"

const g = globalThis as unknown as { __brainStore?: BrainStore }

/** Postgres si DATABASE_URL est défini, sinon fichier local (BRAIN_DATA_DIR, par défaut .brain/). */
export function getStore(): BrainStore {
  if (!g.__brainStore) {
    const url = process.env.DATABASE_URL
    g.__brainStore = url ? new PostgresStore(url) : new FileStore(path.resolve(process.env.BRAIN_DATA_DIR ?? ".brain"))
  }
  return g.__brainStore
}
