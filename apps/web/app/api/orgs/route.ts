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

/** Cap on companies created from the home page, so that a public page cannot fill the database. */
const MAX_ORGS = Number(process.env.BRAIN_MAX_ORGS) || 200

const Schema = z.object({
  company: z.string().trim().min(1).max(80),
  description: z.string().trim().max(300).default(""),
  name: z.string().trim().min(1).max(80),
  title: z.string().trim().max(80).optional(),
  /** Suggested zones (DEFAULT_ZONES) kept, by id. */
  zones: z.array(z.string().max(32)).max(DEFAULT_ZONES.length).default([]),
  /** Zones added by hand, by name. */
  custom: z.array(z.string().trim().min(1).max(40)).max(8).default([]),
  /** Zones chosen later (/create: Claude Code or Codex suggests them first): the company is created without a zone. */
  later: z.boolean().default(false),
})

/**
 * Creates a company from /create: its brain (separate from the demo's), its zones, and its first account, an admin.
 * With `later`: no zone, chosen afterwards (POST /api/onboarding/zones), once Claude has been able to suggest them.
 * Opens the dashboard session (the company joins those remembered by this browser) and returns the install prompt for
 * this first workstation (token shown only once).
 */
export async function POST(req: Request) {
  if (!signupOpen()) return error(404, "Company creation is closed on this brain.")
  const body = await parseBody(req, Schema)
  if ("response" in body) return body.response
  const { company, description, name, title } = body.data
  const zones = body.data.later ? [] : zonesForNewOrg(body.data.zones, body.data.custom)
  if (zones.length === 0 && !body.data.later) return error(400, "Choose at least one zone.")
  try {
    const root = getRootStore()
    if ((await root.countTenantOrgs()) >= MAX_ORGS) return error(429, "This brain has reached its number of companies. Try again later.")
    const org = await root.createTenantOrg({ name: company, description, zones })
    const store = storeForOrg(org.id)
    const token = newToken()
    const profile = await store.createProfile({ name, title: title || undefined, role: "admin", manager_id: null, token_hash: hashToken(token) })
    await store.setZoneAccess(profile.id, zones.map((z) => ({ zone_id: z.id, can_write: true })))

    // The session of the company you come from (if any) stays remembered: you go back to it in one click.
    await openSession(profile.id)

    const prompt = buildInstallPrompt({ baseUrl: publicBaseUrl(req), token, name: profile.name, orgName: org.name, orgDescription: org.description, zones: zones.map((z) => z.id), caFingerprint: caFingerprint() })
    // The token (already in the prompt) is also used to redo this prompt once the zones are chosen (POST /api/onboarding/zones).
    return json({ org: { id: org.id, name: org.name }, profile: { id: profile.id, name: profile.name }, zones, prompt, token }, 201)
  } catch (err) {
    return internalError(err)
  }
}
