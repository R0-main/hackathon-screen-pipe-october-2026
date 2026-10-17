import { getStore } from "@/lib/store"
import { hashToken, isDemoMode, newToken } from "@/lib/auth"
import { DEMO_VISITOR_TITLE, demoVisitorManager, ensureDemoBrain } from "@/lib/demo-seed"
import { caFingerprint } from "@/lib/ca"
import { buildInstallPrompt } from "@/lib/install-prompt"
import { error, internalError, json, publicBaseUrl } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** Cap on visitor accounts, so that a public page cannot fill the database. */
const MAX_VISITORS = 100
const VISITOR_ZONES = ["dev", "product"]

/**
 * Demo mode only (BRAIN_DEMO=1): creates a "Visitor" account on the demo brain and returns its install
 * prompt, with a token of its own. The home page's "Copy the prompt" button calls it on click.
 */
export async function POST(req: Request) {
  if (!isDemoMode()) return error(404, "Demo mode is off.")
  try {
    await ensureDemoBrain()
    const store = getStore()
    const visitors = (await store.listProfiles()).filter((p) => p.title === DEMO_VISITOR_TITLE)
    if (visitors.length >= MAX_VISITORS) return error(429, "The demo has reached its number of visitors. Try again later.")
    const known = new Set((await store.listZones()).map((z) => z.id))
    const zones = VISITOR_ZONES.filter((z) => known.has(z))
    const token = newToken()
    const profile = await store.createProfile({
      name: `Visitor ${String(Math.floor(1000 + Math.random() * 9000))}`,
      title: DEMO_VISITOR_TITLE,
      role: "member",
      // In the org chart, the visitor joins the lead dev's team (same zones).
      manager_id: await demoVisitorManager(store),
      token_hash: hashToken(token),
    })
    await store.setZoneAccess(profile.id, zones.map((zone_id) => ({ zone_id, can_write: true })))
    const org = await store.getOrg()
    return json({ prompt: buildInstallPrompt({ baseUrl: publicBaseUrl(req), token, name: profile.name, orgName: org.name, orgDescription: org.description, zones, caFingerprint: caFingerprint() }) }, 201)
  } catch (err) {
    return internalError(err)
  }
}
