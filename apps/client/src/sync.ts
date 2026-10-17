// brain-sync : sources locales → filtre vie privée → distillation → POST /api/ingest (puis checkpoints).

import { createHash } from "node:crypto"
import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs"
import {
  DISTILL_MARKER,
  chunkConversation,
  classifyZones,
  looksPersonal,
  personalSignals,
  redact,
  redactText,
  truncate,
  type Conversation,
  type KnowledgeItemInput,
  type PersonalSignals,
  type ZoneHint,
} from "@brain/core"
import { BrainApi, type IngestResult, type Workflow } from "./api"
import { refreshCache, zoneHints } from "./cache"
import {
  UserError,
  brainHome,
  claudeDir,
  codexDir,
  ensureHome,
  loadCache,
  loadState,
  paths,
  readJson,
  requireConfig,
  saveState,
  writeJson,
  type Config,
  type SourceName,
  type State,
} from "./config"
import { DISTILLER_LABELS, apiAuthHelp, claudeAuthHelp, createDistiller, finalizeItems, type DistillerKind, type Failure } from "./distill"
import { isBrainSetupText, maskOwnSecrets, ownSecrets } from "./secrets"
import { readClaudeLogs } from "./sources/claude-logs"
import { readCodexLogs } from "./sources/codex-logs"
import { fetchScreenpipeWorkflows, readScreenpipe } from "./sources/screenpipe"
import type { CheckpointCommit, SourceResult } from "./sources/types"

export type SyncOptions = {
  dryRun?: boolean
  since?: string
  source?: SourceName | "all"
  limit?: number
  verbose?: boolean
  distiller?: DistillerKind
  reset?: boolean
  /** Simulation : affiche chaque connaissance en entier (titre et corps complets). */
  full?: boolean
  /** Envoie exactement la dernière simulation (preview.json), sans relire ni redistiller. */
  confirm?: boolean
}

export type Io = { log: (s: string) => void; warn: (s: string) => void }
const defaultIo: Io = { log: (s) => console.log(s), warn: (s) => console.error(s) }

/** "24h", "7d", "30m", "2w" ou une date ISO. */
export function parseSince(s: string | undefined, now = new Date()): Date {
  const v = (s ?? "24h").trim()
  const m = v.match(/^(\d+(?:\.\d+)?)\s*(m|min|h|d|j|w|s)$/i)
  if (m) {
    const n = Number(m[1])
    const unit = m[2].toLowerCase()
    const ms = unit === "s" ? 1000 : unit === "m" || unit === "min" ? 60_000 : unit === "h" ? 3_600_000 : unit === "w" ? 7 * 86_400_000 : 86_400_000
    return new Date(now.getTime() - n * ms)
  }
  const t = Date.parse(v)
  if (!Number.isFinite(t)) throw new Error(`--since invalide : « ${v} » (exemples : 24h, 7d, 2026-10-16T09:00:00Z)`)
  return new Date(t)
}

const LOCK_STALE_MS = 30 * 60_000

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** Verrou fichier : une seule synchro à la fois ; un verrou de plus de 30 min (ou orphelin) est retiré. */
export function acquireLock(file = paths.lock()): { release: () => void } | { busy: string } {
  ensureHome()
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, "wx", 0o600)
      writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }))
      closeSync(fd)
      let released = false
      return {
        release: () => {
          if (released) return
          released = true
          try {
            unlinkSync(file)
          } catch {
            // déjà retiré
          }
        },
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err
      let info: { pid?: number; at?: string } = {}
      try {
        info = JSON.parse(readFileSync(file, "utf8"))
      } catch {
        // verrou illisible
      }
      let age = 0
      try {
        age = Date.now() - statSync(file).mtimeMs
      } catch {
        continue
      }
      const stale = age > LOCK_STALE_MS || (typeof info.pid === "number" && !pidAlive(info.pid))
      if (!stale) return { busy: `pid ${info.pid ?? "?"}, depuis ${Math.round(age / 1000)} s` }
      try {
        unlinkSync(file)
      } catch {
        // course avec un autre processus
      }
    }
  }
  return { busy: "verrou impossible à obtenir" }
}

async function mapPool<T, R>(items: T[], n: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, worker))
  return out
}


/** Conversation écartée par le filtre vie privée (raison, et pour le contenu perso : les indices trouvés). */
export type DroppedConversation = {
  id: string
  reason: string
  ended_at?: string
  /** Contenu personnel : indices trouvés par personalSignals (affichés en simulation et en --verbose). */
  signals?: PersonalSignals
  /** Contenu personnel sur indices faibles seulement : réexaminé tant que la conversation se poursuit. */
  weakOnly?: boolean
}

/**
 * Masque secrets et données perso dans chaque message (y compris les secrets du poste, pris tels quels) ;
 * écarte les conversations perso, vides, internes, ou la session d'installation du cerveau.
 */
export function applyPrivacy(
  convs: Conversation[],
  secrets: string[] = [],
): { kept: Conversation[]; dropped: DroppedConversation[]; redactions: Record<string, number> } {
  const redactions: Record<string, number> = {}
  const kept: Conversation[] = []
  const dropped: DroppedConversation[] = []
  const add = (r: Record<string, number>) => {
    for (const [k, v] of Object.entries(r)) {
      const key = k === "literal" ? "secret_du_poste" : k
      redactions[key] = (redactions[key] ?? 0) + v
    }
  }
  for (const c of convs) {
    const setup = c.messages.some((m) => isBrainSetupText(m.text, secrets))
    const messages = c.messages
      .map((m) => {
        const r = redact(m.text, { literals: secrets })
        add(r.redactions)
        const own = maskOwnSecrets(r.text, secrets)
        if (own.count) redactions.jeton_cerveau = (redactions.jeton_cerveau ?? 0) + own.count
        return { ...m, text: own.text.trim() }
      })
      .filter((m) => m.text)
    const all = messages.map((m) => m.text).join("\n")
    const text = `${c.title ?? ""}\n${all}`
    if (!messages.length || !all.trim()) dropped.push({ id: c.id, reason: "vide" })
    else if (all.includes(DISTILL_MARKER)) dropped.push({ id: c.id, reason: "session interne de distillation" })
    else if (setup) dropped.push({ id: c.id, reason: "session d'installation du cerveau" })
    else if (looksPersonal(text)) {
      const signals = personalSignals(text)
      dropped.push({ id: c.id, reason: "contenu personnel", ended_at: c.ended_at, signals, weakOnly: signals.strong.length === 0 })
    } else kept.push({ ...c, title: c.title ? truncate(maskOwnSecrets(redactText(c.title, { literals: secrets }), secrets).text, 120) : undefined, messages })
  }
  return { kept, dropped, redactions }
}

/** « contenu personnel : divorce, médecin » ou « contenu personnel, indices faibles : whatsapp (vocabulaire pro : 1) ». */
export function describeDrop(d: DroppedConversation): string {
  if (!d.signals) return d.reason
  const s = d.signals
  if (s.strong.length) return `${d.reason} : ${s.strong.slice(0, 5).join(", ")}`
  return `${d.reason}, indices faibles : ${s.weak.slice(0, 5).join(", ") || "?"} (vocabulaire pro : ${s.work})`
}

/** Une conversation écartée sur indices faibles est réexaminée tant qu'elle a bougé depuis moins de ce délai. */
export const PERSONAL_RETRY_MS = 2 * 3_600_000
/**
 * Panne : après ce nombre d'échecs de panne consécutifs (réseau, quotas…), ou d'échecs identiques sans que Claude ait
 * répondu une seule fois (délai, même erreur), Claude n'est plus sollicité pendant la synchro. Une connexion perdue
 * (jeton expiré ou révoqué) arrête tout de suite.
 */
export const MAX_SYSTEMIC_FAILURES = 3
/** Une conversation que Claude n'arrive pas à distiller (échec propre à son contenu) est abandonnée au bout de N essais. */
export const MAX_DISTILL_ATTEMPTS = 3
const FAILURE_TTL_MS = 7 * 86_400_000

const SOURCE_LABELS: Record<SourceName, string> = { claude: "Claude Code", codex: "Codex", screenpipe: "Screenpipe" }
const KIND_LABELS: Record<string, string> = { fact: "fait", decision: "décision", task: "tâche", procedure: "procédure", question: "question" }

function kb(n: number): string {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} Mo` : `${(n / 1024).toFixed(1)} Ko`
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n > 1 ? many : one}`
}

function hhmm(iso: string): string {
  return new Date(iso).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })
}

export type SyncSummary = {
  skipped?: string
  conversations: Partial<Record<SourceName, number>>
  items: KnowledgeItemInput[]
  sent: number
  /** Items que le cerveau avait déjà (dédoublonnage serveur). */
  duplicates?: number
  /** Connaissances réellement insérées, par zone (d'après la réponse du cerveau). */
  zones: Record<string, number>
  distiller: DistillerKind
  deferred: number
  /** Conversations que le LLM n'a pas distillées : rien d'envoyé pour elles, retentées à la prochaine synchro. */
  failed?: number
  /** Ce que la simulation ne montre pas (et que --confirm n'enverra pas). */
  gaps?: string[]
}

/** Ce que `sync --dry-run` a montré, pour que `sync --confirm` envoie exactement cela. */
export type Preview = {
  version: 1
  created_at: string
  url: string
  /** Empreinte de state.json au moment de la simulation : une synchro entre-temps invalide l'aperçu. */
  state_hash: string
  distiller: DistillerKind
  conversations: Partial<Record<SourceName, number>>
  zones: Record<string, number>
  items: KnowledgeItemInput[]
  workflows: Workflow[]
  next_state: State
}

export const PREVIEW_TTL_MS = 24 * 3_600_000
const BATCH = 50

function stateHash(): string {
  try {
    return createHash("sha256").update(readFileSync(paths.state())).digest("hex")
  } catch {
    return "aucun"
  }
}

function removePreview() {
  try {
    unlinkSync(paths.preview())
  } catch {
    // pas d'aperçu
  }
}

function countZones(items: { zone: string }[]): { perZone: Record<string, number>; zoneLine: string } {
  const perZone: Record<string, number> = {}
  for (const i of items) perZone[i.zone] = (perZone[i.zone] ?? 0) + 1
  return { perZone, zoneLine: zoneLineOf(perZone) }
}

function zoneLineOf(perZone: Record<string, number>): string {
  return Object.entries(perZone)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([z, n]) => `${z} : ${n}`)
    .join(", ")
}

/**
 * Répartition par zone des items réellement insérés d'un lot, d'après la réponse du cerveau : `per_zone` s'il le donne,
 * sinon déduite de `inserted` et des zones touchées (`zones`). Null si la réponse ne permet pas de trancher.
 */
export function insertedByZone(batch: { zone: string }[], res: Pick<IngestResult, "inserted" | "zones" | "per_zone">): Record<string, number> | null {
  if (res.per_zone && typeof res.per_zone === "object") return Object.fromEntries(Object.entries(res.per_zone).filter(([, n]) => typeof n === "number" && n > 0))
  if (!(res.inserted > 0)) return {}
  const touched = Array.isArray(res.zones) && res.zones.length ? new Set(res.zones) : null
  if (touched?.size === 1) return { [[...touched][0]]: res.inserted }
  const candidates = touched ? batch.filter((i) => touched.has(i.zone)) : batch
  if (candidates.length === res.inserted) return countZones(candidates).perZone
  return null
}

/** Cumul des insertions par zone sur plusieurs lots ; les lots ambigus sont comptés à part (« compta ou dev : 2 »). */
export class ZoneTally {
  exact: Record<string, number> = {}
  unsure = new Map<string, number>()
  add(batch: { zone: string }[], res: Pick<IngestResult, "inserted" | "zones" | "per_zone">) {
    const by = insertedByZone(batch, res)
    if (by) {
      for (const [z, n] of Object.entries(by)) this.exact[z] = (this.exact[z] ?? 0) + n
      return
    }
    const zones = [...new Set(res.zones?.length ? res.zones : batch.map((i) => i.zone))].sort()
    const key = zones.join(" ou ")
    this.unsure.set(key, (this.unsure.get(key) ?? 0) + res.inserted)
  }
  /** Pour last_sync.zones. */
  record(): Record<string, number> {
    return { ...this.exact, ...Object.fromEntries(this.unsure) }
  }
  line(): string {
    return [zoneLineOf(this.exact), ...[...this.unsure].map(([k, n]) => `${k} : ${n}`)].filter(Boolean).join(", ")
  }
}

function sentLine(sent: number, duplicates: number, zoneLine: string): string {
  return (
    `Envoyé : ${plural(sent, "connaissance")} au cerveau${zoneLine ? ` (${zoneLine})` : ""}` +
    (duplicates ? `, ${plural(duplicates, "déjà connue ignorée", "déjà connues ignorées")} par le cerveau` : "") +
    "."
  )
}

function withLock<T>(io: Io, busy: () => T, fn: () => Promise<T>): Promise<T> {
  const lock = acquireLock()
  if ("busy" in lock) {
    io.log(`Une synchronisation est déjà en cours (${lock.busy}) : on passe.`)
    return Promise.resolve(busy())
  }
  const onSignal = () => {
    lock.release()
    process.exit(130)
  }
  process.once("SIGINT", onSignal)
  process.once("SIGTERM", onSignal)
  return fn().finally(() => {
    process.off("SIGINT", onSignal)
    process.off("SIGTERM", onSignal)
    lock.release()
  })
}

export async function runSync(opts: SyncOptions = {}, io: Io = defaultIo): Promise<SyncSummary> {
  const cfg = requireConfig()
  const skippedSummary = (busy: string): SyncSummary => ({ skipped: busy, conversations: {}, items: [], sent: 0, zones: {}, distiller: "heuristic", deferred: 0 })
  if (opts.confirm) return withLock(io, () => skippedSummary("verrou"), () => confirmPreview(cfg, io))
  if (opts.dryRun) return collectAndSend(cfg, opts, io)
  return withLock(io, () => skippedSummary("verrou"), () => collectAndSend(cfg, opts, io))
}

/** `sync --confirm` : envoie les connaissances de la dernière simulation, telles qu'affichées, puis ses checkpoints. */
async function confirmPreview(cfg: Config, io: Io): Promise<SyncSummary> {
  const preview = readJson<Preview>(paths.preview())
  if (!preview || preview.version !== 1 || !Array.isArray(preview.items)) {
    throw new UserError("Aucune simulation à confirmer : lancez d'abord `sync --dry-run --full`, relisez, puis `sync --confirm`.")
  }
  if (preview.url !== cfg.url) throw new UserError("Cette simulation a été faite pour un autre cerveau : relancez `sync --dry-run --full`.")
  if (!(Date.now() - Date.parse(preview.created_at) < PREVIEW_TTL_MS)) throw new UserError("Simulation de plus de 24 h : relancez `sync --dry-run --full`.")
  if (stateHash() !== preview.state_hash) {
    throw new UserError("Une synchronisation a eu lieu depuis la simulation : relancez `sync --dry-run --full` pour voir ce qui reste à envoyer.")
  }
  const api = new BrainApi(cfg.url, cfg.token)
  io.log(`brain-sync — envoi de la simulation du ${new Date(preview.created_at).toLocaleString("fr-FR")} (${plural(preview.items.length, "connaissance")}, à l'identique).`)
  let sent = 0
  let duplicates = 0
  const tally = new ZoneTally()
  try {
    for (let i = 0; i < preview.items.length; i += BATCH) {
      const batch = preview.items.slice(i, i + BATCH)
      const res = await api.ingest(batch, "brain-sync")
      sent += res.inserted
      duplicates += res.skipped ?? 0
      tally.add(batch, res)
    }
  } catch (err) {
    io.warn(`Envoi interrompu après ${plural(sent, "connaissance")} : relancez \`sync --confirm\` (ce que le cerveau a déjà reçu sera ignoré).`)
    throw err
  }
  if (preview.workflows?.length) {
    try {
      const r = await api.automations(preview.workflows)
      io.log(`Automatisations : ${plural(r.saved, "workflow Screenpipe remonté", "workflows Screenpipe remontés")}.`)
    } catch (err) {
      io.warn(`Automatisations non remontées : ${(err as Error).message}`)
    }
  }
  const zones = tally.record()
  const next: State = preview.next_state ?? {}
  next.last_sync = { at: new Date().toISOString(), distiller: preview.distiller, items_sent: sent, conversations: preview.conversations, zones }
  saveState(next)
  removePreview()
  io.log(sentLine(sent, duplicates, tally.line()))
  return { conversations: preview.conversations, items: preview.items, sent, duplicates, zones, distiller: preview.distiller, deferred: 0 }
}

async function collectAndSend(cfg: Config, opts: SyncOptions, io: Io): Promise<SyncSummary> {
  const api = new BrainApi(cfg.url, cfg.token)
  const verbose = Boolean(opts.verbose)
  const full = Boolean(opts.full) || verbose
  const limit = Math.max(1, opts.limit ?? 30)
  const explicitSince = Boolean(opts.since)
  const wanted: SourceName[] = !opts.source || opts.source === "all" ? cfg.sources : [opts.source]
  const secrets = ownSecrets(cfg)
  const baseState = loadState()
  // Après install-schedule, rien d'antérieur à la mise en place qui n'ait déjà été relu (sauf --since explicite),
  // pour toutes les sources : fichiers déjà suivis compris, et Screenpipe même avec un ancien checkpoint.
  const baseline = !explicitSince && baseState.baseline_at && Number.isFinite(Date.parse(baseState.baseline_at)) ? new Date(baseState.baseline_at) : undefined
  let since = parseSince(opts.since)
  if (baseline && baseline.getTime() > since.getTime()) since = baseline

  io.log(`brain-sync — ${new Date().toLocaleString("fr-FR")}${opts.dryRun ? " (simulation : rien ne sera envoyé)" : ""}`)

  // 1. Zones (toutes, avec mots-clés) — repli sur le cache.
  const { cache, errors } = await refreshCache(api)
  if (errors.length) io.warn(`Attention : ${errors[0]} — zones lues depuis le cache local.`)
  const zones: ZoneHint[] = zoneHints(cache.zones ? cache : loadCache())
  const defaultZone = cache.whoami?.writable[0] ?? zones[0]?.id ?? "general"

  const distiller = await createDistiller(cfg, opts.distiller)
  io.log(`Distillation : ${DISTILLER_LABELS[distiller.kind]} — ${distiller.reason}`)

  // 2. Sources.
  const state = baseState
  const results: SourceResult[] = []
  if (wanted.includes("claude"))
    results.push(readClaudeLogs({ dir: claudeDir(), state, since, explicitSince, reset: opts.reset, brainHome: brainHome(), secrets, floor: baseline }))
  if (wanted.includes("codex")) results.push(readCodexLogs({ dir: codexDir(), state, since, explicitSince, reset: opts.reset, secrets, floor: baseline }))
  let workflows: Workflow[] = []
  let workflowsDropped = 0
  if (wanted.includes("screenpipe")) {
    const sp = await readScreenpipe({
      url: cfg.screenpipe_url,
      token: cfg.screenpipe_token,
      state: opts.reset ? {} : state,
      since,
      explicitSince,
      baseline,
      contentTypes: cfg.screenpipe_content_types,
      whitelist: cfg.app_whitelist,
    })
    results.push(sp)
    if (sp.available) {
      const wf = await fetchScreenpipeWorkflows(cfg.screenpipe_url, cfg.screenpipe_token, zones, { whitelist: cfg.app_whitelist, literals: secrets })
      workflows = wf.workflows.map((w) => ({ ...w, title: maskOwnSecrets(w.title, secrets).text, description: maskOwnSecrets(w.description, secrets).text }))
      workflowsDropped = wf.dropped
    }
  }

  io.log("Sources :")
  for (const r of results) {
    const label = SOURCE_LABELS[r.source]
    if (!r.available) io.log(`  - ${label} : ${r.source === "screenpipe" ? "indisponible, ignoré" : "aucun log trouvé"}`)
    else {
      const extra =
        r.source === "screenpipe"
          ? `${r.stats.items ?? 0} captures, type « ${r.stats.content_type ?? "?"} »`
          : `${plural(Number(r.stats.files ?? 0), "fichier")} lu${Number(r.stats.files) > 1 ? "s" : ""}, ${kb(Number(r.stats.bytes ?? 0))}` +
            (Number(r.stats.internal) ? `, ${r.stats.internal} session(s) interne(s) ignorée(s)` : "") +
            (Number(r.stats.pending) ? `, ${plural(Number(r.stats.pending), "tour en cours", "tours en cours")} lu(s) au prochain passage` : "")
      const nothing = r.source !== "screenpipe" && !Number(r.stats.files) && r.conversations.length === 0
      io.log(`  - ${label} : ${nothing ? "rien de nouveau depuis la dernière synchro" : `${plural(r.conversations.length, "conversation")} (${extra})`}`)
    }
    for (const w of r.warnings) io.warn(`    ${w}`)
  }

  // 3. Vie privée.
  const now = Date.now()
  const all = results.flatMap((r) => r.conversations)
  const privacy = applyPrivacy(all, secrets)
  const totalRedactions = Object.values(privacy.redactions).reduce((a, b) => a + b, 0)
  const personalDrops = privacy.dropped.filter((d) => d.reason === "contenu personnel")
  // Indices faibles seulement, conversation encore active : pas marquée comme traitée, elle sera réexaminée en entier.
  const retry = new Set(personalDrops.filter((d) => d.weakOnly && d.ended_at && now - Date.parse(d.ended_at) < PERSONAL_RETRY_MS).map((d) => d.id))
  io.log(
    `Vie privée : ${plural(totalRedactions, "élément masqué", "éléments masqués")}` +
      (verbose && totalRedactions ? ` (${Object.entries(privacy.redactions).map(([k, v]) => `${k} : ${v}`).join(", ")})` : "") +
      `, ${plural(personalDrops.length, "conversation perso écartée", "conversations perso écartées")}`,
  )
  const shownDrops = verbose ? privacy.dropped : opts.dryRun ? personalDrops.slice(0, 20) : []
  for (const d of shownDrops) io.log(`    écartée : ${d.id} (${describeDrop(d)}${retry.has(d.id) ? " ; réexaminée à la prochaine synchro tant qu'elle se poursuit" : ""})`)
  if (!verbose && opts.dryRun && personalDrops.length > shownDrops.length) io.log(`    … et ${personalDrops.length - shownDrops.length} autre(s) (--verbose pour tout voir)`)

  // 4. Distillation, des plus anciennes aux plus récentes, dans la limite de --limit segments.
  const processed = new Set(privacy.dropped.filter((d) => !retry.has(d.id)).map((d) => d.id))
  const queue = [...privacy.kept].sort((a, b) => a.ended_at.localeCompare(b.ended_at))
  const jobs: { conv: Conversation; chunk: Conversation }[] = []
  let budget = limit
  let deferred = 0
  let cutChunks = 0
  for (const conv of queue) {
    let chunks = chunkConversation(conv)
    if (chunks.length > budget) {
      if (jobs.length > 0) {
        deferred = queue.length - queue.indexOf(conv)
        break
      }
      cutChunks += chunks.length - budget
      chunks = chunks.slice(-budget)
    }
    budget -= chunks.length
    processed.add(conv.id)
    for (const chunk of chunks) jobs.push({ conv, chunk })
    if (budget <= 0) {
      deferred = queue.length - queue.indexOf(conv) - 1
      break
    }
  }
  if (deferred > 0 && !opts.dryRun) io.log(`Limite de ${limit} segments atteinte : ${plural(deferred, "conversation")} reportée(s) à la prochaine synchro.`)

  // Un échec du LLM ne retombe jamais sur l'heuristique : la conversation n'est pas traitée et sera redistillée plus tard.
  // Les conversations qui ont déjà échoué passent après les autres : une réussite montre d'abord que Claude fonctionne.
  const prevFailures = baseState.distill_failures ?? {}
  const order = jobs.map((_, i) => i).sort((a, b) => Number(Boolean(prevFailures[jobs[a].conv.id])) - Number(Boolean(prevFailures[jobs[b].conv.id])) || a - b)
  const distilled: KnowledgeItemInput[][] = jobs.map(() => [])
  const failedConvs = new Map<string, Failure>()
  const untried = new Set<string>()
  /** Appels où Claude a répondu (réussite, ou refus / sortie illisible) : la CLI et la connexion fonctionnent. */
  let alive = 0
  let outageStreak = 0
  /** Échecs sans réponse du modèle (délai, erreur inconnue), par conversation : tous identiques et rien d'autre = panne. */
  const blind = new Map<string, string>()
  let stop: "auth" | "outage" | "same" | null = null
  const sameWay = () => alive === 0 && blind.size >= MAX_SYSTEMIC_FAILURES && new Set(blind.values()).size === 1
  await mapPool(order, distiller.concurrency, async (i) => {
    const { conv, chunk } = jobs[i]
    if (failedConvs.has(conv.id) || untried.has(conv.id)) return
    if (stop) {
      untried.add(conv.id)
      return
    }
    const text = chunk.messages.map((m) => m.text).join("\n")
    const fallbackZone = classifyZones(text, zones, 1)[0] ?? defaultZone
    const res = await distiller.distill(chunk, zones, fallbackZone)
    if (res.failed) {
      const f: Failure = { error: maskOwnSecrets(res.error ?? "échec", secrets).text, failure: res.failure ?? "conversation", signature: res.signature }
      failedConvs.set(conv.id, f)
      if (f.failure === "auth") stop = "auth"
      else if (f.failure === "outage") {
        if (++outageStreak >= MAX_SYSTEMIC_FAILURES) stop ??= "outage"
      } else if (f.signature) {
        blind.set(conv.id, f.signature)
        if (sameWay()) stop ??= "same"
      } else alive++
    } else {
      alive++
      outageStreak = 0
      distilled[i] = res.items
    }
    if (verbose) io.log(`    ${conv.tool} ${truncate(conv.title ?? conv.id, 60)} → ${res.failed ? `échec (${truncate(res.error ?? "?", 120)})` : plural(res.items.length, "item")} (${DISTILLER_LABELS[res.used]})`)
  })
  for (const id of untried) if (failedConvs.has(id)) untried.delete(id)
  const notDistilled = new Set([...failedConvs.keys(), ...untried])

  // Échecs propres à une conversation (refus, sortie illisible, délai, erreur de la requête) : décomptés, et la
  // conversation est abandonnée au bout de MAX_DISTILL_ATTEMPTS essais (rien n'est envoyé) pour ne jamais bloquer la file
  // ni le checkpoint Screenpipe. Une panne (connexion perdue, CLI absente, réseau, quotas, ou tous les appels qui échouent
  // de la même façon sans que Claude réponde jamais) n'est pas décomptée.
  const failures = [...failedConvs.values()]
  const authFailure = failures.find((f) => f.failure === "auth")
  const outage = alive === 0 && (failures.some((f) => f.failure !== "conversation") || sameWay())
  const failuresNext: NonNullable<State["distill_failures"]> = {}
  for (const [id, f] of Object.entries(prevFailures)) if (now - Date.parse(f.at) < FAILURE_TTL_MS) failuresNext[id] = f
  const givenUp: string[] = []
  const counted: { id: string; n: number }[] = []
  for (const [id, f] of failedConvs) {
    if (f.failure !== "conversation") continue // panne : l'historique éventuel est gardé tel quel
    const n = (prevFailures[id]?.n ?? 0) + (outage ? 0 : 1)
    if (n >= MAX_DISTILL_ATTEMPTS) {
      givenUp.push(id)
      delete failuresNext[id]
      continue
    }
    // n = 0 : échec non décompté (panne), mais la conversation passera après les autres la prochaine fois.
    failuresNext[id] = { n, at: new Date(now).toISOString(), error: truncate(f.error, 200) }
    if (!outage) counted.push({ id, n })
  }
  for (const id of notDistilled) processed.delete(id)
  if (!opts.dryRun) for (const id of givenUp) processed.add(id)
  for (const id of processed) delete failuresNext[id]

  const retried = notDistilled.size - (opts.dryRun ? 0 : givenUp.length)
  const them = (n: number, one: string, many: string) => (n > 1 ? many : one)
  if (authFailure) {
    io.warn(`  ${distiller.kind === "claude-api" ? apiAuthHelp(authFailure.error) : claudeAuthHelp(authFailure.error)}`)
    io.warn(
      `  Distillation interrompue : ${plural(notDistilled.size, "conversation non distillée", "conversations non distillées")}. ` +
        `Rien n'est envoyé pour ${them(notDistilled.size, "elle", "elles")} et l'heuristique n'est pas utilisée à la place : ` +
        `${them(notDistilled.size, "elle sera distillée", "elles seront distillées")} à la prochaine synchro, une fois Claude reconnecté (aucun essai décompté).`,
    )
  } else if (notDistilled.size) {
    const first = (failures.find((f) => f.failure !== "conversation") ?? failures[0])?.error ?? "?"
    const why = outage
      ? ` Panne générale (${failures.some((f) => f.failure === "outage") ? "Claude injoignable ou saturé" : "tous les appels échouent de la même façon"}) : aucun essai n'est décompté. ` +
        "Vérifiez que `claude -p` fonctionne (connexion, quotas ; `init --claude-token`) ou distillez sans LLM avec --distiller heuristic."
      : counted.length
        ? ` Échec lié au contenu de ${plural(counted.length, "conversation")} (essai ${Math.max(...counted.map((c) => c.n))}/${MAX_DISTILL_ATTEMPTS}) :` +
          ` au bout de ${MAX_DISTILL_ATTEMPTS} essais, ${them(counted.length, "elle sera abandonnée", "elles seront abandonnées")} sans rien envoyer, pour ne pas bloquer la synchro.`
        : ""
    io.warn(
      `  Distillation : ${plural(notDistilled.size, "conversation non distillée", "conversations non distillées")} par ${DISTILLER_LABELS[distiller.kind]}` +
        ` (${truncate(first, 160)})${untried.size ? `, dont ${untried.size} non tentée(s) (Claude indisponible)` : ""}.` +
        (retried > 0
          ? ` Rien n'est envoyé pour ${them(retried, "elle", "elles")} et l'heuristique n'est pas utilisée à la place : ${them(retried, "elle sera retentée", "elles seront retentées")} à la prochaine synchro.`
          : "") +
        why,
    )
  }
  if (verbose) for (const [id, f] of failedConvs) io.log(`    non distillée : ${id} (${truncate(f.error, 160)})`)
  if (givenUp.length && !opts.dryRun)
    io.warn(
      `  ${plural(givenUp.length, "conversation abandonnée", "conversations abandonnées")} après ${MAX_DISTILL_ATTEMPTS} essais infructueux : ` +
        `rien n'a été envoyé pour ${them(givenUp.length, "elle", "elles")}, la synchro continue sans ${them(givenUp.length, "elle", "elles")} (checkpoints avancés).`,
    )

  // Items rangés par conversation (dans l'ordre de traitement) : une conversation est « faite » quand tous ses items sont partis.
  const byConv = new Map<string, KnowledgeItemInput[]>()
  jobs.forEach((j, n) => {
    if (notDistilled.has(j.conv.id)) return
    byConv.set(j.conv.id, [...(byConv.get(j.conv.id) ?? []), ...distilled[n]])
  })
  const seenKeys = new Set<string>()
  const flat: { item: KnowledgeItemInput; conv: string; last: boolean }[] = []
  for (const [conv, list] of byConv) {
    const kept = finalizeItems(list, seenKeys, secrets)
    kept.forEach((item, n) => flat.push({ item, conv, last: n === kept.length - 1 }))
  }
  const items = flat.map((f) => f.item)
  const { perZone, zoneLine } = countZones(items)
  const convCounts: Partial<Record<SourceName, number>> = {}
  for (const r of results) convCounts[r.source] = r.conversations.length

  const commits = results.flatMap((r) => r.commits)

  // Ce que l'aperçu ne contient pas : dit clairement (rien de tout cela ne partira avec --confirm).
  const gaps: string[] = []
  if (deferred > 0) gaps.push(`${plural(deferred, "conversation reportée", "conversations reportées")} : limite de ${limit} segments atteinte (--limit N pour en voir plus)`)
  if (cutChunks > 0) gaps.push(`${plural(cutChunks, "segment ancien", "segments anciens")} d'une très longue conversation, ignoré${cutChunks > 1 ? "s" : ""} (seuls les ${limit} derniers sont lus)`)
  for (const r of results) {
    if (r.source === "screenpipe" && r.available && r.stats.truncated_until) gaps.push(`Screenpipe : captures lues jusqu'au ${hhmm(String(r.stats.truncated_until))} seulement (la suite n'a pas été lue)`)
    if (Number(r.stats.pending)) gaps.push(`${SOURCE_LABELS[r.source]} : ${plural(Number(r.stats.pending), "tour de conversation en cours", "tours de conversation en cours")} (réponse pas encore écrite)`)
  }
  if (notDistilled.size) gaps.push(`${plural(notDistilled.size, "conversation que Claude n'a pas distillée", "conversations que Claude n'a pas distillées")}`)
  if (retry.size)
    gaps.push(
      retry.size > 1
        ? `${retry.size} conversations écartées pour l'instant (indices personnels faibles), réexaminées si elles se poursuivent`
        : "1 conversation écartée pour l'instant (indices personnels faibles), réexaminée si elle se poursuit",
    )

  // 5. Simulation : on montre tout ce qui partirait, on n'envoie rien, on n'avance pas les checkpoints.
  if (opts.dryRun) {
    io.log("")
    io.log(`[simulation] ${plural(items.length, "connaissance")} serai${items.length > 1 ? "en" : ""}t envoyée${items.length > 1 ? "s" : ""}${zoneLine ? ` (${zoneLine})` : ""} :`)
    let abridged = false
    items.forEach((i, n) => {
      io.log(`  ${n + 1}. [${i.zone}] ${KIND_LABELS[i.kind] ?? i.kind} — ${i.title}`)
      if (full) for (const l of i.body.trim().split("\n")) io.log(`     ${l}`)
      else {
        const flatBody = i.body.replace(/\s+/g, " ").trim()
        if (flatBody.length > 220) abridged = true
        io.log(`     ${truncate(flatBody, 220)}`)
      }
    })
    if (workflows.length) {
      io.log(`[simulation] ${plural(workflows.length, "workflow répétitif", "workflows répétitifs")} Screenpipe serai${workflows.length > 1 ? "en" : ""}t remonté(s) :`)
      workflows.forEach((w, n) => {
        io.log(`  W${n + 1}. ${w.title}${w.zone ? ` [${w.zone}]` : ""} — ${w.occurrences} fois sur ${plural(w.days, "jour")}${w.schedule ? `, vers ${w.schedule}` : ""}`)
        if (w.description) io.log(`     ${w.description}`)
      })
    }
    if (workflowsDropped) io.log(`  ${plural(workflowsDropped, "workflow Screenpipe écarté", "workflows Screenpipe écartés")} (app hors liste blanche ou contenu personnel).`)
    if (abridged) io.log("Textes abrégés : ajoutez --full pour voir chaque connaissance en entier.")
    if (gaps.length) {
      io.log("")
      io.log("Attention, aperçu partiel : ceci n'y figure pas, et ne partira pas avec sync --confirm :")
      for (const g of gaps) io.log(`  - ${g}`)
      io.log(
        "Pour le relire : sync --confirm, puis relancez sync --dry-run --full. Après install-schedule, ce qui n'a pas été relu n'est jamais envoyé.",
      )
    }
    // L'aperçu exact, pour `sync --confirm` (mêmes items, mêmes checkpoints).
    const next = structuredClone(loadState())
    for (const c of commits) if (c.covers.every((id) => processed.has(id))) c.apply(next)
    delete next.last_sync
    const preview: Preview = {
      version: 1,
      created_at: new Date().toISOString(),
      url: cfg.url,
      state_hash: stateHash(),
      distiller: distiller.kind,
      conversations: convCounts,
      zones: perZone,
      items,
      workflows,
      next_state: next,
    }
    ensureHome()
    writeJson(paths.preview(), preview, 0o600)
    io.log("Rien n'a été envoyé (simulation). Pour envoyer exactement ce qui est affiché : sync --confirm (valable 24 h).")
    return { conversations: convCounts, items, sent: 0, zones: perZone, distiller: distiller.kind, deferred, failed: notDistilled.size, gaps }
  }

  // 6. Envoi par lots de 50 ; après chaque lot, les checkpoints des conversations entièrement envoyées sont enregistrés.
  const withItems = new Set(flat.map((f) => f.conv))
  const done = new Set([...processed].filter((id) => !withItems.has(id)))
  const applied = new Set<CheckpointCommit>()
  const checkpoint = (): State => {
    const next = loadState()
    for (const c of commits) {
      if (applied.has(c) || !c.covers.every((id) => done.has(id))) continue
      c.apply(next)
      applied.add(c)
    }
    if (Object.keys(failuresNext).length) next.distill_failures = failuresNext
    else delete next.distill_failures
    return next
  }
  let sent = 0
  let duplicates = 0
  const tally = new ZoneTally()
  try {
    for (let i = 0; i < flat.length; i += BATCH) {
      const batch = flat.slice(i, i + BATCH)
      const res = await api.ingest(batch.map((b) => b.item), "brain-sync")
      sent += res.inserted
      duplicates += res.skipped ?? 0
      tally.add(batch.map((b) => b.item), res)
      for (const b of batch) if (b.last) done.add(b.conv)
      saveState(checkpoint())
    }
  } catch (err) {
    if (sent || duplicates) io.warn(`Envoi interrompu : ${plural(sent, "connaissance")} déjà envoyée(s) et enregistrée(s) ; la prochaine synchro reprendra la suite.`)
    throw err
  }
  if (workflows.length) {
    try {
      const r = await api.automations(workflows)
      io.log(`Automatisations : ${plural(r.saved, "workflow Screenpipe remonté", "workflows Screenpipe remontés")}.`)
    } catch (err) {
      io.warn(`Automatisations non remontées : ${(err as Error).message}`)
    }
  }
  const sentZones = tally.record()
  const next = checkpoint()
  next.last_sync = { at: new Date().toISOString(), distiller: distiller.kind, items_sent: sent, conversations: convCounts, zones: sentZones }
  saveState(next)
  removePreview()
  io.log(sentLine(sent, duplicates, tally.line()))
  return { conversations: convCounts, items, sent, duplicates, zones: sentZones, distiller: distiller.kind, deferred, failed: notDistilled.size }
}
