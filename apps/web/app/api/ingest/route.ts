import { IngestPayloadSchema, AGENTS } from "@brain/core"
import { z } from "zod"
import { ingestItems } from "@/lib/brain"
import { json, parseBody, withViewer } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const Schema = IngestPayloadSchema.extend({ agent: z.enum(AGENTS).optional() })

/**
 * brain-sync envoie ici les connaissances distillées sur le poste. Toute zone existante est acceptée
 * (seule la lecture est restreinte). Réponse : `{inserted, skipped, ids, zones}` ; `skipped` compte les items
 * déjà reçus (même auteur, même zone, même titre sur 30 jours), ce qui rend un renvoi sans danger.
 */
export const POST = withViewer(async (req, viewer) => {
  const body = await parseBody(req, Schema)
  if ("response" in body) return body.response
  const result = await ingestItems(viewer, body.data.items, body.data.agent ?? "brain-sync")
  return json(result, 201)
})
