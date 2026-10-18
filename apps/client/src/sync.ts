// brain-sync: local sources → privacy filter → distillation → POST /api/ingest (then checkpoints).

import { createHash } from "node:crypto"
import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs"
import {
  DISTILL_MARKER,
  chunkConversation,
  classifyZones,
  documentBaseName,
  formatBytes,
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
import { AGENT_ENGINE_LABELS, agentWindow, pickAgentEngine, runScreenpipeAgent, type AgentResult } from "./agent"
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
import { documentCandidate, documentsLine, readDocument, sendDocuments, type DocumentJob, type DocumentOutcome } from "./documents"
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
  /** Dry run: shows each knowledge item in full (complete title and body). */
  full?: boolean
  /** Sends exactly the last dry run (preview.json), without reading or distilling again. */
  confirm?: boolean
}

export type Io = { log: (s: string) => void; warn: (s: string) => void }
const defaultIo: Io = { log: (s) => console.log(s), warn: (s) => console.error(s) }

/** "24h", "7d", "30m", "2w" or an ISO date. */
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
  if (!Number.isFinite(t)) throw new Error(`Invalid --since: "${v}" (examples: 24h, 7d, 2026-10-16T09:00:00Z)`)
  return new Date(t)
}

export const LOCK_STALE_MS = 30 * 60_000

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** File lock: one sync at a time; a lock older than 30 min (or orphaned) is removed. */
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
            // already removed
          }
        },
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err
      let info: { pid?: number; at?: string } = {}
      try {
        info = JSON.parse(readFileSync(file, "utf8"))
      } catch {
        // unreadable lock
      }
      let age = 0
      try {
        age = Date.now() - statSync(file).mtimeMs
      } catch {
        continue
      }
      const stale = age > LOCK_STALE_MS || (typeof info.pid === "number" && !pidAlive(info.pid))
      if (!stale) return { busy: `pid ${info.pid ?? "?"}, for ${Math.round(age / 1000)} s` }
      try {
        unlinkSync(file)
      } catch {
        // race with another process
      }
    }
  }
  return { busy: "cannot get the lock" }
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


/** Conversation dropped by the privacy filter (reason, and for personal content: the signals found). */
export type DroppedConversation = {
  id: string
  reason: string
  ended_at?: string
  /** Personal content: signals found by personalSignals (shown in dry runs and with --verbose). */
  signals?: PersonalSignals
  /** Personal content on weak signals only: examined again as long as the conversation goes on. */
  weakOnly?: boolean
}

/**
 * Redacts secrets and personal data in each message (including the computer's secrets, taken as is);
 * drops personal, empty or internal conversations, or the brain's install session.
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
    if (!messages.length || !all.trim()) dropped.push({ id: c.id, reason: "empty" })
    else if (all.includes(DISTILL_MARKER)) dropped.push({ id: c.id, reason: "internal distillation session" })
    else if (setup) dropped.push({ id: c.id, reason: "brain install session" })
    else if (looksPersonal(text)) {
      const signals = personalSignals(text)
      dropped.push({ id: c.id, reason: "personal content", ended_at: c.ended_at, signals, weakOnly: signals.strong.length === 0 })
    } else kept.push({ ...c, title: c.title ? truncate(maskOwnSecrets(redactText(c.title, { literals: secrets }), secrets).text, 120) : undefined, messages })
  }
  return { kept, dropped, redactions }
}

/** "personal content: divorce, doctor" or "personal content, weak signals: whatsapp (work vocabulary: 1)". */
export function describeDrop(d: DroppedConversation): string {
  if (!d.signals) return d.reason
  const s = d.signals
  if (s.strong.length) return `${d.reason}: ${s.strong.slice(0, 5).join(", ")}`
  return `${d.reason}, weak signals: ${s.weak.slice(0, 5).join(", ") || "?"} (work vocabulary: ${s.work})`
}

/** A conversation dropped on weak signals is examined again as long as it moved less than this long ago. */
export const PERSONAL_RETRY_MS = 2 * 3_600_000
/**
 * Outage: after this many consecutive outage failures (network, subscription limit…), or identical failures without
 * Claude having answered even once (timeout, same error), Claude is no longer called during the sync. A lost
 * sign-in (expired or revoked token) stops everything right away.
 */
export const MAX_SYSTEMIC_FAILURES = 3
/**
 * A conversation Claude cannot distill is given up (nothing is sent) after N conclusive attempts:
 * the model answered without usable JSON (refusal, unreadable output), or the call failed (timeout, unknown error)
 * during a sync where Claude answered another call. A recognized outage (lost sign-in, network, subscription
 * limit, overload) is never counted.
 */
export const MAX_DISTILL_ATTEMPTS = 3
/**
 * Safeguard against blocking: a failure that proves nothing (timeout or unknown error, without any other call of the
 * sync getting an answer) only makes a conversation be given up if its failures have lasted at least 24 h,
 * over at least 5 attempts. A subscription limit (5 h) therefore gives up nothing, and a truly stuck conversation
 * frees the checkpoint (Screenpipe included) within a day.
 */
export const STUCK_ABANDON_MS = 24 * 3_600_000
export const STUCK_ABANDON_TRIES = 5
const FAILURE_TTL_MS = 7 * 86_400_000

const SOURCE_LABELS: Record<SourceName, string> = { claude: "Claude Code", codex: "Codex", screenpipe: "Screenpipe" }
const KIND_LABELS: Record<string, string> = { fact: "fact", decision: "decision", task: "task", procedure: "procedure", question: "question" }

function kb(n: number): string {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${(n / 1024).toFixed(1)} KB`
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

function hhmm(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })
}

export type SyncSummary = {
  skipped?: string
  conversations: Partial<Record<SourceName, number>>
  items: KnowledgeItemInput[]
  sent: number
  /** Items the brain already had (server deduplication). */
  duplicates?: number
  /** Knowledge actually inserted, per zone (according to the brain's response). */
  zones: Record<string, number>
  distiller: DistillerKind
  deferred: number
  /** Conversations the LLM did not distill: nothing sent for them, retried on the next sync. */
  failed?: number
  /** What the dry run does not show (and that --confirm will not send). */
  gaps?: string[]
  /** Documents sent with the knowledge (or kept on the computer, and why). */
  documents?: DocumentOutcome[]
}

/** Documents of a session, to send with its knowledge: indexes of its items in the list sent. */
export type PlannedDocument = { path: string; items: number[]; source: DocumentJob["source"] }

/** What `sync --dry-run` showed, so that `sync --confirm` sends exactly that. */
export type Preview = {
  version: 1
  created_at: string
  url: string
  /** Fingerprint of state.json at dry-run time: a sync in between invalidates the preview. */
  state_hash: string
  distiller: DistillerKind
  conversations: Partial<Record<SourceName, number>>
  zones: Record<string, number>
  items: KnowledgeItemInput[]
  workflows: Workflow[]
  /** Missing from a dry run made before documents. */
  documents?: PlannedDocument[]
  next_state: State
}

export const PREVIEW_TTL_MS = 24 * 3_600_000
const BATCH = 50

function stateHash(): string {
  try {
    return createHash("sha256").update(readFileSync(paths.state())).digest("hex")
  } catch {
    return "none"
  }
}

function removePreview() {
  try {
    unlinkSync(paths.preview())
  } catch {
    // no preview
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
    .map(([z, n]) => `${z}: ${n}`)
    .join(", ")
}

/**
 * Per-zone breakdown of a batch's items actually inserted, according to the brain's response: `per_zone` if it gives it,
 * otherwise deduced from `inserted` and the zones touched (`zones`). Null if the response does not settle it.
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

/** Total insertions per zone over several batches; ambiguous batches are counted separately ("finance or dev: 2"). */
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
    const key = zones.join(" or ")
    this.unsure.set(key, (this.unsure.get(key) ?? 0) + res.inserted)
  }
  /** For last_sync.zones. */
  record(): Record<string, number> {
    return { ...this.exact, ...Object.fromEntries(this.unsure) }
  }
  line(): string {
    return [zoneLineOf(this.exact), ...[...this.unsure].map(([k, n]) => `${k}: ${n}`)].filter(Boolean).join(", ")
  }
}

function sentLine(sent: number, duplicates: number, zoneLine: string): string {
  return (
    `Sent: ${plural(sent, "knowledge item")} to the brain${zoneLine ? ` (${zoneLine})` : ""}` +
    (duplicates ? `, ${plural(duplicates, "already known item skipped", "already known items skipped")} by the brain` : "") +
    "."
  )
}

/**
 * The documents each session worked on, sent with ITS knowledge (a session that gave nothing sends nothing).
 * `flat`: the items in sending order, with their conversation.
 */
export function planDocuments(flat: { item: KnowledgeItemInput; conv: string }[], convs: Map<string, Conversation>): PlannedDocument[] {
  const out: PlannedDocument[] = []
  const indexes = new Map<string, number[]>()
  flat.forEach((f, n) => indexes.set(f.conv, [...(indexes.get(f.conv) ?? []), n]))
  for (const [id, items] of indexes) {
    const conv = convs.get(id)
    if (!conv?.documents?.length) continue
    for (const path of conv.documents) out.push({ path, items, source: { app: conv.app, tool: conv.tool, at: conv.ended_at } })
  }
  return out
}

/** Sending jobs, once the brain gave the id of each item (`ids`, same order as the items sent). */
function documentJobs(planned: PlannedDocument[], ids: (string | null)[], items: KnowledgeItemInput[]): DocumentJob[] {
  return planned.flatMap((d) => {
    const linked = d.items.map((i) => ids[i]).filter((x): x is string => typeof x === "string")
    if (!linked.length) return []
    return [{ path: d.path, item_ids: linked, zone: items[d.items[0]]?.zone, source: d.source }]
  })
}

/** Sends the documents with the knowledge just sent; never fails the sync (each document reports its own outcome). */
async function sendPlannedDocuments(api: BrainApi, planned: PlannedDocument[], ids: (string | null)[], items: KnowledgeItemInput[], state: State, io: Io, verbose: boolean) {
  const jobs = documentJobs(planned, ids, items)
  if (!jobs.length) return []
  let outcomes: DocumentOutcome[] = []
  try {
    outcomes = await sendDocuments(api, jobs, state, { brainHome: brainHome() })
  } catch (err) {
    io.warn(`Documents not sent: ${(err as Error).message}`)
    return []
  }
  const line = documentsLine(outcomes)
  if (line) io.log(`Documents: ${line}.`)
  if (verbose) for (const o of outcomes) io.log(`    ${o.status}: ${o.name}${"reason" in o ? ` (${o.reason})` : ` → ${o.zone}`}`)
  return outcomes
}

function withLock<T>(io: Io, busy: () => T, fn: () => Promise<T>): Promise<T> {
  const lock = acquireLock()
  if ("busy" in lock) {
    io.log(`A sync is already in progress (${lock.busy}): skipping.`)
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
  if (opts.confirm) return withLock(io, () => skippedSummary("lock"), () => confirmPreview(cfg, io))
  if (opts.dryRun) return collectAndSend(cfg, opts, io)
  return withLock(io, () => skippedSummary("lock"), () => collectAndSend(cfg, opts, io))
}

/** `sync --confirm`: sends the knowledge of the last dry run, as shown, then its checkpoints. */
async function confirmPreview(cfg: Config, io: Io): Promise<SyncSummary> {
  const preview = readJson<Preview>(paths.preview())
  if (!preview || preview.version !== 1 || !Array.isArray(preview.items)) {
    throw new UserError("No dry run to confirm: first run `sync --dry-run --full`, review it, then `sync --confirm`.")
  }
  if (preview.url !== cfg.url) throw new UserError("This dry run was made for another brain: run `sync --dry-run --full` again.")
  if (!(Date.now() - Date.parse(preview.created_at) < PREVIEW_TTL_MS)) throw new UserError("Dry run older than 24 h: run `sync --dry-run --full` again.")
  if (stateHash() !== preview.state_hash) {
    throw new UserError("A sync happened since the dry run: run `sync --dry-run --full` again to see what is left to send.")
  }
  const api = new BrainApi(cfg.url, cfg.token)
  io.log(`brain-sync — sending the dry run of ${new Date(preview.created_at).toLocaleString("en-GB")} (${plural(preview.items.length, "knowledge item")}, unchanged).`)
  let sent = 0
  let duplicates = 0
  const tally = new ZoneTally()
  const ids: (string | null)[] = []
  try {
    for (let i = 0; i < preview.items.length; i += BATCH) {
      const batch = preview.items.slice(i, i + BATCH)
      const res = await api.ingest(batch, "brain-sync")
      sent += res.inserted
      duplicates += res.skipped ?? 0
      tally.add(batch, res)
      batch.forEach((_, n) => ids.push(res.item_ids?.[n] ?? null))
    }
  } catch (err) {
    io.warn(`Sending interrupted after ${plural(sent, "knowledge item")}: run \`sync --confirm\` again (what the brain already received will be skipped).`)
    throw err
  }
  if (preview.workflows?.length) {
    try {
      const r = await api.automations(preview.workflows)
      io.log(`Automations: ${plural(r.saved, "Screenpipe workflow sent up", "Screenpipe workflows sent up")}.`)
    } catch (err) {
      io.warn(`Automations not sent up: ${(err as Error).message}`)
    }
  }
  const zones = tally.record()
  const next: State = preview.next_state ?? {}
  next.last_sync = { at: new Date().toISOString(), distiller: preview.distiller, items_sent: sent, conversations: preview.conversations, zones }
  io.log(sentLine(sent, duplicates, tally.line()))
  const documents = cfg.send_documents === false ? [] : await sendPlannedDocuments(api, preview.documents ?? [], ids, preview.items, next, io, false)
  saveState(next)
  removePreview()
  return { conversations: preview.conversations, items: preview.items, sent, duplicates, zones, distiller: preview.distiller, deferred: 0, documents }
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
  // After install-schedule, nothing earlier than the setup that has not already been read (except an explicit --since),
  // for every source: files already followed included, and Screenpipe even with an old checkpoint.
  const baseline = !explicitSince && baseState.baseline_at && Number.isFinite(Date.parse(baseState.baseline_at)) ? new Date(baseState.baseline_at) : undefined
  let since = parseSince(opts.since)
  if (baseline && baseline.getTime() > since.getTime()) since = baseline

  io.log(`brain-sync — ${new Date().toLocaleString("en-GB")}${opts.dryRun ? " (dry run: nothing will be sent)" : ""}`)

  // 1. Zones (all of them, with keywords) — falls back on the cache.
  const { cache, errors } = await refreshCache(api)
  if (errors.length) io.warn(`Warning: ${errors[0]} — zones read from the local cache.`)
  const zones: ZoneHint[] = zoneHints(cache.zones ? cache : loadCache())
  const defaultZone = cache.whoami?.writable[0] ?? zones[0]?.id ?? "general"

  const distiller = await createDistiller(cfg, opts.distiller)
  io.log(`Distillation: ${DISTILLER_LABELS[distiller.kind]} — ${distiller.reason}`)

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
      meetings: cfg.screenpipe_meetings !== false,
      selfNames: [cache.whoami?.name ?? ""].filter(Boolean),
    })
    results.push(sp)
    if (sp.available) {
      const wf = await fetchScreenpipeWorkflows(cfg.screenpipe_url, cfg.screenpipe_token, zones, { whitelist: cfg.app_whitelist, literals: secrets })
      workflows = wf.workflows.map((w) => ({ ...w, title: maskOwnSecrets(w.title, secrets).text, description: maskOwnSecrets(w.description, secrets).text }))
      workflowsDropped = wf.dropped
    }
  }

  io.log("Sources:")
  for (const r of results) {
    const label = SOURCE_LABELS[r.source]
    if (!r.available) io.log(`  - ${label}: ${r.source === "screenpipe" ? "unavailable, skipped" : "no log found"}`)
    else {
      const extra =
        r.source === "screenpipe"
          ? `${r.stats.items ?? 0} captures, type "${r.stats.content_type ?? "?"}"` + (r.stats.meetings !== undefined ? `, ${plural(Number(r.stats.meetings), "meeting")}` : "")
          : `${plural(Number(r.stats.files ?? 0), "file")} read, ${kb(Number(r.stats.bytes ?? 0))}` +
            (Number(r.stats.internal) ? `, ${r.stats.internal} internal session(s) skipped` : "") +
            (Number(r.stats.pending) ? `, ${plural(Number(r.stats.pending), "turn in progress", "turns in progress")} read on the next pass` : "")
      const nothing = r.source !== "screenpipe" && !Number(r.stats.files) && r.conversations.length === 0
      io.log(`  - ${label}: ${nothing ? "nothing new since the last sync" : `${plural(r.conversations.length, "conversation")} (${extra})`}`)
    }
    for (const w of r.warnings) io.warn(`    ${w}`)
  }

  // 3. Privacy.
  const now = Date.now()
  const all = results.flatMap((r) => r.conversations)
  const privacy = applyPrivacy(all, secrets)
  const totalRedactions = Object.values(privacy.redactions).reduce((a, b) => a + b, 0)
  const personalDrops = privacy.dropped.filter((d) => d.reason === "personal content")
  // Weak signals only, conversation still active: not marked as processed, it will be examined again in full.
  const retry = new Set(personalDrops.filter((d) => d.weakOnly && d.ended_at && now - Date.parse(d.ended_at) < PERSONAL_RETRY_MS).map((d) => d.id))
  io.log(
    `Privacy: ${plural(totalRedactions, "item redacted", "items redacted")}` +
      (verbose && totalRedactions ? ` (${Object.entries(privacy.redactions).map(([k, v]) => `${k}: ${v}`).join(", ")})` : "") +
      `, ${plural(personalDrops.length, "personal conversation dropped", "personal conversations dropped")}`,
  )
  const shownDrops = verbose ? privacy.dropped : opts.dryRun ? personalDrops.slice(0, 20) : []
  for (const d of shownDrops) io.log(`    dropped: ${d.id} (${describeDrop(d)}${retry.has(d.id) ? "; examined again on the next sync as long as it goes on" : ""})`)
  if (!verbose && opts.dryRun && personalDrops.length > shownDrops.length) io.log(`    … and ${personalDrops.length - shownDrops.length} more (--verbose to see everything)`)

  // 4. Distillation, from the oldest to the most recent, within the --limit of segments.
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
  if (deferred > 0 && !opts.dryRun) io.log(`Limit of ${limit} segments reached: ${plural(deferred, "conversation")} postponed to the next sync.`)

  // An LLM failure never falls back on the heuristic: the conversation is not processed and will be distilled again later.
  // The conversations that already failed go after the others: a success first shows that Claude works.
  const prevFailures = baseState.distill_failures ?? {}
  const order = jobs.map((_, i) => i).sort((a, b) => Number(Boolean(prevFailures[jobs[a].conv.id])) - Number(Boolean(prevFailures[jobs[b].conv.id])) || a - b)
  const distilled: KnowledgeItemInput[][] = jobs.map(() => [])
  const failedConvs = new Map<string, Failure>()
  const untried = new Set<string>()
  /** Calls where Claude answered (success, or refusal / unreadable output): the CLI and the sign-in work. */
  let alive = 0
  let outageStreak = 0
  /** Failures without an answer from the model (timeout, unknown error), per conversation: all identical and nothing else = outage. */
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
      const f: Failure = { error: maskOwnSecrets(res.error ?? "failure", secrets).text, failure: res.failure ?? "conversation", signature: res.signature }
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
    if (verbose) io.log(`    ${conv.tool} ${truncate(conv.title ?? conv.id, 60)} → ${res.failed ? `failed (${truncate(res.error ?? "?", 120)})` : plural(res.items.length, "item")} (${DISTILLER_LABELS[res.used]})`)
  })
  for (const id of untried) if (failedConvs.has(id)) untried.delete(id)
  const notDistilled = new Set([...failedConvs.keys(), ...untried])

  // Failures specific to a conversation: counted (n) when they are conclusive, that is when the model answered
  // (refusal, unreadable output) or when Claude answered another call of this sync; given up at MAX_DISTILL_ATTEMPTS,
  // so as never to block the queue or the Screenpipe checkpoint. Without any answer from Claude (timeout, unknown error),
  // the failure proves nothing: only the 24 h safeguard applies. A recognized outage (lost sign-in, missing CLI,
  // network, subscription limit, overload) is not counted at all.
  const failures = [...failedConvs.values()]
  const authFailure = failures.find((f) => f.failure === "auth")
  const outageCount = failures.filter((f) => f.failure === "outage").length
  /** Claude answered at least one call of the sync: the CLI, the sign-in and the subscription work. */
  const witnessed = alive > 0
  const nowIso = new Date(now).toISOString()
  const failuresNext: NonNullable<State["distill_failures"]> = {}
  for (const [id, f] of Object.entries(prevFailures)) if (now - Date.parse(f.at) < FAILURE_TTL_MS) failuresNext[id] = f
  const givenUp: string[] = []
  const stuck: string[] = []
  const counted: { id: string; n: number }[] = []
  let unproven = 0
  for (const [id, f] of failedConvs) {
    if (f.failure !== "conversation") continue // recognized outage: any history is kept as is
    const prev = prevFailures[id]
    const proven = !f.signature || witnessed
    const n = (prev?.n ?? 0) + (proven ? 1 : 0)
    const tries = (prev?.tries ?? prev?.n ?? 0) + 1
    const firstAt = prev && Number.isFinite(Date.parse(prev.first_at ?? prev.at)) ? (prev.first_at ?? prev.at) : nowIso
    if (n >= MAX_DISTILL_ATTEMPTS || (tries >= STUCK_ABANDON_TRIES && now - Date.parse(firstAt) >= STUCK_ABANDON_MS)) {
      if (n >= MAX_DISTILL_ATTEMPTS) givenUp.push(id)
      else stuck.push(id)
      delete failuresNext[id]
      continue
    }
    failuresNext[id] = { n, tries, first_at: firstAt, at: nowIso, error: truncate(f.error, 200) }
    if (proven) counted.push({ id, n })
    else unproven++
  }
  const abandoned = [...givenUp, ...stuck]
  for (const id of notDistilled) processed.delete(id)
  if (!opts.dryRun) for (const id of abandoned) processed.add(id)
  for (const id of processed) delete failuresNext[id]

  const retried = notDistilled.size - (opts.dryRun ? 0 : abandoned.length)
  const them = (n: number, one: string, many: string) => (n === 1 ? one : many)
  if (authFailure) {
    io.warn(`  ${distiller.kind === "claude-api" ? apiAuthHelp(authFailure.error) : claudeAuthHelp(authFailure.error)}`)
    io.warn(
      `  Distillation interrupted: ${plural(notDistilled.size, "conversation not distilled", "conversations not distilled")}. ` +
        `Nothing is sent for ${them(notDistilled.size, "it", "them")} and the heuristic is not used instead: ` +
        `${them(notDistilled.size, "it will be distilled", "they will be distilled")} on the next sync, once Claude is signed in again (no attempt counted).`,
    )
  } else if (notDistilled.size) {
    const first = (failures.find((f) => f.failure !== "conversation") ?? failures[0])?.error ?? "?"
    let why = ""
    if (counted.length)
      why +=
        ` Failure due to the content of ${plural(counted.length, "conversation")} (attempt ${Math.max(...counted.map((c) => c.n))}/${MAX_DISTILL_ATTEMPTS}):` +
        ` after ${MAX_DISTILL_ATTEMPTS} attempts, ${them(counted.length, "it will be given up", "they will be given up")} without sending anything, so as not to block the sync.`
    if (outageCount || unproven) {
      const label = outageCount ? "Claude unreachable or overloaded" : sameWay() ? "every call fails the same way" : "Claude answered no call"
      why +=
        ` ${witnessed ? "Outage" : "General outage"} (${label}): ` +
        (counted.length ? `no attempt counted for ${plural(outageCount + unproven, "other conversation", "other conversations")}.` : "no attempt is counted.") +
        (unproven
          ? ` A conversation that has been failing this way for more than 24 h (at least ${STUCK_ABANDON_TRIES} attempts) will be given up, so as not to block the sync.`
          : "") +
        (witnessed ? "" : " Check that `claude -p` works (sign-in, quotas; `init --claude-token`) or distill without an LLM with --distiller heuristic.")
    }
    io.warn(
      `  Distillation: ${plural(notDistilled.size, "conversation not distilled", "conversations not distilled")} by ${DISTILLER_LABELS[distiller.kind]}` +
        ` (${truncate(first, 160)})${untried.size ? `, of which ${untried.size} not attempted (Claude unavailable)` : ""}.` +
        (retried > 0
          ? ` Nothing is sent for ${them(retried, "it", "them")} and the heuristic is not used instead: ${them(retried, "it will be retried", "they will be retried")} on the next sync.`
          : "") +
        why,
    )
  }
  if (verbose) for (const [id, f] of failedConvs) io.log(`    not distilled: ${id} (${truncate(f.error, 160)})`)
  if (givenUp.length && !opts.dryRun)
    io.warn(
      `  ${plural(givenUp.length, "conversation given up", "conversations given up")} after ${MAX_DISTILL_ATTEMPTS} unsuccessful attempts: ` +
        `nothing was sent for ${them(givenUp.length, "it", "them")}, the sync goes on without ${them(givenUp.length, "it", "them")} (checkpoints moved forward).`,
    )
  if (stuck.length && !opts.dryRun)
    io.warn(
      `  ${plural(stuck.length, "conversation given up", "conversations given up")} after more than 24 h of failures (at least ${STUCK_ABANDON_TRIES} attempts): ` +
        `nothing was sent for ${them(stuck.length, "it", "them")}, the sync goes on without ${them(stuck.length, "it", "them")} (checkpoints moved forward).`,
    )

  // 4b. Screenpipe agent: Claude Code or Codex looks at the recent activity itself (Screenpipe MCP, read-only).
  // Its window only moves forward once its knowledge is sent; on a failure, it is read again on the next run (60 min at most).
  let agent: AgentResult | null = null
  const spRead = results.find((r) => r.source === "screenpipe")
  // Claude signed out during distillation: the Claude agent would fail the same way (Codex can still run).
  const engine = spRead?.available && opts.distiller !== "heuristic" ? pickAgentEngine(cfg) : null
  const agentEngine = engine && !(engine.engine === "claude" && authFailure && distiller.kind === "claude-cli") ? engine : null
  const agentWin = agentEngine ? agentWindow(opts.reset ? {} : baseState, new Date(now), baseline) : null
  if (agentEngine && agentWin) {
    const who = cache.whoami ? [cache.whoami.name, cache.whoami.title].filter(Boolean).join(", ") : undefined
    agent = await runScreenpipeAgent({ ...agentEngine, cfg, zones, fallbackZone: defaultZone, window: agentWin, who })
    const span = `${AGENT_ENGINE_LABELS[agentEngine.engine]}, ${hhmm(agentWin.start.toISOString())} → ${hhmm(agentWin.end.toISOString())}`
    if (agent.ok) {
      processed.add(agent.id)
      io.log(
        `Screenpipe agent (${span}): ${plural(agent.items.length, "knowledge item proposed", "knowledge items proposed")}` +
          (agent.personal ? `, ${agent.personal} dropped (personal content)` : "") +
          ".",
      )
    } else io.warn(`  Screenpipe agent (${span}): failed (${truncate(maskOwnSecrets(agent.error, secrets).text, 160)}); window read again on the next run.`)
  }

  // Items grouped by conversation (in processing order): a conversation is "done" when all its items have gone.
  const byConv = new Map<string, KnowledgeItemInput[]>()
  jobs.forEach((j, n) => {
    if (notDistilled.has(j.conv.id)) return
    byConv.set(j.conv.id, [...(byConv.get(j.conv.id) ?? []), ...distilled[n]])
  })
  if (agent?.ok) byConv.set(agent.id, agent.items)
  const seenKeys = new Set<string>()
  const flat: { item: KnowledgeItemInput; conv: string; last: boolean }[] = []
  for (const [conv, list] of byConv) {
    const kept = finalizeItems(list, seenKeys, secrets)
    kept.forEach((item, n) => flat.push({ item, conv, last: n === kept.length - 1 }))
  }
  const items = flat.map((f) => f.item)
  const planned = cfg.send_documents === false ? [] : planDocuments(flat, new Map(jobs.map((j) => [j.conv.id, j.conv])))
  const { perZone, zoneLine } = countZones(items)
  const convCounts: Partial<Record<SourceName, number>> = {}
  for (const r of results) convCounts[r.source] = r.conversations.length

  const commits = results.flatMap((r) => r.commits)
  if (agent?.ok) commits.push(agent.commit)

  // What the preview does not contain: said clearly (none of it will go with --confirm).
  const gaps: string[] = []
  if (deferred > 0) gaps.push(`${plural(deferred, "conversation postponed", "conversations postponed")}: limit of ${limit} segments reached (--limit N to see more)`)
  if (cutChunks > 0) gaps.push(`${plural(cutChunks, "old segment", "old segments")} of a very long conversation, skipped (only the last ${limit} are read)`)
  for (const r of results) {
    if (r.source === "screenpipe" && r.available && r.stats.truncated_until) gaps.push(`Screenpipe: captures read only up to ${hhmm(String(r.stats.truncated_until))} (the rest was not read)`)
    if (Number(r.stats.pending)) gaps.push(`${SOURCE_LABELS[r.source]}: ${plural(Number(r.stats.pending), "conversation turn in progress", "conversation turns in progress")} (answer not written yet)`)
  }
  if (notDistilled.size) gaps.push(`${plural(notDistilled.size, "conversation Claude did not distill", "conversations Claude did not distill")}`)
  if (agent && !agent.ok) gaps.push("Screenpipe agent: failed, its recent activity was not looked at")
  if (retry.size)
    gaps.push(
      retry.size > 1
        ? `${retry.size} conversations dropped for now (weak personal signals), examined again if they go on`
        : "1 conversation dropped for now (weak personal signals), examined again if it goes on",
    )

  // 5. Dry run: we show everything that would go, we send nothing, we do not move the checkpoints.
  if (opts.dryRun) {
    io.log("")
    io.log(`[dry run] ${plural(items.length, "knowledge item")} would be sent${zoneLine ? ` (${zoneLine})` : ""}:`)
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
      io.log(`[dry run] ${plural(workflows.length, "repetitive Screenpipe workflow", "repetitive Screenpipe workflows")} would be sent up:`)
      workflows.forEach((w, n) => {
        io.log(`  W${n + 1}. ${w.title}${w.zone ? ` [${w.zone}]` : ""} — ${w.occurrences} times over ${plural(w.days, "day")}${w.schedule ? `, around ${w.schedule}` : ""}`)
        if (w.description) io.log(`     ${w.description}`)
      })
    }
    if (workflowsDropped) io.log(`  ${plural(workflowsDropped, "Screenpipe workflow dropped", "Screenpipe workflows dropped")} (app outside the allowlist or personal content).`)
    if (planned.length) {
      io.log(`[dry run] ${plural(planned.length, "document")} worked on in these sessions would go with their knowledge:`)
      for (const [n, d] of planned.entries()) {
        const c = documentCandidate(d.path, { brainHome: brainHome() })
        const problems = "skipped" in c ? [c.skipped] : (await readDocument(c).catch((e: Error) => ({ problems: [e.message] }))).problems
        const what = "skipped" in c ? documentBaseName(d.path) : `${c.name} (${formatBytes(c.size)})`
        io.log(`  D${n + 1}. ${what} → with item${d.items.length > 1 ? "s" : ""} ${d.items.map((i) => i + 1).join(", ")}${problems.length ? ` — stays on the computer: ${problems[0]}` : ""}`)
      }
      io.log("  The brain reads each file again on arrival (PDFs included) and refuses it if it holds a secret or personal data.")
    }
    if (abridged) io.log("Abridged texts: add --full to see each knowledge item in full.")
    if (gaps.length) {
      io.log("")
      io.log("Warning, partial preview: this is not in it, and will not go with sync --confirm:")
      for (const g of gaps) io.log(`  - ${g}`)
      io.log(
        "To review it: sync --confirm, then run sync --dry-run --full again. After install-schedule, what was not reviewed is never sent.",
      )
    }
    // The exact preview, for `sync --confirm` (same items, same checkpoints).
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
      documents: planned,
      next_state: next,
    }
    ensureHome()
    writeJson(paths.preview(), preview, 0o600)
    io.log("Nothing was sent (dry run). To send exactly what is shown: sync --confirm (valid for 24 h).")
    return { conversations: convCounts, items, sent: 0, zones: perZone, distiller: distiller.kind, deferred, failed: notDistilled.size, gaps }
  }

  // 6. Sending in batches of 50; after each batch, the checkpoints of the conversations fully sent are saved.
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
  const ids: (string | null)[] = []
  try {
    for (let i = 0; i < flat.length; i += BATCH) {
      const batch = flat.slice(i, i + BATCH)
      const res = await api.ingest(batch.map((b) => b.item), "brain-sync")
      sent += res.inserted
      duplicates += res.skipped ?? 0
      tally.add(batch.map((b) => b.item), res)
      batch.forEach((_, n) => ids.push(res.item_ids?.[n] ?? null))
      for (const b of batch) if (b.last) done.add(b.conv)
      saveState(checkpoint())
    }
  } catch (err) {
    if (sent || duplicates) io.warn(`Sending interrupted: ${plural(sent, "knowledge item")} already sent and saved; the next sync will pick up the rest.`)
    throw err
  }
  if (workflows.length) {
    try {
      const r = await api.automations(workflows)
      io.log(`Automations: ${plural(r.saved, "Screenpipe workflow sent up", "Screenpipe workflows sent up")}.`)
    } catch (err) {
      io.warn(`Automations not sent up: ${(err as Error).message}`)
    }
  }
  const sentZones = tally.record()
  const next = checkpoint()
  next.last_sync = { at: new Date().toISOString(), distiller: distiller.kind, items_sent: sent, conversations: convCounts, zones: sentZones }
  io.log(sentLine(sent, duplicates, tally.line()))
  const documents = await sendPlannedDocuments(api, planned, ids, items, next, io, verbose)
  saveState(next)
  removePreview()
  return { conversations: convCounts, items, sent, duplicates, zones: sentZones, distiller: distiller.kind, deferred, failed: notDistilled.size, documents }
}
