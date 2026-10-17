import { cookies } from "next/headers"
import { z } from "zod"
import { DEFAULT_ZONES, normalize, slugify, tokenize, zoneColor, type Zone } from "@brain/core"
import { getRootStore, storeForOrg } from "@/lib/store"
import { createSessionValue, hashToken, newToken, SESSION_COOKIE, sessionCookieOptions, signupOpen, VIEW_AS_COOKIE } from "@/lib/auth"
import { buildInstallPrompt } from "@/lib/install-prompt"
import { error, internalError, json, parseBody, publicBaseUrl } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** Plafond d'entreprises créées depuis la page d'accueil, pour qu'une page publique ne puisse pas remplir la base. */
const MAX_ORGS = Number(process.env.BRAIN_MAX_ORGS) || 200

const Schema = z.object({
  company: z.string().trim().min(1).max(80),
  description: z.string().trim().max(300).default(""),
  name: z.string().trim().min(1).max(80),
  title: z.string().trim().max(80).optional(),
  /** Zones proposées (DEFAULT_ZONES) retenues, par identifiant. */
  zones: z.array(z.string().max(32)).max(DEFAULT_ZONES.length).default([]),
  /** Zones ajoutées à la main, par nom. */
  custom: z.array(z.string().trim().min(1).max(40)).max(8).default([]),
})

/** Les zones de la nouvelle entreprise : celles proposées dans l'ordre d'origine, puis les siennes, couleurs sans doublon. */
function buildZones(picked: string[], custom: string[]): Zone[] {
  const out: Zone[] = DEFAULT_ZONES.filter((z) => picked.includes(z.id)).map((z) => ({ ...z }))
  for (const name of custom) {
    const id = slugify(name)
    if (out.some((z) => z.id === id)) continue
    const keywords = [...new Set([normalize(name), ...tokenize(name)])].filter((k) => k.length >= 3)
    out.push({ id, name, description: "", color: "", keywords, position: 0 })
  }
  const palette = Array.from({ length: 10 }, (_, i) => zoneColor(i))
  const used = new Set(out.map((z) => z.color).filter(Boolean))
  const free = palette.filter((c) => !used.has(c))
  return out.map((z, position) => ({ ...z, position, color: z.color || free.shift() || zoneColor(position) }))
}

/**
 * Crée une entreprise depuis /creer : son cerveau (à part de celui de la démo), ses zones, et son premier compte, admin.
 * Ouvre la session du dashboard et renvoie le prompt d'installation de ce premier poste (jeton affiché une seule fois).
 */
export async function POST(req: Request) {
  if (!signupOpen()) return error(404, "La création d'entreprise est fermée sur ce cerveau.")
  const body = await parseBody(req, Schema)
  if ("response" in body) return body.response
  const { company, description, name, title } = body.data
  const zones = buildZones(body.data.zones, body.data.custom)
  if (zones.length === 0) return error(400, "Choisissez au moins une zone.")
  try {
    const root = getRootStore()
    if ((await root.countTenantOrgs()) >= MAX_ORGS) return error(429, "Le nombre d'entreprises de ce cerveau est atteint. Réessayez plus tard.")
    const org = await root.createTenantOrg({ name: company, description, zones })
    const store = storeForOrg(org.id)
    const token = newToken()
    const profile = await store.createProfile({ name, title: title || undefined, role: "admin", manager_id: null, token_hash: hashToken(token) })
    await store.setZoneAccess(profile.id, zones.map((z) => ({ zone_id: z.id, can_write: true })))

    const jar = await cookies()
    jar.set(SESSION_COOKIE, await createSessionValue(profile.id), sessionCookieOptions)
    jar.delete(VIEW_AS_COOKIE)

    const prompt = buildInstallPrompt({ baseUrl: publicBaseUrl(req), token, name: profile.name, orgName: org.name, zones: zones.map((z) => z.id) })
    return json({ org: { id: org.id, name: org.name }, profile: { id: profile.id, name: profile.name }, zones, prompt }, 201)
  } catch (err) {
    return internalError(err)
  }
}
