import { getStore } from "@/lib/store"
import { hashToken, newToken } from "@/lib/auth"
import { caFingerprint } from "@/lib/ca"
import { buildInstallPrompt } from "@/lib/install-prompt"
import { error, json, publicBaseUrl, withViewer } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ id: string }> }

/** Régénère le jeton (l'ancien cesse de fonctionner) et renvoie un nouveau prompt d'installation. */
export const POST = withViewer<Ctx>(
  async (req, _viewer, { params }) => {
    const { id } = await params
    const store = getStore()
    const token = newToken()
    const profile = await store.updateProfile(id, { token_hash: hashToken(token) })
    if (!profile) return error(404, "Membre introuvable.")
    const zones = (await store.listZoneAccess(id)).map((a) => a.zone_id)
    const org = await store.getOrg()
    return json({ token, prompt: buildInstallPrompt({ baseUrl: publicBaseUrl(req), token, name: profile.name, orgName: org.name, orgDescription: org.description, zones, caFingerprint: caFingerprint() }) })
  },
  { admin: true },
)
