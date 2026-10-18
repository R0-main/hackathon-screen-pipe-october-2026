// Per-zone access: the "RLS" rule applied by the API (equivalent of the policies in supabase/migrations/*_rls.sql).
//
// Reading: restricted to the zones in zone_access (admins read everything), plus the core, which everyone reads.
// Writing: NOT restricted. Everyone feeds the brain, in any existing zone;
// `zone_access.can_write` (and hence `writable`) is kept but reserved, no route applies it.
// In return, the author of a piece of knowledge sees it and can delete it even without reading its zone (right of review).

import { CORE_ZONE_ID, type AgentEvent, type Profile } from "@brain/core"
import { storeForOrg } from "./store"

/** `writable` is informational (reserved): writing is not restricted by zone. */
export type Access = { isAdmin: boolean; readable: string[]; writable: string[] }

export async function getAccess(profile: Profile): Promise<Access> {
  const store = storeForOrg(profile.org_id)
  if (profile.role === "admin") {
    const zones = (await store.listZones()).map((z) => z.id)
    return { isAdmin: true, readable: zones, writable: zones }
  }
  const rows = await store.listZoneAccess(profile.id)
  return {
    isAdmin: false,
    readable: [...new Set([CORE_ZONE_ID, ...rows.map((r) => r.zone_id)])],
    writable: rows.filter((r) => r.can_write).map((r) => r.zone_id),
  }
}

export function canRead(access: Access, zone: string): boolean {
  return access.isAdmin || access.readable.includes(zone)
}

/** True if the viewer reads all the given zones (and there is at least one). */
export function canReadAll(access: Access, zones: string[]): boolean {
  return access.isAdmin || (zones.length > 0 && zones.every((z) => access.readable.includes(z)))
}

/**
 * Content of an event (summary, fingerprint, session): visible to its author, admins, or whoever reads ALL its zones.
 * An event without a zone (personal prompt, search with no readable result…) never shows its content to others.
 */
export function canSeeEventContent(e: Pick<AgentEvent, "user_id" | "zones">, access: Access, viewerId: string): boolean {
  return access.isAdmin || e.user_id === viewerId || canReadAll(access, e.zones)
}

export type RedactedEvent = AgentEvent & { restricted?: boolean; restricted_reason?: "zone" | "private" }

/**
 * What a member sees of an event: the zone lights up for everyone (the company is alive),
 * but the content is only given according to canSeeEventContent.
 * `restricted_reason`: "zone" (one of the zones is not readable) or "private" (event without a zone).
 */
export function redactEvent(e: AgentEvent, access: Access, viewerId: string): RedactedEvent {
  if (canSeeEventContent(e, access, viewerId)) return e
  const hadContent = e.summary !== undefined || e.fingerprint !== undefined || e.session_id !== undefined
  const redacted: RedactedEvent = { ...e, summary: undefined, fingerprint: undefined, session_id: undefined }
  if (hadContent) {
    redacted.restricted = true
    redacted.restricted_reason = e.zones.length ? "zone" : "private"
  }
  return redacted
}
