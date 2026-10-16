import { z } from "zod"
import { getStore } from "@/lib/store"
import { draftOnboarding, ONBOARDING_QUESTIONS } from "@/lib/onboarding"
import { json, parseBody, withViewer } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 120

export const GET = withViewer(async () => json({ questions: ONBOARDING_QUESTIONS }), { admin: true })

const Schema = z.object({ answers: z.record(z.string(), z.string().max(6000)) })

/** Interview + liens → brouillon de cerveau (zones + premières connaissances), à valider avant application. */
export const POST = withViewer(
  async (req) => {
    const body = await parseBody(req, Schema)
    if ("response" in body) return body.response
    const draft = await draftOnboarding(body.data.answers, await getStore().listZones())
    return json(draft)
  },
  { admin: true },
)
