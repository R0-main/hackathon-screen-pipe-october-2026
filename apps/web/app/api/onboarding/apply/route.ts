import { z } from "zod"
import { KnowledgeItemInputSchema } from "@brain/core"
import { getStore } from "@/lib/store"
import { ingestItems, refreshStatus } from "@/lib/brain"
import { getAccess } from "@/lib/access"
import { zonesFromDraft } from "@/lib/onboarding"
import { json, parseBody, withViewer } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 120

const Schema = z.object({
  company_name: z.string().min(1).max(120),
  description: z.string().max(2000).default(""),
  zones: z.array(z.object({ id: z.string().min(1).max(32), name: z.string().min(1).max(40), description: z.string().max(300), keywords: z.array(z.string().max(40)).max(80) })).min(1).max(12),
  items: z.array(KnowledgeItemInputSchema).max(60),
})

/** Applique le brouillon validé : nom de l'entreprise, zones, premières connaissances, état initial. */
export const POST = withViewer(
  async (req, viewer) => {
    const body = await parseBody(req, Schema)
    if ("response" in body) return body.response
    const store = getStore()
    await store.updateOrg({ name: body.data.company_name, description: body.data.description })
    for (const zone of zonesFromDraft(body.data, await store.listZones())) await store.upsertZone(zone)
    const fresh = { ...viewer, access: await getAccess(viewer.real) }
    const result = body.data.items.length ? await ingestItems(fresh, body.data.items, "job") : { inserted: 0 }
    const status = await refreshStatus(fresh)
    return json({ ok: true, inserted: result.inserted, status })
  },
  { admin: true },
)
