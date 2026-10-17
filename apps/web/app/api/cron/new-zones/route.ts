import { createHash, timingSafeEqual } from "node:crypto"
import { localDay, localHour, NEW_ZONES_HOUR, runNewZones, type NewZonesRun } from "@/lib/new-zones"
import { getRootStore, runInOrg } from "@/lib/store"
import { error, internalError, json } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 300

/** Entreprises traitées en parallèle : la plupart n'appellent pas Claude (trop peu de connaissances), les autres attendent ~30 s. */
const CONCURRENCY = 4

/** Vercel Cron envoie `Authorization: Bearer $CRON_SECRET` ; sans secret configuré, la route reste fermée. */
function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET
  const got = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]
  if (!secret || !got) return false
  const digest = (s: string) => createHash("sha256").update(s).digest()
  return timingSafeEqual(digest(got), digest(secret))
}

type OrgResult = { org_id: string } & (NewZonesRun | { status: "already_ran" } | { status: "error"; message: string })

/**
 * Job quotidien « nouvelles zones », pour toutes les entreprises du cerveau. Déclenché par vercel.json à 8 h et 9 h UTC :
 * seul le passage qui tombe à 10 h (heure de l'entreprise) travaille, et une seule fois par jour et par entreprise
 * (claimOnce), même si Vercel relance l'appel. `?force=1` (avec le secret) lance un passage tout de suite.
 */
export async function GET(req: Request) {
  if (!process.env.CRON_SECRET) return error(503, "CRON_SECRET n'est pas défini : le job planifié est désactivé.")
  if (!authorized(req)) return error(401, "Non autorisé.")
  const force = new URL(req.url).searchParams.get("force") === "1"
  const hour = localHour()
  if (!force && hour !== NEW_ZONES_HOUR) return json({ ran: false, reason: `il est ${hour} h, le passage est à ${NEW_ZONES_HOUR} h` })
  try {
    const root = getRootStore()
    const day = localDay()
    const orgIds = await root.listOrgIds()
    // Rangés dans l'ordre des entreprises (la base d'abord), quel que soit l'ordre dans lequel elles finissent.
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
    console.log(`[new-zones] ${day} : ${orgIds.length} entreprise(s), ${created.length} zone(s) créée(s)${created.length ? ` (${created.join(", ")})` : ""}`)
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
    // Rendu pour que le passage de l'heure suivante (ou une relance) puisse réessayer.
    if (!force) await store.releaseClaim(key).catch(() => {})
    console.error(`[new-zones] ${orgId} :`, err)
    return { org_id: orgId, status: "error", message: (err as Error).message }
  }
}
