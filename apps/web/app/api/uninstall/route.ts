import { getStore } from "@/lib/store"
import { hashToken, newToken } from "@/lib/auth"
import { error, json, withViewer } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * POST /api/uninstall — `brain uninstall` : le poste est noté désinstallé et son jeton révoqué (remplacé par un jeton
 * que personne ne connaît : MCP, hooks, synchro et sessions du dashboard liées à ce jeton cessent de marcher). Le membre
 * et ses connaissances restent ; « Nouveau prompt » le rebranche. Un événement « stopped » éteint son point en direct.
 * Seul le client du poste l'appelle (jeton personnel), jamais une session du dashboard. Le dernier admin encore branché
 * garde son jeton (sinon plus personne ne pourrait ouvrir le cerveau ni régénérer de prompt) : il est seulement noté.
 */
export const POST = withViewer(async (req, viewer) => {
  if (!/^Bearer\s/i.test(req.headers.get("authorization") ?? "")) return error(403, "Réservé au client du poste (jeton personnel).")
  const store = getStore()
  const me = viewer.real
  const revoked = me.role !== "admin" || (await store.listProfiles()).some((p) => p.role === "admin" && p.id !== me.id && !p.uninstalled_at)
  const at = new Date().toISOString()
  const profile = await store.updateProfile(me.id, { uninstalled_at: at, ...(revoked ? { token_hash: hashToken(newToken()) } : {}) })
  if (!profile) return error(404, "Membre introuvable.")
  await store.insertEvents([{ user_id: profile.id, agent: "brain-sync", type: "stopped", zones: [], summary: "Client désinstallé de son poste", at }])
  return json({ uninstalled: true, revoked, at })
})
