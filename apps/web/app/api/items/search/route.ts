import { searchKnowledgeFor } from "@/lib/brain"
import { error, json, withViewer } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** The knowledge page's search (?q=): the ids of the readable knowledge that answers it, most relevant first. */
export const GET = withViewer(async (req, viewer) => {
  const q = new URL(req.url).searchParams.get("q")?.trim() ?? ""
  if (!q) return json({ q, ids: [] })
  if (q.length > 500) return error(400, "Search too long (500 characters at most).")
  return json({ q, ids: await searchKnowledgeFor(viewer, q) })
})
