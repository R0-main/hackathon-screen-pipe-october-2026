import { z } from "zod"
import { DEFAULT_ZONES, KnowledgeItemInputSchema, isCoreZone, slugify } from "@brain/core"
import { getAccess } from "@/lib/access"
import { hashToken } from "@/lib/auth"
import { ingestItems, refreshStatus } from "@/lib/brain"
import { caFingerprint } from "@/lib/ca"
import { buildInstallPrompt } from "@/lib/install-prompt"
import { coreFromDescription, zonesForNewOrg, zonesFromDraft } from "@/lib/onboarding"
import { clearAgentDraft } from "@/lib/onboarding-agent"
import { getStore } from "@/lib/store"
import { error, json, parseBody, publicBaseUrl, withViewer } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 120

const Schema = z.object({
  /** Zones suggested by Claude Code or Codex and kept (names and descriptions possibly edited). */
  proposed: z
    .array(z.object({ id: z.string().max(32), name: z.string().trim().min(1).max(40), description: z.string().max(300).default(""), keywords: z.array(z.string().max(40)).max(80).default([]) }))
    .max(12)
    .default([]),
  /** Ticked zones from the default list, by id. */
  picked: z.array(z.string().max(32)).max(DEFAULT_ZONES.length).default([]),
  /** Zones added by hand, by name. */
  custom: z.array(z.string().trim().min(1).max(40)).max(8).default([]),
  /** The proposal's first knowledge: filed in the kept zones (otherwise classified into the closest one). */
  items: z.array(KnowledgeItemInputSchema).max(60).default([]),
  /** Company description taken from the proposal, used if the admin did not give one. */
  description: z.string().max(2000).default(""),
  /** The admin's token (returned by POST /api/orgs, already in their prompt): to redo this prompt with the chosen zones. */
  token: z.string().max(200).optional(),
})

/**
 * /create, zones step (admin): creates the chosen zones (suggested by Claude, ticked, added), gives the admin access to
 * them, adds the proposal's first knowledge, then redoes their install prompt so that it names these zones. The token
 * does not change (the dashboard session depends on it): the page sends it back, it is checked; without it, no new
 * prompt (the page keeps the one from creation).
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
    // The core, in every brain, is not a zone chosen here.
    if (wanted.length === 0 && existing.every((z) => isCoreZone(z.id))) return error(400, "Choose at least one zone.")
    for (const zone of zonesFromDraft({ zones: wanted }, existing)) await store.upsertZone(zone)

    const zones = await store.listZones()
    await store.setZoneAccess(viewer.real.id, zones.map((z) => ({ zone_id: z.id, can_write: true })))
    const current = await store.getOrg()
    const org =
      !current.description.trim() && body.data.description.trim() ? await store.updateOrg({ name: current.name, description: body.data.description.trim() }) : current
    const fresh = { ...viewer, access: await getAccess(viewer.real) }
    // A description given only now (proposed by Claude Code or Codex) also goes into the core.
    const core = org !== current ? coreFromDescription(org.name, org.description) : []
    const items = [...core, ...body.data.items]
    const inserted = items.length ? (await ingestItems(fresh, items, "job")).inserted : 0
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
