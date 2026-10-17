import { viewerFromRequest, type Viewer } from "@/lib/auth"
import { createEventPoller, streamStartId, visibleEvent } from "@/lib/brain"
import { getStore, runInOrg } from "@/lib/store"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** Closest re-read (after an event, or without notification). */
const BASE_POLL_MS = Number(process.env.BRAIN_STREAM_POLL_MS) || 800
/** Safety re-read at rest: spaced out when storage notifies, tighter otherwise. */
const IDLE_POLL_NOTIFY_MS = Number(process.env.BRAIN_STREAM_IDLE_POLL_MS) || 15_000
const IDLE_POLL_PLAIN_MS = 4_000
// The browser's EventSource reconnects on its own (Last-Event-ID): on Vercel, we stay under a function's max duration.
const MAX_MS = Number(process.env.BRAIN_STREAM_MAX_MS) || (process.env.VERCEL ? 55_000 : 290_000)
export const maxDuration = 60
const ACCESS_REFRESH_MS = 5_000 // permissions re-read regularly: a removed zone stops being visible without waiting for the reconnection
const PING_MS = 15_000
/** Groups notifications arriving in bursts (one per inserted event) into a single re-read. */
const WAKE_DEBOUNCE_MS = 30

/** Event id provided by the client (Last-Event-ID on reconnection, otherwise ?after=). */
function parseId(raw: string | null): number | null {
  return raw !== null && /^\d{1,15}$/.test(raw.trim()) ? Number(raw.trim()) : null
}

/**
 * Real-time stream of agent events (Server-Sent Events).
 * Storage notifies as soon as an event is inserted (local emitter for the file store, LISTEN/NOTIFY in Postgres): the
 * re-read of agent_events then happens right away. Between two notifications, a spaced safety re-read
 * (backoff) covers a lost notification, another instance without LISTEN, or a pooler that does not forward it.
 * `?after=<id>`: the dashboard passes the largest id of its initial state, so nothing is missed between the server
 * render and the connection.
 */
export async function GET(req: Request) {
  const initial = await viewerFromRequest(req)
  if (!initial) return new Response("Not authenticated", { status: 401 })
  // The event reader and its timers inherit the context: they only read the account's company.
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
      // Storage notification: immediate re-read (or as soon as the current one ends).
      unsubscribe = store.onEvents(orgId, () => {
        if (closed) return
        clearTimeout(debounce)
        debounce = setTimeout(() => {
          pending = true
          wake?.()
        }, WAKE_DEBOUNCE_MS)
      })
      // A lone "id:" sets the browser's Last-Event-ID: a reconnection resumes here, even without an event received.
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
            // Backoff: fast while something is happening, spaced out at rest (the notification wakes up earlier).
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
