import { viewerFromRequest, type Viewer } from "@/lib/auth"
import { createEventPoller, streamStartId, visibleEvent } from "@/lib/brain"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const POLL_MS = 800
const MAX_MS = 290_000 // l'EventSource du navigateur se reconnecte tout seul (Last-Event-ID)
const ACCESS_REFRESH_MS = 5_000 // droits relus régulièrement : une zone retirée cesse d'être visible sans attendre la reconnexion

/** Identifiant d'événement fourni par le client (Last-Event-ID à la reconnexion, sinon ?after=). */
function parseId(raw: string | null): number | null {
  return raw !== null && /^\d{1,15}$/.test(raw.trim()) ? Number(raw.trim()) : null
}

/**
 * Flux temps réel des événements d'agents (Server-Sent Events).
 * Lecture périodique de agent_events : fonctionne aussi bien en fichier qu'en Postgres, sur une ou plusieurs instances.
 * `?after=<id>` : le dashboard passe le plus grand identifiant de son état initial, pour ne rien manquer entre le rendu
 * serveur et la connexion.
 */
export async function GET(req: Request) {
  const initial = await viewerFromRequest(req)
  if (!initial) return new Response("Non authentifié", { status: 401 })
  let viewer: Viewer = initial
  const url = new URL(req.url)
  const poller = createEventPoller(await streamStartId(parseId(req.headers.get("last-event-id")) ?? parseId(url.searchParams.get("after"))))

  const encoder = new TextEncoder()
  let timer: ReturnType<typeof setInterval> | undefined
  let closed = false
  const stream = new ReadableStream({
    start(controller) {
      const started = Date.now()
      let lastPing = Date.now()
      let lastAccess = Date.now()
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
      // Un « id: » seul fixe le Last-Event-ID du navigateur : une reconnexion reprend ici, même sans événement reçu.
      send(`retry: 1500\nid: ${poller.cursor}\n\n`)
      timer = setInterval(async () => {
        if (busy || closed) return
        busy = true
        try {
          const now = Date.now()
          if (now - lastAccess > ACCESS_REFRESH_MS) {
            lastAccess = now
            const fresh = await viewerFromRequest(req)
            if (!fresh) return close()
            viewer = fresh
          }
          for (const e of await poller.poll()) send(`id: ${e.id}\nevent: agent\ndata: ${JSON.stringify(visibleEvent(viewer, e))}\n\n`)
          if (now - lastPing > 15_000) {
            lastPing = now
            send(": ping\n\n")
          }
          if (now - started > MAX_MS) {
            send(`id: ${poller.cursor}\n\n`)
            close()
          }
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
