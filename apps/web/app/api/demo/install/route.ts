import { getStore } from "@/lib/store"
import { hashToken, isDemoMode, newToken } from "@/lib/auth"
import { ensureDemoBrain } from "@/lib/demo-seed"
import { buildInstallPrompt } from "@/lib/install-prompt"
import { error, internalError, json, publicBaseUrl } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** Titre des comptes créés depuis la page d'accueil : c'est lui qui les compte et les distingue de l'équipe Fournil. */
const VISITOR_TITLE = "Visiteur de la démo"
/** Plafond de comptes visiteurs, pour qu'une page publique ne puisse pas remplir la base. */
const MAX_VISITORS = 100
const VISITOR_ZONES = ["dev", "produit"]

/**
 * Mode démo uniquement (BRAIN_DEMO=1) : crée un compte « Visiteur » sur le cerveau de démo et renvoie son prompt
 * d'installation, avec un jeton qui lui est propre. Le bouton « Copier le prompt » de la page d'accueil l'appelle au clic.
 */
export async function POST(req: Request) {
  if (!isDemoMode()) return error(404, "Mode démo désactivé.")
  try {
    await ensureDemoBrain()
    const store = getStore()
    const visitors = (await store.listProfiles()).filter((p) => p.title === VISITOR_TITLE)
    if (visitors.length >= MAX_VISITORS) return error(429, "La démo a atteint son nombre de visiteurs. Réessayez plus tard.")
    const known = new Set((await store.listZones()).map((z) => z.id))
    const zones = VISITOR_ZONES.filter((z) => known.has(z))
    const token = newToken()
    const profile = await store.createProfile({
      name: `Visiteur ${String(Math.floor(1000 + Math.random() * 9000))}`,
      title: VISITOR_TITLE,
      role: "member",
      manager_id: null,
      token_hash: hashToken(token),
    })
    await store.setZoneAccess(profile.id, zones.map((zone_id) => ({ zone_id, can_write: true })))
    const org = await store.getOrg()
    return json({ prompt: buildInstallPrompt({ baseUrl: publicBaseUrl(req), token, name: profile.name, orgName: org.name, zones }) }, 201)
  } catch (err) {
    return internalError(err)
  }
}
