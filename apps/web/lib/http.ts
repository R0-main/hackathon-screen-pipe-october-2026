import { NextResponse } from "next/server"
import type { z } from "zod"
import { viewerFromRequest, type Viewer } from "./auth"
import { recordIncident, routeOf } from "./monitoring"
import { isStoreSetupError, runInOrg } from "./store"

export function json(data: unknown, init?: number | ResponseInit) {
  return NextResponse.json(data, typeof init === "number" ? { status: init } : init)
}

export function error(status: number, message: string, details?: unknown) {
  return NextResponse.json({ error: message, ...(details ? { details } : {}) }, { status })
}

type Handler<C> = (req: Request, viewer: Viewer, ctx: C) => Promise<Response>

/** Requires an authenticated user (Bearer token or session), in the context of their company. `admin`: checks the real role. */
export function withViewer<C = unknown>(handler: Handler<C>, opts: { admin?: boolean } = {}) {
  return async (req: Request, ctx: C) => {
    try {
      const viewer = await viewerFromRequest(req)
      if (!viewer) return error(401, "Not authenticated: missing or invalid token.")
      if (opts.admin && viewer.real.role !== "admin") return error(403, "Admins only.")
      // Everything the route does targets the signed-in account's company (getStore()).
      return await runInOrg(viewer.real.org_id, () => handler(req, viewer, ctx))
    } catch (err) {
      return internalError(err, routeOf(req))
    }
  }
}

/**
 * Unexpected route error: 503 with a clear message if storage is not ready (migration…), otherwise 500.
 * `where`: the route, for the Monitoring page (incidents) and the webhook alert.
 */
export function internalError(err: unknown, where = "api"): Response {
  if (isStoreSetupError(err)) {
    console.error("[api]", err.message)
    recordIncident(where, err)
    return error(503, err.message)
  }
  console.error("[api]", err)
  recordIncident(where, err)
  return error(500, "Internal brain error.")
}

export async function parseBody<T extends z.ZodType>(req: Request, schema: T): Promise<{ data: z.infer<T> } | { response: Response }> {
  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return { response: error(400, "Invalid JSON body.") }
  }
  const parsed = schema.safeParse(raw)
  if (!parsed.success) return { response: error(400, "Invalid data.", parsed.error.issues.slice(0, 5)) }
  return { data: parsed.data }
}

export function publicBaseUrl(req: Request): string {
  return publicBaseUrlFrom(req.headers)
}

/** Like publicBaseUrl, from the headers (server pages: `await headers()`). */
export function publicBaseUrlFrom(h: Headers): string {
  if (process.env.BRAIN_PUBLIC_URL) return process.env.BRAIN_PUBLIC_URL.replace(/\/+$/, "")
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000"
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https")
  return `${proto}://${host}`
}
