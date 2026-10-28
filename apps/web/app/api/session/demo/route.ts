import { z } from "zod"
import { demoPulse } from "@/lib/demo-live"
import { getStore, runInOrg } from "@/lib/store"
import { isDemoMode } from "@/lib/auth"
import { error, internalError, json, parseBody } from "@/lib/http"
import { openSession } from "@/lib/session"
import { demoPeople, ensureDemoBrain } from "@/lib/demo-seed"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** Demo mode only (BRAIN_DEMO=1): list of accounts for one-click sign-in. */
export async function GET() {
  if (!isDemoMode()) return error(404, "Demo mode is off.")
  try {
    // Fresh deployment: the database is empty, it is seeded with the demo's fictional company.
    await ensureDemoBrain()
    // Only the six people: visitors enter with their own token, and the accounts made by hand never show.
    const profiles = demoPeople(await getStore().listProfiles())
    return json({ users: profiles.map((p) => ({ id: p.id, name: p.name, title: p.title, role: p.role })) })
  } catch (err) {
    return internalError(err)
  }
}

const Schema = z.object({ userId: z.string().max(64) })

export async function POST(req: Request) {
  if (!isDemoMode()) return error(404, "Demo mode is off.")
  const body = await parseBody(req, Schema)
  if ("response" in body) return body.response
  try {
    const profile = demoPeople(await getStore().listProfiles()).find((p) => p.id === body.data.userId)
    if (!profile) return error(404, "Member not found.")
    await openSession(profile.id)
    // The visitor lands on a team at work: the first beat comes now, not with the dashboard's first poll.
    await runInOrg(profile.org_id, () => demoPulse()).catch((err) => console.error("[demo]", err instanceof Error ? err.message : err))
    return json({ ok: true, profile })
  } catch (err) {
    return internalError(err)
  }
}
