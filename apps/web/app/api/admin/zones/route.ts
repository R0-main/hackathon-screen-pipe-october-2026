import { z } from "zod"
import { isCoreZone, normalizeProject, slugify, zoneColor, type Zone } from "@brain/core"
import { getStore } from "@/lib/store"
import { error, json, parseBody, withViewer } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const Schema = z.object({
  id: z.string().max(32).optional(),
  name: z.string().min(1).max(40),
  description: z.string().max(300).optional(),
  keywords: z.array(z.string().max(40)).max(80).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  /** Folder names or git repositories whose sessions always land in the zone (projectZone). */
  projects: z.array(z.string().max(200)).max(40).optional(),
})

/**
 * Without `id`: creates a zone (409 if its id, derived from the name, already exists: an existing zone is never overwritten).
 * With `id`: updates that zone; description, keywords and projects absent from the body are kept.
 */
export const POST = withViewer(
  async (req) => {
    const body = await parseBody(req, Schema)
    if ("response" in body) return body.response
    const store = getStore()
    const zones = await store.listZones()
    const id = body.data.id ?? slugify(body.data.name)
    const prev = zones.find((z) => z.id === id)
    if (prev && body.data.id === undefined)
      return error(409, `The zone "${prev.name}" already exists (id "${id}"): choose another name, or edit the existing zone.`)
    const zone = await store.upsertZone({
      id,
      name: body.data.name,
      description: body.data.description ?? prev?.description ?? "",
      keywords: (body.data.keywords ?? prev?.keywords ?? []).map((k) => k.toLowerCase()),
      color: body.data.color ?? prev?.color ?? zoneColor(zones.length),
      position: prev?.position ?? zones.length,
      ...projectsOf(body.data.projects, prev),
    })
    return json(zone, prev ? 200 : 201)
  },
  { admin: true },
)

/**
 * `?id=`: deletes an empty zone (a project zone emptied by `brain rezone`, a zone created by mistake), with its access
 * rights. Never the core, nor the company's last team zone; 409 while knowledge, tasks, documents or skills are filed in it.
 */
export const DELETE = withViewer(
  async (req) => {
    const id = new URL(req.url).searchParams.get("id") ?? ""
    if (!id) return error(400, "Missing zone id (?id=).")
    if (isCoreZone(id)) return error(400, "The core cannot be deleted: every member reads it.")
    const store = getStore()
    const zones = await store.listZones()
    const zone = zones.find((z) => z.id === id)
    if (!zone) return error(404, `Unknown zone "${id}".`)
    if (zones.filter((z) => !isCoreZone(z.id)).length <= 1) return error(400, "The brain keeps at least one zone besides the core.")
    const usage = await store.zoneUsage(id)
    const left = Object.entries(usage).filter(([, n]) => n > 0)
    if (left.length)
      return error(
        409,
        `The zone "${zone.name}" is not empty (${left.map(([k, n]) => `${n} ${n === 1 ? k.replace(/s$/, "") : k}`).join(", ")}): move them first (brain rezone).`,
        usage,
      )
    await store.deleteZone(id)
    return json({ deleted: id })
  },
  { admin: true },
)

/** The projects sent, normalized (owner/repo or folder name) and without duplicates; otherwise those of the zone. */
function projectsOf(sent: string[] | undefined, prev: Zone | undefined): Pick<Zone, "projects"> {
  if (sent === undefined) return prev?.projects ? { projects: prev.projects } : {}
  return { projects: [...new Set(sent.map(normalizeProject).filter(Boolean))] }
}
