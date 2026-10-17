import { getStore } from "@/lib/store"
import { ingestItems, refreshStatus } from "@/lib/brain"
import { getAccess } from "@/lib/access"
import { zonesFromDraft } from "@/lib/onboarding"
import { clearAgentDraft, OnboardingDraftSchema } from "@/lib/onboarding-agent"
import { json, parseBody, withViewer } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 120

/**
 * Applies the validated draft (interview, or proposal from Claude Code / Codex): company name, zones,
 * first knowledge, initial state. The pending agent proposal is then discarded.
 */
export const POST = withViewer(
  async (req, viewer) => {
    const body = await parseBody(req, OnboardingDraftSchema)
    if ("response" in body) return body.response
    const store = getStore()
    await store.updateOrg({ name: body.data.company_name, description: body.data.description })
    for (const zone of zonesFromDraft(body.data, await store.listZones())) await store.upsertZone(zone)
    const fresh = { ...viewer, access: await getAccess(viewer.real) }
    const result = body.data.items.length ? await ingestItems(fresh, body.data.items, "job") : { inserted: 0 }
    const status = await refreshStatus(fresh)
    await clearAgentDraft(store)
    return json({ ok: true, inserted: result.inserted, status })
  },
  { admin: true },
)
