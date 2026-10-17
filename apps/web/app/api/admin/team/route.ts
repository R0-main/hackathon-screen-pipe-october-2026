import { getStore } from "@/lib/store"
import { json, withViewer } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * L'équipe et l'état de chaque poste : `last_at` est le dernier signe de son agent (le premier est le `hello` lancé à
 * la fin de l'installation), null tant que le poste n'est pas branché. Le parcours /creer le relit pour montrer qui
 * s'est connecté.
 */
export const GET = withViewer(
  async () => {
    const store = getStore()
    const [profiles, access] = await Promise.all([store.listProfiles(), store.listZoneAccess()])
    const users = await Promise.all(
      profiles.map(async (p) => {
        const [last] = await store.listEvents({ userId: p.id, limit: 1 })
        return {
          id: p.id,
          name: p.name,
          title: p.title,
          role: p.role,
          zones: access.filter((a) => a.user_id === p.id).map((a) => a.zone_id),
          last_at: last?.at ?? null,
        }
      }),
    )
    return json({ users })
  },
  { admin: true },
)
