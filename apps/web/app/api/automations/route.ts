import { z } from "zod"
import { redactText, truncate } from "@brain/core"
import { getStore } from "@/lib/store"
import { json, parseBody, withViewer } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export const GET = withViewer(async (_req, viewer) => {
  const all = await getStore().listAutomations()
  return json({ automations: all.filter((a) => viewer.access.isAdmin || a.user_id === viewer.profile.id) })
})

const WorkflowSchema = z.object({
  workflows: z
    .array(
      z.object({
        id: z.string().max(200),
        title: z.string().min(1).max(200),
        description: z.string().max(1000).default(""),
        schedule: z.string().max(120).optional(),
        occurrences: z.number().int().min(0).default(0),
        days: z.number().int().min(0).default(0),
        zone: z.string().max(64).optional(),
        minutes_saved_per_week: z.number().int().min(0).max(5000).default(0),
      }),
    )
    .max(50),
})

/**
 * brain-sync remonte ici les workflows répétitifs détectés en local par Screenpipe. Titre, description et horaire sont
 * re-masqués côté serveur (secrets, emails, numéros…), même si le poste l'a déjà fait (anciens clients).
 */
export const POST = withViewer(async (req, viewer) => {
  const body = await parseBody(req, WorkflowSchema)
  if ("response" in body) return body.response
  const store = getStore()
  const known = new Set((await store.listZones()).map((z) => z.id))
  const clean = (s: string, max: number) => truncate(redactText(s), max)
  const saved = await store.upsertAutomations(
    body.data.workflows.map((w) => ({
      key: `screenpipe:${viewer.real.id}:${w.id}`,
      user_id: viewer.real.id,
      zone: w.zone && known.has(w.zone) ? w.zone : undefined,
      title: clean(w.title, 200),
      description: w.description ? clean(w.description, 1000) : `Workflow répétitif détecté par Screenpipe sur le poste de ${viewer.real.name}.`,
      schedule: w.schedule ? clean(w.schedule, 120) : undefined,
      evidence: { occurrences: w.occurrences, days: w.days },
      minutes_saved_per_week: w.minutes_saved_per_week,
      source: "screenpipe" as const,
    })),
  )
  return json({ saved: saved.length }, 201)
})
