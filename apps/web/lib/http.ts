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

/** Exige un utilisateur authentifié (jeton Bearer ou session), dans le contexte de son entreprise. `admin` : vérifie le rôle réel. */
export function withViewer<C = unknown>(handler: Handler<C>, opts: { admin?: boolean } = {}) {
  return async (req: Request, ctx: C) => {
    try {
      const viewer = await viewerFromRequest(req)
      if (!viewer) return error(401, "Non authentifié : jeton manquant ou invalide.")
      if (opts.admin && viewer.real.role !== "admin") return error(403, "Réservé aux admins.")
      // Tout ce que fait la route vise l'entreprise du compte connecté (getStore()).
      return await runInOrg(viewer.real.org_id, () => handler(req, viewer, ctx))
    } catch (err) {
      return internalError(err, routeOf(req))
    }
  }
}

/**
 * Erreur inattendue d'une route : 503 avec un message clair si le stockage n'est pas prêt (migration…), sinon 500.
 * `where` : la route, pour la page Supervision (incidents) et l'alerte webhook.
 */
export function internalError(err: unknown, where = "api"): Response {
  if (isStoreSetupError(err)) {
    console.error("[api]", err.message)
    recordIncident(where, err)
    return error(503, err.message)
  }
  console.error("[api]", err)
  recordIncident(where, err)
  return error(500, "Erreur interne du cerveau.")
}

export async function parseBody<T extends z.ZodType>(req: Request, schema: T): Promise<{ data: z.infer<T> } | { response: Response }> {
  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return { response: error(400, "Corps JSON invalide.") }
  }
  const parsed = schema.safeParse(raw)
  if (!parsed.success) return { response: error(400, "Données invalides.", parsed.error.issues.slice(0, 5)) }
  return { data: parsed.data }
}

export function publicBaseUrl(req: Request): string {
  if (process.env.BRAIN_PUBLIC_URL) return process.env.BRAIN_PUBLIC_URL.replace(/\/+$/, "")
  const h = req.headers
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000"
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https")
  return `${proto}://${host}`
}
