// Accès par zone : la règle « RLS » appliquée par l'API (équivalent des politiques de supabase/migrations/*_rls.sql).

import type { AgentEvent, Profile } from "@brain/core"
import { getStore } from "./store"

export type Access = { isAdmin: boolean; readable: string[]; writable: string[] }

export async function getAccess(profile: Profile): Promise<Access> {
  const store = getStore()
  if (profile.role === "admin") {
    const zones = (await store.listZones()).map((z) => z.id)
    return { isAdmin: true, readable: zones, writable: zones }
  }
  const rows = await store.listZoneAccess(profile.id)
  return {
    isAdmin: false,
    readable: rows.map((r) => r.zone_id),
    writable: rows.filter((r) => r.can_write).map((r) => r.zone_id),
  }
}

export function canRead(access: Access, zone: string): boolean {
  return access.isAdmin || access.readable.includes(zone)
}

/**
 * Ce qu'un membre voit d'un événement : la zone s'allume pour tout le monde (l'entreprise est vivante),
 * mais le résumé n'est visible que si l'on a accès à l'une des zones concernées.
 */
export function redactEvent(e: AgentEvent, access: Access, viewerId: string): AgentEvent & { restricted?: boolean } {
  if (access.isAdmin || e.user_id === viewerId) return e
  if (e.zones.length === 0 || e.zones.some((z) => access.readable.includes(z))) return e
  return { ...e, summary: undefined, fingerprint: undefined, session_id: undefined, restricted: true }
}
