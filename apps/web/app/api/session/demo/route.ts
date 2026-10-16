import { cookies } from "next/headers"
import { z } from "zod"
import { getStore } from "@/lib/store"
import { createSessionValue, isDemoMode, SESSION_COOKIE, sessionCookieOptions, VIEW_AS_COOKIE } from "@/lib/auth"
import { error, json, parseBody } from "@/lib/http"
import { ensureDemoBrain } from "@/lib/demo-seed"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** Mode démo uniquement (BRAIN_DEMO=1) : liste des comptes pour la connexion en un clic. */
export async function GET() {
  if (!isDemoMode()) return error(404, "Mode démo désactivé.")
  // Déploiement neuf : la base est vide, on l'amorce avec l'entreprise fictive de la démo.
  await ensureDemoBrain()
  const profiles = await getStore().listProfiles()
  return json({ users: profiles.map((p) => ({ id: p.id, name: p.name, title: p.title, role: p.role })) })
}

const Schema = z.object({ userId: z.string().max(64) })

export async function POST(req: Request) {
  if (!isDemoMode()) return error(404, "Mode démo désactivé.")
  const body = await parseBody(req, Schema)
  if ("response" in body) return body.response
  const profile = await getStore().getProfile(body.data.userId)
  if (!profile) return error(404, "Membre introuvable.")
  const jar = await cookies()
  jar.set(SESSION_COOKIE, await createSessionValue(profile.id), sessionCookieOptions)
  jar.delete(VIEW_AS_COOKIE)
  return json({ ok: true, profile })
}
