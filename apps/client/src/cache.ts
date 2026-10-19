// Local cache (who I am + zones with keywords): lets the hooks classify a prompt without a network call.

import { DEFAULT_ZONES, type ZoneHint } from "@brain/core"
import type { ApiZone, BrainApi, WhoAmI } from "./api"
import { loadCache, saveCache, type Cache, type CachedZone } from "./config"

export function cacheFrom(who: WhoAmI | null, zones: ApiZone[] | null, prev: Cache | null): Cache {
  return {
    updated_at: new Date().toISOString(),
    whoami: who
      ? {
          name: who.profile.name,
          org: who.org.name,
          title: who.profile.title,
          role: who.profile.role,
          readable: who.access.readable,
          writable: who.access.writable,
        }
      : prev?.whoami,
    zones: zones
      ? zones.map((z): CachedZone => ({ id: z.id, name: z.name, description: z.description, keywords: z.keywords ?? [], ...(z.projects?.length ? { projects: z.projects } : {}), readable: Boolean(z.readable) }))
      : prev?.zones,
  }
}

/** Refreshes whoami + zones; keeps the old cache for whatever fails. */
export async function refreshCache(api: BrainApi): Promise<{ cache: Cache; errors: string[] }> {
  const [who, zones] = await Promise.allSettled([api.whoami(), api.zones()])
  const errors = [who, zones].filter((r): r is PromiseRejectedResult => r.status === "rejected").map((r) => (r.reason as Error).message)
  const prev = loadCache()
  const cache = cacheFrom(who.status === "fulfilled" ? who.value : null, zones.status === "fulfilled" ? zones.value : null, prev)
  if (who.status === "fulfilled" || zones.status === "fulfilled") saveCache(cache)
  return { cache, errors }
}

export function zoneHints(cache: Cache | null): ZoneHint[] {
  return cache?.zones?.length ? cache.zones : DEFAULT_ZONES
}

export function zoneName(cache: Cache | null, id: string): string {
  return cache?.zones?.find((z) => z.id === id)?.name ?? DEFAULT_ZONES.find((z) => z.id === id)?.name ?? id
}

export function firstName(name: string | undefined): string {
  return (name ?? "").trim().split(/\s+/)[0] || "you"
}
