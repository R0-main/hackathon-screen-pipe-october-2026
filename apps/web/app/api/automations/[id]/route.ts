import { z } from "zod"
import { getStore } from "@/lib/store"
import { error, json, parseBody, withViewer } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ id: string }> }
const Schema = z.object({ status: z.enum(["proposed", "accepted", "dismissed"]) })

export const PATCH = withViewer<Ctx>(
  async (req, _viewer, { params }) => {
    const body = await parseBody(req, Schema)
    if ("response" in body) return body.response
    const updated = await getStore().updateAutomation((await params).id, body.data)
    return updated ? json(updated) : error(404, "Suggestion introuvable.")
  },
  { admin: true },
)
