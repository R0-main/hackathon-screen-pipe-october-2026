import { getStore } from "@/lib/store"
import { json, withViewer } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * The team and the state of each workstation: `last_at` is the last sign from its agent (the first one is the `hello`
 * sent at the end of the install), null until the workstation is connected. The /create flow re-reads it to show who
 * has connected.
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
