// Accès par zone : la règle « RLS » appliquée par l'API (équivalent des politiques de supabase/migrations/*_rls.sql).
//
// Lecture : restreinte aux zones de zone_access (les admins lisent tout).
// Écriture : NON restreinte. Tout le monde nourrit le cerveau, dans n'importe quelle zone existante ;
// `zone_access.can_write` (et donc `writable`) est conservé mais réservé, aucune route ne l'applique.
// En contrepartie, l'auteur d'une connaissance la voit et peut la supprimer même s'il ne lit pas sa zone (droit de regard).

import type { AgentEvent, Profile } from "@brain/core"
import { storeForOrg } from "./store"

/** `writable` est informatif (réservé) : l'écriture n'est pas restreinte par zone. */
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
    readable: rows.map((r) => r.zone_id),
    writable: rows.filter((r) => r.can_write).map((r) => r.zone_id),
  }
}

export function canRead(access: Access, zone: string): boolean {
  return access.isAdmin || access.readable.includes(zone)
}

/** Vrai si le spectateur lit toutes les zones données (et qu'il y en a au moins une). */
export function canReadAll(access: Access, zones: string[]): boolean {
  return access.isAdmin || (zones.length > 0 && zones.every((z) => access.readable.includes(z)))
}

/**
 * Contenu d'un événement (résumé, empreinte, session) : visible de son auteur, des admins, ou de qui lit TOUTES ses zones.
 * Un événement sans zone (prompt personnel, recherche sans résultat lisible…) ne montre jamais son contenu aux autres.
 */
export function canSeeEventContent(e: Pick<AgentEvent, "user_id" | "zones">, access: Access, viewerId: string): boolean {
  return access.isAdmin || e.user_id === viewerId || canReadAll(access, e.zones)
}

export type RedactedEvent = AgentEvent & { restricted?: boolean; restricted_reason?: "zone" | "private" }

/**
 * Ce qu'un membre voit d'un événement : la zone s'allume pour tout le monde (l'entreprise est vivante),
 * mais le contenu n'est donné que selon canSeeEventContent.
 * `restricted_reason` : « zone » (une des zones n'est pas lisible) ou « private » (événement sans zone).
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
