import { z } from "zod"
import { DEFAULT_ZONES, KnowledgeItemInputSchema, slugify } from "@brain/core"
import { getAccess } from "@/lib/access"
import { hashToken } from "@/lib/auth"
import { ingestItems, refreshStatus } from "@/lib/brain"
import { caFingerprint } from "@/lib/ca"
import { buildInstallPrompt } from "@/lib/install-prompt"
import { zonesForNewOrg, zonesFromDraft } from "@/lib/onboarding"
import { clearAgentDraft } from "@/lib/onboarding-agent"
import { getStore } from "@/lib/store"
import { error, json, parseBody, publicBaseUrl, withViewer } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 120

const Schema = z.object({
  /** Zones proposées par Claude Code ou Codex et gardées (noms et descriptions éventuellement retouchés). */
  proposed: z
    .array(z.object({ id: z.string().max(32), name: z.string().trim().min(1).max(40), description: z.string().max(300).default(""), keywords: z.array(z.string().max(40)).max(80).default([]) }))
    .max(12)
    .default([]),
  /** Zones de la liste par défaut cochées, par identifiant. */
  picked: z.array(z.string().max(32)).max(DEFAULT_ZONES.length).default([]),
  /** Zones ajoutées à la main, par nom. */
  custom: z.array(z.string().trim().min(1).max(40)).max(8).default([]),
  /** Premières connaissances de la proposition : rangées dans les zones gardées (sinon classées dans la plus proche). */
  items: z.array(KnowledgeItemInputSchema).max(60).default([]),
  /** Description de l'entreprise tirée de la proposition, reprise si l'admin n'en a pas donné. */
  description: z.string().max(2000).default(""),
  /** Jeton de l'admin (renvoyé par POST /api/orgs, déjà dans son prompt) : pour refaire ce prompt avec les zones choisies. */
  token: z.string().max(200).optional(),
})

/**
 * /creer, étape des zones (admin) : crée les zones choisies (celles proposées par Claude, cochées, ajoutées), donne
 * leur accès à l'admin, ajoute les premières connaissances de la proposition, puis refait son prompt d'installation
 * pour qu'il cite ces zones. Le jeton ne change pas (la session du dashboard en dépend) : la page le renvoie, il est
 * vérifié ; sans lui, pas de nouveau prompt (la page garde celui de la création).
 */
export const POST = withViewer(
  async (req, viewer) => {
    const body = await parseBody(req, Schema)
    if ("response" in body) return body.response
    const store = getStore()
    const existing = await store.listZones()
    const proposed = body.data.proposed.map((p) => ({ ...p, id: slugify(p.id) || slugify(p.name) })).filter((p) => p.id)
    const ids = new Set(proposed.map((p) => p.id))
    const others = zonesForNewOrg(body.data.picked, body.data.custom)
      .filter((d) => !ids.has(d.id))
      .map(({ id, name, description, keywords }) => ({ id, name, description, keywords }))
    const wanted = [...proposed, ...others]
    if (wanted.length === 0 && existing.length === 0) return error(400, "Choisissez au moins une zone.")
    for (const zone of zonesFromDraft({ zones: wanted }, existing)) await store.upsertZone(zone)

    const zones = await store.listZones()
    await store.setZoneAccess(viewer.real.id, zones.map((z) => ({ zone_id: z.id, can_write: true })))
    const current = await store.getOrg()
    const org =
      !current.description.trim() && body.data.description.trim() ? await store.updateOrg({ name: current.name, description: body.data.description.trim() }) : current
    const fresh = { ...viewer, access: await getAccess(viewer.real) }
    const inserted = body.data.items.length ? (await ingestItems(fresh, body.data.items, "job")).inserted : 0
    if (inserted) await refreshStatus(fresh)
    await clearAgentDraft(store)

    const token = body.data.token
    const mine = token !== undefined && (await store.getTokenHash(viewer.real.id)) === hashToken(token)
    const prompt =
      token !== undefined && mine
        ? buildInstallPrompt({ baseUrl: publicBaseUrl(req), token, name: viewer.real.name, orgName: org.name, orgDescription: org.description, zones: zones.map((z) => z.id), caFingerprint: caFingerprint() })
        : null
    return json({ zones, inserted, prompt })
  },
  { admin: true },
)
