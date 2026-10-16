import { getStore } from "@/lib/store"
import { viewerFromRequest } from "@/lib/auth"
import { visibleEvent } from "@/lib/brain"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const POLL_MS = 800
const MAX_MS = 290_000 // l'EventSource du navigateur se reconnecte tout seul (Last-Event-ID)

/**
 * Flux temps réel des événements d'agents (Server-Sent Events).
 * Lecture périodique de agent_events : fonctionne aussi bien en fichier qu'en Postgres, sur une ou plusieurs instances.
 */
export async function GET(req: Request) {
  const viewer = await viewerFromRequest(req)
  if (!viewer) return new Response("Non authentifié", { status: 401 })
  const store = getStore()
  const url = new URL(req.url)
  let lastId = Number(req.headers.get("last-event-id") ?? url.searchParams.get("after") ?? NaN)
  if (!Number.isFinite(lastId)) lastId = (await store.listEvents({ limit: 1 }))[0]?.id ?? 0

  const encoder = new TextEncoder()
  let timer: ReturnType<typeof setInterval> | undefined
  let closed = false
  const stream = new ReadableStream({
    start(controller) {
      const started = Date.now()
      let lastPing = Date.now()
      let busy = false
      const send = (chunk: string) => {
        if (!closed) controller.enqueue(encoder.encode(chunk))
      }
      const close = () => {
        if (closed) return
        closed = true
        clearInterval(timer)
        try {
          controller.close()
        } catch {}
      }
      send("retry: 1500\n\n")
      timer = setInterval(async () => {
        if (busy || closed) return
        busy = true
        try {
          const events = await store.listEvents({ afterId: lastId, limit: 200 })
          for (const e of events) {
            lastId = e.id
            send(`id: ${e.id}\nevent: agent\ndata: ${JSON.stringify(visibleEvent(viewer, e))}\n\n`)
          }
          if (Date.now() - lastPing > 15_000) {
            lastPing = Date.now()
            send(": ping\n\n")
          }
          if (Date.now() - started > MAX_MS) close()
        } catch (err) {
          console.error("[stream]", err)
        } finally {
          busy = false
        }
      }, POLL_MS)
      req.signal.addEventListener("abort", close)
    },
    cancel() {
      closed = true
      clearInterval(timer)
    },
  })
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  })
}
