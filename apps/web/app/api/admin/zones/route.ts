import { z } from "zod"
import { slugify, zoneColor } from "@brain/core"
import { getStore } from "@/lib/store"
import { json, parseBody, withViewer } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const Schema = z.object({
  id: z.string().max(32).optional(),
  name: z.string().min(1).max(40),
  description: z.string().max(300).default(""),
  keywords: z.array(z.string().max(40)).max(80).default([]),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
})

/** Crée ou met à jour une zone. */
export const POST = withViewer(
  async (req) => {
    const body = await parseBody(req, Schema)
    if ("response" in body) return body.response
    const store = getStore()
    const zones = await store.listZones()
    const id = body.data.id ?? slugify(body.data.name)
    const prev = zones.find((z) => z.id === id)
    const zone = await store.upsertZone({
      id,
      name: body.data.name,
      description: body.data.description,
      keywords: body.data.keywords.map((k) => k.toLowerCase()),
      color: body.data.color ?? prev?.color ?? zoneColor(zones.length),
      position: prev?.position ?? zones.length,
    })
    return json(zone, prev ? 200 : 201)
  },
  { admin: true },
)
