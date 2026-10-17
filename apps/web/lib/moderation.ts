// Modérateur du cerveau : toutes les 15 min, Claude relit ce qui est arrivé depuis le passage précédent et garde,
// corrige ou retire chaque connaissance. Le passage est fait par Claude Code sur le poste d'un admin (`brain moderate`,
// lancé par sa synchro planifiée, avec son jeton d'abonnement), ou par le serveur avec la clé API de l'entreprise
// (« Lancer maintenant »). Un curseur (date d'arrivée) retient où le dernier passage s'est arrêté.
// Le journal des admins ne garde que des métadonnées (zone, type, motif), jamais le texte retiré.

import {
  MODERATION_BATCH,
  MODERATION_CHUNK,
  MODERATION_REASON_LABELS,
  applyModeration,
  buildModerationInput,
  redactText,
  truncate,
  type KnowledgeItem,
  type ModerationInput,
  type ModerationReason,
  type ModerationVerdict,
} from "@brain/core"
import { moderateKnowledge } from "@brain/core/claude"
import { getClaude } from "./ai"
import { getStore } from "./store"

/** `claude-code` : Claude Code sur le poste d'un admin (son abonnement) ; `server` : la clé API de l'entreprise. */
export type ModerationVia = "claude-code" | "server"

export type ModerationLogEntry = {
  at: string
  author: string
  zone: string
  kind: string
  decision: "edit" | "reject"
  category?: ModerationReason
  /** Motif en une phrase (masqué) ; absent pour un retrait « personnel » ou « secret », dont le motif pourrait citer le contenu. */
  reason?: string
}

export type ModerationRun = {
  at: string
  via: ModerationVia
  status: "done" | "nothing" | "off" | "no_claude" | "claude_error"
  reviewed: number
  edited: number
  rejected: number
  /** Connaissances encore en attente après ce passage (relues au suivant). */
  remaining?: number
}

type Cursor = { at: string; ids: string[] }

const ENABLED_SETTING = "moderation"
const CURSOR_SETTING = "moderation-cursor"
const LOG_SETTING = "moderation-log"
const RUNS_SETTING = "moderation-runs"
const LOG_MAX = 100
const RUNS_MAX = 30
/** Premier passage : ce qui est arrivé dans les dernières 24 h. */
const FIRST_WINDOW_MS = 24 * 3600_000
/** Connaissances déjà en place montrées en regard (doublons) : les plus récentes, sur 90 jours. */
const PUBLISHED_DAYS = 90
const PUBLISHED_MAX = 400
/** Ajoutées par un admin (onboarding, connecteurs) : pas relues. */
const UNMODERATED_TOOLS = new Set(["onboarding", "connector"])
const CONCURRENCY = 3

const store = () => getStore()

async function readSetting<T>(name: string, fallback: T): Promise<T> {
  const raw = await store().getOrgSetting(name)
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export async function moderationEnabled(): Promise<boolean> {
  return (await store().getOrgSetting(ENABLED_SETTING)) !== "off"
}

export async function setModerationEnabled(on: boolean) {
  await store().setOrgSetting(ENABLED_SETTING, on ? null : "off")
}

export const loadModerationLog = () => readSetting<ModerationLogEntry[]>(LOG_SETTING, [])
export const loadModerationRuns = () => readSetting<ModerationRun[]>(RUNS_SETTING, [])

async function loadCursor(): Promise<Cursor | null> {
  const c = await readSetting<Cursor | null>(CURSOR_SETTING, null)
  return c && typeof c.at === "string" && Array.isArray(c.ids) ? c : null
}

function isPending(item: KnowledgeItem, cursor: Cursor | null, since: string): boolean {
  if (UNMODERATED_TOOLS.has(item.source.tool) || item.superseded_by) return false
  if (item.created_at < since) return false
  return !(cursor && item.created_at === cursor.at && cursor.ids.includes(item.id))
}

/** Connaissances pas encore relues, les plus anciennes d'abord. */
async function pendingItems(): Promise<KnowledgeItem[]> {
  const cursor = await loadCursor()
  const since = cursor?.at ?? new Date(Date.now() - FIRST_WINDOW_MS).toISOString()
  const items = await store().listItems({ sinceIso: since, limit: 5000 })
  return items.filter((i) => isPending(i, cursor, since)).sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
}

/** Matière d'un passage : jusqu'à MODERATION_BATCH connaissances à relire (avec leur `id`), ou la raison de ne rien faire. */
export async function moderationInput(): Promise<{ input: ModerationInput; remaining: number } | { skipped: "off" | "nothing" }> {
  if (!(await moderationEnabled())) return { skipped: "off" }
  const pending = await pendingItems()
  if (!pending.length) return { skipped: "nothing" }
  const batch = pending.slice(0, MODERATION_BATCH)
  const s = store()
  const [org, zones, profiles, published] = await Promise.all([
    s.getOrg(),
    s.listZones(),
    s.listProfiles(),
    s.listItems({ sinceIso: new Date(Date.now() - PUBLISHED_DAYS * 86400_000).toISOString(), limit: PUBLISHED_MAX, excludeSuperseded: true }),
  ])
  const names = new Map(profiles.map((p) => [p.id, p.name]))
  const input = buildModerationInput({
    companyName: org.name,
    zones,
    items: batch.map((i) => ({ ...i, author: names.get(i.author_id) ?? "inconnu" })),
    published,
  })
  return { input, remaining: pending.length - batch.length }
}

export type VerdictById = Omit<ModerationVerdict, "ref"> & { id: string }

/**
 * Applique un passage : `ids` = les connaissances relues (dans l'ordre de la matière), `verdicts` = les décisions de
 * Claude (sans verdict : gardée telle quelle). Une connaissance déjà relue, supprimée entre-temps ou ajoutée par un
 * admin est ignorée. Retire les refusées, corrige les autres, puis avance le curseur après la dernière relue.
 */
export async function applyModerationVerdicts(ids: string[], verdicts: VerdictById[], via: ModerationVia): Promise<ModerationRun> {
  const s = store()
  const cursor = await loadCursor()
  const since = cursor?.at ?? new Date(Date.now() - FIRST_WINDOW_MS).toISOString()
  const found = await Promise.all([...new Set(ids)].map((id) => s.getItem(id)))
  const batch = found.filter((i): i is KnowledgeItem => Boolean(i) && isPending(i!, cursor, since))
  const byId = new Map(verdicts.map((v) => [v.id, v]))
  const refs: ModerationVerdict[] = batch.flatMap((item, n) => {
    const v = byId.get(item.id)
    if (!v) return []
    const { id: _id, ...rest } = v
    return [{ ...rest, ref: n + 1 }]
  })
  const zones = await s.listZones()
  const out = applyModeration(batch, refs, new Set(zones.map((z) => z.id)))

  for (const r of out.rejected) await s.deleteItem(r.item.id)
  const edited = out.kept.filter((k) => k.edited)
  for (const k of edited) await s.updateItem(k.item.id, { title: k.item.title, body: k.item.body, kind: k.item.kind, zone: k.item.zone })

  // Curseur : après la plus récente des connaissances relues (celles arrivées à la même milliseconde sont retenues par id).
  if (batch.length) {
    const last = batch.reduce((m, i) => (i.created_at > m ? i.created_at : m), batch[0].created_at)
    const atLast = batch.filter((i) => i.created_at === last).map((i) => i.id)
    const ids = cursor && cursor.at === last ? [...new Set([...cursor.ids, ...atLast])] : atLast
    await s.setOrgSetting(CURSOR_SETTING, JSON.stringify({ at: last, ids }))
  }

  const profiles = await s.listProfiles()
  const names = new Map(profiles.map((p) => [p.id, p.name]))
  const at = new Date().toISOString()
  const entries: ModerationLogEntry[] = [
    ...edited.map((k) => ({ at, author: names.get(k.item.author_id) ?? "inconnu", zone: k.item.zone, kind: k.item.kind, decision: "edit" as const })),
    ...out.rejected.map((r) => ({
      at,
      author: names.get(r.item.author_id) ?? "inconnu",
      zone: r.item.zone,
      kind: r.item.kind,
      decision: "reject" as const,
      category: r.category,
      ...(r.category === "personnel" || r.category === "secret" || !r.reason ? {} : { reason: truncate(redactText(r.reason), 160) }),
    })),
  ]
  if (entries.length) await s.setOrgSetting(LOG_SETTING, JSON.stringify([...entries, ...(await loadModerationLog())].slice(0, LOG_MAX)))

  // Le fil d'activité montre le modérateur au travail : une ligne par zone, sans rien citer du texte retiré.
  const byZone = new Map<string, ModerationReason[]>()
  for (const r of out.rejected) byZone.set(r.item.zone, [...(byZone.get(r.item.zone) ?? []), r.category])
  const actor = profiles.find((p) => p.role === "admin") ?? profiles[0]
  if (byZone.size && actor) {
    await s.insertEvents(
      [...byZone].map(([zone, reasons]) => ({
        user_id: actor.id,
        agent: "job" as const,
        type: "write" as const,
        zones: [zone],
        summary: `Modérateur : ${reasons.length} connaissance${reasons.length > 1 ? "s" : ""} retirée${reasons.length > 1 ? "s" : ""} (${[...new Set(reasons.map((c) => MODERATION_REASON_LABELS[c]))].join(", ")})`,
        at,
      })),
    )
  }

  const remaining = (await pendingItems()).length
  return recordRun({ at, via, status: batch.length ? "done" : "nothing", reviewed: batch.length, edited: edited.length, rejected: out.rejected.length, remaining })
}

async function recordRun(run: ModerationRun): Promise<ModerationRun> {
  // Les passages à vide (toutes les 15 min) ne remplissent pas l'historique.
  if (run.status !== "nothing" && run.status !== "off") {
    await store().setOrgSetting(RUNS_SETTING, JSON.stringify([run, ...(await loadModerationRuns())].slice(0, RUNS_MAX)))
  }
  return run
}

type Moderate = (input: ModerationInput) => Promise<ModerationVerdict[] | null>

/**
 * Passage fait par le serveur, avec la clé API de l'entreprise (« Lancer maintenant ») : lots de MODERATION_CHUNK relus
 * en parallèle. Seuls les lots relus d'affilée depuis le début comptent : un lot sans réponse (et la suite) attend le
 * passage suivant, pour que le curseur ne saute jamais une connaissance pas relue. `moderate` remplace Claude (tests).
 */
export async function runModeration(moderate?: Moderate): Promise<ModerationRun> {
  const at = new Date().toISOString()
  const material = await moderationInput()
  if ("skipped" in material) return { at, via: "server", status: material.skipped, reviewed: 0, edited: 0, rejected: 0 }
  if (!moderate) {
    const claude = await getClaude()
    if (!claude) return { at, via: "server", status: "no_claude", reviewed: 0, edited: 0, rejected: 0, remaining: material.input.items.length + material.remaining }
    moderate = (input) => moderateKnowledge(claude, input)
  }
  const { input } = material
  const chunks: ModerationInput[] = []
  for (let i = 0; i < input.items.length; i += MODERATION_CHUNK) chunks.push({ ...input, items: input.items.slice(i, i + MODERATION_CHUNK) })
  const answers: (ModerationVerdict[] | null)[] = new Array(chunks.length).fill(null)
  let next = 0
  const worker = async () => {
    while (next < chunks.length) {
      const k = next++
      try {
        answers[k] = await moderate!(chunks[k])
      } catch (err) {
        console.error("[modération]", err instanceof Error ? err.message : err)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, worker))
  const done = answers.findIndex((a) => !a)
  const usable = done === -1 ? chunks.length : done
  if (usable === 0) return recordRun({ at, via: "server", status: "claude_error", reviewed: 0, edited: 0, rejected: 0, remaining: input.items.length + material.remaining })
  const items = chunks.slice(0, usable).flatMap((c) => c.items)
  const refToId = new Map(items.map((i) => [i.ref, i.id!]))
  const verdicts: VerdictById[] = answers
    .slice(0, usable)
    .flatMap((a) => a!)
    .flatMap(({ ref, ...v }) => (refToId.has(ref) ? [{ ...v, id: refToId.get(ref)! }] : []))
  return applyModerationVerdicts(
    items.map((i) => i.id!),
    verdicts,
    "server",
  )
}
