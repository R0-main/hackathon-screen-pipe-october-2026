import { createHash, timingSafeEqual } from "node:crypto"
import { localDay, localHour, NEW_ZONES_HOUR, runNewZones, type NewZonesRun } from "@/lib/new-zones"
import { getRootStore, runInOrg } from "@/lib/store"
import { error, internalError, json } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 300

/** Companies processed in parallel: most do not call Claude (too little knowledge), the others wait ~30 s. */
const CONCURRENCY = 4

/** Vercel Cron sends `Authorization: Bearer $CRON_SECRET`; without a configured secret, the route stays closed. */
function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET
  const got = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]
  if (!secret || !got) return false
  const digest = (s: string) => createHash("sha256").update(s).digest()
  return timingSafeEqual(digest(got), digest(secret))
}

type OrgResult = { org_id: string } & (NewZonesRun | { status: "already_ran" } | { status: "error"; message: string })

/**
 * Daily "new zones" job, for every company of the brain. Triggered by vercel.json at 8am and 9am UTC:
 * only the run that falls at 10am (company time) works, and only once per day and per company
 * (claimOnce), even if Vercel retries the call. `?force=1` (with the secret) runs a pass right away.
 */
export async function GET(req: Request) {
  if (!process.env.CRON_SECRET) return error(503, "CRON_SECRET is not set: the scheduled job is disabled.")
  if (!authorized(req)) return error(401, "Unauthorized.")
  const force = new URL(req.url).searchParams.get("force") === "1"
  const hour = localHour()
  if (!force && hour !== NEW_ZONES_HOUR) return json({ ran: false, reason: `it is ${hour}:00, the run is at ${NEW_ZONES_HOUR}:00` })
  try {
    const root = getRootStore()
    const day = localDay()
    const orgIds = await root.listOrgIds()
    // Sorted in company order (the base first), whatever order they finish in.
    const results: OrgResult[] = new Array(orgIds.length)
    let next = 0
    const worker = async () => {
      while (next < orgIds.length) {
        const i = next++
        results[i] = await runForOrg(orgIds[i], day, force)
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, orgIds.length) }, worker))
    const created = results.flatMap((r) => (r.status === "created" ? r.zones.map((z) => z.name) : []))
    console.log(`[new-zones] ${day}: ${orgIds.length} company(ies), ${created.length} zone(s) created${created.length ? ` (${created.join(", ")})` : ""}`)
    return json({ ran: true, day, orgs: results })
  } catch (err) {
    return internalError(err)
  }
}

async function runForOrg(orgId: string, day: string, force: boolean): Promise<OrgResult> {
  const store = getRootStore()
  const key = `new-zones:${orgId}:${day}`
  if (!force && !(await store.claimOnce(key))) return { org_id: orgId, status: "already_ran" }
  try {
    const run = await runInOrg(orgId, () => runNewZones())
    if (!force) await store.finishClaim(key)
    return { org_id: orgId, ...run }
  } catch (err) {
    // Released so that the next hour's run (or a retry) can try again.
    if (!force) await store.releaseClaim(key).catch(() => {})
    console.error(`[new-zones] ${orgId} :`, err)
    return { org_id: orgId, status: "error", message: (err as Error).message }
  }
}
