import { z } from "zod"
import { catchUpKeywords } from "@/lib/brain"
import { catchUpIndex, settingsOverview } from "@/lib/settings"
import { DEMO_SETTINGS_READ_ONLY } from "@/lib/demo-mode"
import { error, json, parseBody, withViewer } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
// One catch-up works about 20 seconds, then the page asks again if some is left.
export const maxDuration = 60

const Schema = z.object({ what: z.enum(["index", "keywords"]) })

/** Admins: vectors or keywords for the knowledge that has none, for about 20 seconds; then the page's data. */
export const POST = withViewer(
  async (req, viewer) => {
    const body = await parseBody(req, Schema)
    if ("response" in body) return body.response
    if (body.data.what === "index") {
      const r = await catchUpIndex()
      if (!r) return error(409, "Semantic search is off for this company, or the deployment has no embeddings provider.")
    } else {
      const r = await catchUpKeywords()
      if (!r) return error(409, "The server needs Claude to write keywords: add the company's Claude key first.")
    }
    return json(await settingsOverview(viewer))
  },
  { admin: true, demoReadOnly: DEMO_SETTINGS_READ_ONLY },
)
