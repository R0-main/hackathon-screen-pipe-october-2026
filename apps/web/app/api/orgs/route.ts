import { z } from "zod"
import { DEFAULT_ZONES } from "@brain/core"
import { getRootStore, storeForOrg } from "@/lib/store"
import { hashToken, newToken, signupOpen } from "@/lib/auth"
import { caFingerprint } from "@/lib/ca"
import { buildInstallPrompt } from "@/lib/install-prompt"
import { error, internalError, json, parseBody, publicBaseUrl } from "@/lib/http"
import { zonesForNewOrg } from "@/lib/onboarding"
import { openSession } from "@/lib/session"

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
  /** Zones choisies plus tard (/creer : Claude Code ou Codex les propose d'abord) : l'entreprise est créée sans zone. */
  later: z.boolean().default(false),
})

/**
 * Crée une entreprise depuis /creer : son cerveau (à part de celui de la démo), ses zones, et son premier compte, admin.
 * Avec `later` : sans zone, choisies ensuite (POST /api/onboarding/zones), une fois que Claude a pu les proposer.
 * Ouvre la session du dashboard (l'entreprise rejoint celles retenues par ce navigateur) et renvoie le prompt d'installation de ce premier poste (jeton affiché une seule fois).
 */
export async function POST(req: Request) {
  if (!signupOpen()) return error(404, "La création d'entreprise est fermée sur ce cerveau.")
  const body = await parseBody(req, Schema)
  if ("response" in body) return body.response
  const { company, description, name, title } = body.data
  const zones = body.data.later ? [] : zonesForNewOrg(body.data.zones, body.data.custom)
  if (zones.length === 0 && !body.data.later) return error(400, "Choisissez au moins une zone.")
  try {
    const root = getRootStore()
    if ((await root.countTenantOrgs()) >= MAX_ORGS) return error(429, "Le nombre d'entreprises de ce cerveau est atteint. Réessayez plus tard.")
    const org = await root.createTenantOrg({ name: company, description, zones })
    const store = storeForOrg(org.id)
    const token = newToken()
    const profile = await store.createProfile({ name, title: title || undefined, role: "admin", manager_id: null, token_hash: hashToken(token) })
    await store.setZoneAccess(profile.id, zones.map((z) => ({ zone_id: z.id, can_write: true })))

    // La session de l'entreprise d'où l'on vient (s'il y en a une) reste retenue : on y revient en un clic.
    await openSession(profile.id)

    const prompt = buildInstallPrompt({ baseUrl: publicBaseUrl(req), token, name: profile.name, orgName: org.name, zones: zones.map((z) => z.id), caFingerprint: caFingerprint() })
    // Le jeton (déjà dans le prompt) sert aussi à refaire ce prompt une fois les zones choisies (POST /api/onboarding/zones).
    return json({ org: { id: org.id, name: org.name }, profile: { id: profile.id, name: profile.name }, zones, prompt, token }, 201)
  } catch (err) {
    return internalError(err)
  }
}
