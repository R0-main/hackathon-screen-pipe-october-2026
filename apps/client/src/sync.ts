// brain-sync : sources locales → filtre vie privée → distillation → POST /api/ingest (puis checkpoints).

import { createHash } from "node:crypto"
import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs"
import {
  DISTILL_MARKER,
  chunkConversation,
  classifyZones,
  looksPersonal,
  redact,
  truncate,
  type Conversation,
  type KnowledgeItemInput,
  type ZoneHint,
} from "@brain/core"
import { BrainApi, type Workflow } from "./api"
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
import { DISTILLER_LABELS, createDistiller, finalizeItems, type DistillerKind } from "./distill"
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

/**
 * Masque secrets et données perso dans chaque message (y compris les jetons du poste lui-même) ;
 * écarte les conversations perso, vides, internes, ou la session d'installation du cerveau.
 */
export function applyPrivacy(
  convs: Conversation[],
  secrets: string[] = [],
): { kept: Conversation[]; dropped: { id: string; reason: string }[]; redactions: Record<string, number> } {
  const redactions: Record<string, number> = {}
  const kept: Conversation[] = []
  const dropped: { id: string; reason: string }[] = []
  for (const c of convs) {
    const setup = c.messages.some((m) => isBrainSetupText(m.text, secrets))
    const messages = c.messages
      .map((m) => {
        const r = redact(m.text)
        for (const [k, v] of Object.entries(r.redactions)) redactions[k] = (redactions[k] ?? 0) + v
        const own = maskOwnSecrets(r.text, secrets)
        if (own.count) redactions.jeton_cerveau = (redactions.jeton_cerveau ?? 0) + own.count
        return { ...m, text: own.text.trim() }
      })
      .filter((m) => m.text)
    const all = messages.map((m) => m.text).join("\n")
    if (!messages.length || !all.trim()) dropped.push({ id: c.id, reason: "vide" })
    else if (all.includes(DISTILL_MARKER)) dropped.push({ id: c.id, reason: "session interne de distillation" })
    else if (setup) dropped.push({ id: c.id, reason: "session d'installation du cerveau" })
    else if (looksPersonal(`${c.title ?? ""}\n${all}`)) dropped.push({ id: c.id, reason: "contenu personnel" })
    else kept.push({ ...c, title: c.title ? truncate(maskOwnSecrets(redact(c.title).text, secrets).text, 120) : undefined, messages })
  }
  return { kept, dropped, redactions }
}

const SOURCE_LABELS: Record<SourceName, string> = { claude: "Claude Code", codex: "Codex", screenpipe: "Screenpipe" }
const KIND_LABELS: Record<string, string> = { fact: "fait", decision: "décision", task: "tâche", procedure: "procédure", question: "question" }

function kb(n: number): string {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} Mo` : `${(n / 1024).toFixed(1)} Ko`
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n > 1 ? many : one}`
}

export type SyncSummary = {
  skipped?: string
  conversations: Partial<Record<SourceName, number>>
  items: KnowledgeItemInput[]
  sent: number
  /** Items que le cerveau avait déjà (dédoublonnage serveur). */
  duplicates?: number
  zones: Record<string, number>
  distiller: DistillerKind
  deferred: number
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

function countZones(items: KnowledgeItemInput[]): { perZone: Record<string, number>; zoneLine: string } {
  const perZone: Record<string, number> = {}
  for (const i of items) perZone[i.zone] = (perZone[i.zone] ?? 0) + 1
  const zoneLine = Object.entries(perZone)
    .sort((a, b) => b[1] - a[1])
    .map(([z, n]) => `${z} : ${n}`)
    .join(", ")
  return { perZone, zoneLine }
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
  try {
    for (let i = 0; i < preview.items.length; i += BATCH) {
      const res = await api.ingest(preview.items.slice(i, i + BATCH), "brain-sync")
      sent += res.inserted
      duplicates += res.skipped ?? 0
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
  const next: State = preview.next_state ?? {}
  next.last_sync = { at: new Date().toISOString(), distiller: preview.distiller, items_sent: sent, conversations: preview.conversations, zones: preview.zones }
  saveState(next)
  removePreview()
  io.log(sentLine(sent, duplicates, countZones(preview.items).zoneLine))
  return { conversations: preview.conversations, items: preview.items, sent, duplicates, zones: preview.zones, distiller: preview.distiller, deferred: 0 }
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
  // Après install-schedule, rien d'antérieur à la mise en place qui n'ait déjà été relu (sauf --since explicite).
  let since = parseSince(opts.since)
  if (!explicitSince && baseState.baseline_at && Date.parse(baseState.baseline_at) > since.getTime()) since = new Date(baseState.baseline_at)

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
  if (wanted.includes("claude")) results.push(readClaudeLogs({ dir: claudeDir(), state, since, explicitSince, reset: opts.reset, brainHome: brainHome(), secrets }))
  if (wanted.includes("codex")) results.push(readCodexLogs({ dir: codexDir(), state, since, explicitSince, reset: opts.reset, secrets }))
  let workflows: Workflow[] = []
  let workflowsDropped = 0
  if (wanted.includes("screenpipe")) {
    const sp = await readScreenpipe({
      url: cfg.screenpipe_url,
      token: cfg.screenpipe_token,
      state: opts.reset ? {} : state,
      since,
      explicitSince,
      contentTypes: cfg.screenpipe_content_types,
      whitelist: cfg.app_whitelist,
      meetings: cfg.screenpipe_meetings !== false,
      selfNames: [cache.whoami?.name ?? ""].filter(Boolean),
    })
    results.push(sp)
    if (sp.available) {
      const wf = await fetchScreenpipeWorkflows(cfg.screenpipe_url, cfg.screenpipe_token, zones, { whitelist: cfg.app_whitelist })
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
          ? `${r.stats.items ?? 0} captures, type « ${r.stats.content_type ?? "?"} »` + (r.stats.meetings !== undefined ? `, ${plural(Number(r.stats.meetings), "réunion")}` : "")
          : `${plural(Number(r.stats.files ?? 0), "fichier")} lu${Number(r.stats.files) > 1 ? "s" : ""}, ${kb(Number(r.stats.bytes ?? 0))}` +
            (Number(r.stats.internal) ? `, ${r.stats.internal} session(s) interne(s) ignorée(s)` : "") +
            (Number(r.stats.pending) ? `, ${plural(Number(r.stats.pending), "tour en cours", "tours en cours")} lu(s) au prochain passage` : "")
      const nothing = r.source !== "screenpipe" && !Number(r.stats.files) && r.conversations.length === 0
      io.log(`  - ${label} : ${nothing ? "rien de nouveau depuis la dernière synchro" : `${plural(r.conversations.length, "conversation")} (${extra})`}`)
    }
    for (const w of r.warnings) io.warn(`    ${w}`)
  }

  // 3. Vie privée.
  const all = results.flatMap((r) => r.conversations)
  const privacy = applyPrivacy(all, secrets)
  const totalRedactions = Object.values(privacy.redactions).reduce((a, b) => a + b, 0)
  const personal = privacy.dropped.filter((d) => d.reason === "contenu personnel").length
  io.log(
    `Vie privée : ${plural(totalRedactions, "élément masqué", "éléments masqués")}` +
      (verbose && totalRedactions ? ` (${Object.entries(privacy.redactions).map(([k, v]) => `${k} : ${v}`).join(", ")})` : "") +
      `, ${plural(personal, "conversation perso écartée", "conversations perso écartées")}`,
  )
  if (verbose) for (const d of privacy.dropped) io.log(`    écartée : ${d.id} (${d.reason})`)

  // 4. Distillation, des plus anciennes aux plus récentes, dans la limite de --limit segments.
  const processed = new Set(privacy.dropped.map((d) => d.id))
  const queue = [...privacy.kept].sort((a, b) => a.ended_at.localeCompare(b.ended_at))
  const jobs: { conv: Conversation; chunk: Conversation }[] = []
  let budget = limit
  let deferred = 0
  for (const conv of queue) {
    let chunks = chunkConversation(conv)
    if (chunks.length > budget) {
      if (jobs.length > 0) {
        deferred = queue.length - queue.indexOf(conv)
        break
      }
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
  if (deferred > 0) io.log(`Limite de ${limit} segments atteinte : ${plural(deferred, "conversation")} reportée(s) à la prochaine synchro.`)

  const fallbacks: string[] = []
  const distilled = await mapPool(jobs, distiller.concurrency, async ({ conv, chunk }) => {
    const text = chunk.messages.map((m) => m.text).join("\n")
    const fallbackZone = classifyZones(text, zones, 1)[0] ?? defaultZone
    const res = await distiller.distill(chunk, zones, fallbackZone)
    if (res.error) fallbacks.push(`${conv.id} : ${res.error}`)
    if (verbose) io.log(`    ${conv.tool} ${truncate(conv.title ?? conv.id, 60)} → ${plural(res.items.length, "item")} (${DISTILLER_LABELS[res.used]})`)
    return res.items
  })
  if (fallbacks.length) io.warn(`  ${plural(fallbacks.length, "segment")} distillé(s) par l'heuristique faute de réponse LLM${verbose ? ` : ${fallbacks.join(" ; ")}` : ""}.`)

  // Items rangés par conversation (dans l'ordre de traitement) : une conversation est « faite » quand tous ses items sont partis.
  const byConv = new Map<string, KnowledgeItemInput[]>()
  jobs.forEach((j, n) => byConv.set(j.conv.id, [...(byConv.get(j.conv.id) ?? []), ...distilled[n]]))
  const seenKeys = new Set<string>()
  const flat: { item: KnowledgeItemInput; conv: string; last: boolean }[] = []
  for (const [conv, list] of byConv) {
    const kept = finalizeItems(list, seenKeys)
    kept.forEach((item, n) => flat.push({ item, conv, last: n === kept.length - 1 }))
  }
  const items = flat.map((f) => f.item)
  const { perZone, zoneLine } = countZones(items)
  const convCounts: Partial<Record<SourceName, number>> = {}
  for (const r of results) convCounts[r.source] = r.conversations.length

  const commits = results.flatMap((r) => r.commits)

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
    return { conversations: convCounts, items, sent: 0, zones: perZone, distiller: distiller.kind, deferred }
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
    return next
  }
  let sent = 0
  let duplicates = 0
  try {
    for (let i = 0; i < flat.length; i += BATCH) {
      const batch = flat.slice(i, i + BATCH)
      const res = await api.ingest(batch.map((b) => b.item), "brain-sync")
      sent += res.inserted
      duplicates += res.skipped ?? 0
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
  const next = checkpoint()
  next.last_sync = { at: new Date().toISOString(), distiller: distiller.kind, items_sent: sent, conversations: convCounts, zones: perZone }
  saveState(next)
  removePreview()
  io.log(sentLine(sent, duplicates, zoneLine))
  return { conversations: convCounts, items, sent, duplicates, zones: perZone, distiller: distiller.kind, deferred }
}
