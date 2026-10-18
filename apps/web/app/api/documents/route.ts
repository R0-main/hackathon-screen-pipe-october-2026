import { DocumentUploadSchema } from "@brain/core"
import { addDocument, documentErrorResponse, listDocumentsFor, searchDocumentsFor } from "@/lib/documents"
import { json, parseBody, withViewer } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** Readable documents, most recent first; `?zone=` one zone, `?q=` a search on their name and text. */
export const GET = withViewer(async (req, viewer) => {
  const url = new URL(req.url)
  const q = url.searchParams.get("q")?.trim()
  const zone = url.searchParams.get("zone")?.trim() || undefined
  if (q) {
    const zones = zone ? viewer.access.readable.filter((z) => z === zone) : viewer.access.readable
    return json({ documents: await searchDocumentsFor(viewer, q.slice(0, 500), zones, 20) })
  }
  return json({ documents: await listDocumentsFor(viewer, { zone }) })
})

/**
 * A document enters the brain (sync, `brain docs add`, dashboard): base64 content, 3 MB at most. 201 if it is new,
 * 200 if the brain already had the same file (it is then only linked to `item_ids`); 422 with the reasons if it is
 * refused (secret, personal data, no readable text for an automatic sending).
 */
export const POST = withViewer(async (req, viewer) => {
  const body = await parseBody(req, DocumentUploadSchema)
  if ("response" in body) return body.response
  try {
    const result = await addDocument(viewer, body.data)
    return json(result, result.created ? 201 : 200)
  } catch (err) {
    return documentErrorResponse(err)
  }
})
