import { z } from "zod"
import { slugify, zoneColor } from "@brain/core"
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
})

/**
 * Without `id`: creates a zone (409 if its id, derived from the name, already exists: an existing zone is never overwritten).
 * With `id`: updates that zone; description and keywords absent from the body are kept.
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
    })
    return json(zone, prev ? 200 : 201)
  },
  { admin: true },
)
