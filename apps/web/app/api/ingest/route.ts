import { IngestPayloadSchema, AGENTS } from "@brain/core"
import { z } from "zod"
import { ingestItems } from "@/lib/brain"
import { json, parseBody, withViewer } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const Schema = IngestPayloadSchema.extend({ agent: z.enum(AGENTS).optional() })

/**
 * brain-sync sends here the knowledge distilled on the workstation. Any existing zone is accepted
 * (only reading is restricted). Response: `{inserted, skipped, ids, zones}`; `skipped` counts the items
 * already received (same author, same zone, same title over 30 days), which makes a resend harmless.
 */
export const POST = withViewer(async (req, viewer) => {
  const body = await parseBody(req, Schema)
  if ("response" in body) return body.response
  const result = await ingestItems(viewer, body.data.items, body.data.agent ?? "brain-sync")
  return json(result, 201)
})
