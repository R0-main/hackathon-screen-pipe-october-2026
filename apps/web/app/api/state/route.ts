import { getState } from "@/lib/brain"
import { json, withViewer } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export const GET = withViewer(async (_req, viewer) => json(await getState(viewer)))
