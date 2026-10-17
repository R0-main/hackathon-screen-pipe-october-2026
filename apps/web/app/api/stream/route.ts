import { viewerFromRequest, type Viewer } from "@/lib/auth"
import { createEventPoller, streamStartId, visibleEvent } from "@/lib/brain"
import { getStore, runInOrg } from "@/lib/store"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** Relecture la plus rapprochée (après un événement, ou sans notification). */
const BASE_POLL_MS = Number(process.env.BRAIN_STREAM_POLL_MS) || 800
/** Relecture de sécurité au repos : espacée quand le stockage notifie, plus serrée sinon. */
const IDLE_POLL_NOTIFY_MS = Number(process.env.BRAIN_STREAM_IDLE_POLL_MS) || 15_000
const IDLE_POLL_PLAIN_MS = 4_000
// L'EventSource du navigateur se reconnecte tout seul (Last-Event-ID) : sur Vercel, on reste sous la durée max d'une fonction.
const MAX_MS = Number(process.env.BRAIN_STREAM_MAX_MS) || (process.env.VERCEL ? 55_000 : 290_000)
export const maxDuration = 60
const ACCESS_REFRESH_MS = 5_000 // droits relus régulièrement : une zone retirée cesse d'être visible sans attendre la reconnexion
const PING_MS = 15_000
/** Regroupe les notifications qui arrivent en rafale (une par événement inséré) en une seule relecture. */
const WAKE_DEBOUNCE_MS = 30

/** Identifiant d'événement fourni par le client (Last-Event-ID à la reconnexion, sinon ?after=). */
function parseId(raw: string | null): number | null {
  return raw !== null && /^\d{1,15}$/.test(raw.trim()) ? Number(raw.trim()) : null
}

/**
 * Flux temps réel des événements d'agents (Server-Sent Events).
 * Le stockage prévient dès qu'un événement est inséré (émetteur local en fichier, LISTEN/NOTIFY en Postgres) : la
 * relecture de agent_events se fait alors tout de suite. Entre deux notifications, une relecture de sécurité espacée
 * (backoff) couvre une notification perdue, une autre instance sans LISTEN, ou un pooler qui ne le transmet pas.
 * `?after=<id>` : le dashboard passe le plus grand identifiant de son état initial, pour ne rien manquer entre le rendu
 * serveur et la connexion.
 */
export async function GET(req: Request) {
  const initial = await viewerFromRequest(req)
  if (!initial) return new Response("Non authentifié", { status: 401 })
  // Le lecteur d'événements et ses minuteries héritent du contexte : ils ne lisent que l'entreprise du compte.
  return runInOrg(initial.real.org_id, () => stream(req, initial))
}

async function stream(req: Request, initial: Viewer) {
  let viewer: Viewer = initial
  const orgId = initial.real.org_id
  const url = new URL(req.url)
  const store = getStore()
  const poller = createEventPoller(await streamStartId(parseId(req.headers.get("last-event-id")) ?? parseId(url.searchParams.get("after"))))
  const idleMax = store.eventNotifyMode() === "poll" ? IDLE_POLL_PLAIN_MS : IDLE_POLL_NOTIFY_MS

  const encoder = new TextEncoder()
  let closed = false
  let wake: (() => void) | null = null
  let pending = false
  let unsubscribe: () => void = () => {}

  const body = new ReadableStream({
    start(controller) {
      const started = Date.now()
      let lastPing = started
      let lastAccess = started
      let interval = BASE_POLL_MS
      let debounce: ReturnType<typeof setTimeout> | undefined
      const send = (chunk: string) => {
        if (!closed) controller.enqueue(encoder.encode(chunk))
      }
      const close = () => {
        if (closed) return
        closed = true
        unsubscribe()
        clearTimeout(debounce)
        wake?.()
        try {
          controller.close()
        } catch {}
      }
      // Notification du stockage : relecture immédiate (ou dès la fin de celle en cours).
      unsubscribe = store.onEvents(orgId, () => {
        if (closed) return
        clearTimeout(debounce)
        debounce = setTimeout(() => {
          pending = true
          wake?.()
        }, WAKE_DEBOUNCE_MS)
      })
      // Un « id: » seul fixe le Last-Event-ID du navigateur : une reconnexion reprend ici, même sans événement reçu.
      send(`retry: 1500\nid: ${poller.cursor}\n\n`)

      const sleep = (ms: number) =>
        new Promise<void>((resolve) => {
          if (pending) return resolve()
          const t = setTimeout(() => {
            wake = null
            resolve()
          }, ms)
          wake = () => {
            clearTimeout(t)
            wake = null
            resolve()
          }
        })

      ;(async () => {
        while (!closed) {
          await sleep(interval)
          if (closed) break
          const notified = pending
          pending = false
          try {
            const now = Date.now()
            if (now - lastAccess > ACCESS_REFRESH_MS) {
              lastAccess = now
              const fresh = await viewerFromRequest(req)
              if (!fresh) return close()
              viewer = fresh
            }
            const events = await poller.poll()
            for (const e of events) send(`id: ${e.id}\nevent: agent\ndata: ${JSON.stringify(visibleEvent(viewer, e))}\n\n`)
            // Backoff : rapide tant qu'il se passe quelque chose, espacé au repos (la notification réveille avant).
            interval = events.length || notified ? BASE_POLL_MS : Math.min(interval * 2, idleMax)
            if (now - lastPing > PING_MS) {
              lastPing = now
              send(": ping\n\n")
            }
            if (now - started > MAX_MS) {
              send(`id: ${poller.cursor}\n\n`)
              close()
            }
          } catch (err) {
            console.error("[stream]", err)
            interval = Math.min(Math.max(interval, BASE_POLL_MS) * 2, idleMax)
          }
        }
      })()
      req.signal.addEventListener("abort", close)
    },
    cancel() {
      closed = true
      unsubscribe()
      wake?.()
    },
  })
  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "X-Brain-Stream": store.eventNotifyMode(),
    },
  })
}
