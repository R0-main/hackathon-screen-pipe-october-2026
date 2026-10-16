// brain-sync : sources locales → filtre vie privée → distillation → POST /api/ingest (puis checkpoints).

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
import { BrainApi } from "./api"
import { refreshCache, zoneHints } from "./cache"
import {
  brainHome,
  claudeDir,
  codexDir,
  ensureHome,
  loadCache,
  loadState,
  paths,
  requireConfig,
  saveState,
  type SourceName,
  type State,
} from "./config"
import { DISTILLER_LABELS, createDistiller, finalizeItems, type DistillerKind } from "./distill"
import { readClaudeLogs } from "./sources/claude-logs"
import { readCodexLogs } from "./sources/codex-logs"
import { fetchScreenpipeWorkflows, readScreenpipe } from "./sources/screenpipe"
import type { SourceResult } from "./sources/types"

export type SyncOptions = {
  dryRun?: boolean
  since?: string
  source?: SourceName | "all"
  limit?: number
  verbose?: boolean
  distiller?: DistillerKind
  reset?: boolean
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

/** Masque secrets et données perso dans chaque message ; écarte les conversations perso ou vides. */
export function applyPrivacy(convs: Conversation[]): { kept: Conversation[]; dropped: { id: string; reason: string }[]; redactions: Record<string, number> } {
  const redactions: Record<string, number> = {}
  const kept: Conversation[] = []
  const dropped: { id: string; reason: string }[] = []
  for (const c of convs) {
    const messages = c.messages
      .map((m) => {
        const r = redact(m.text)
        for (const [k, v] of Object.entries(r.redactions)) redactions[k] = (redactions[k] ?? 0) + v
        return { ...m, text: r.text.trim() }
      })
      .filter((m) => m.text)
    const all = messages.map((m) => m.text).join("\n")
    if (!messages.length || !all.trim()) dropped.push({ id: c.id, reason: "vide" })
    else if (all.includes(DISTILL_MARKER)) dropped.push({ id: c.id, reason: "session interne de distillation" })
    else if (looksPersonal(`${c.title ?? ""}\n${all}`)) dropped.push({ id: c.id, reason: "contenu personnel" })
    else kept.push({ ...c, title: c.title ? truncate(redact(c.title).text, 120) : undefined, messages })
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
  zones: Record<string, number>
  distiller: DistillerKind
  deferred: number
}

export async function runSync(opts: SyncOptions = {}, io: Io = defaultIo): Promise<SyncSummary> {
  const cfg = requireConfig()
  const api = new BrainApi(cfg.url, cfg.token)
  const verbose = Boolean(opts.verbose)
  const limit = Math.max(1, opts.limit ?? 30)
  const since = parseSince(opts.since)
  const explicitSince = Boolean(opts.since)
  const wanted: SourceName[] = !opts.source || opts.source === "all" ? cfg.sources : [opts.source]

  const lock = opts.dryRun ? null : acquireLock()
  if (lock && "busy" in lock) {
    io.log(`Une synchronisation est déjà en cours (${lock.busy}) : on passe.`)
    return { skipped: lock.busy, conversations: {}, items: [], sent: 0, zones: {}, distiller: "heuristic", deferred: 0 }
  }
  const release = () => lock && "release" in lock && lock.release()
  const onSignal = () => {
    release()
    process.exit(130)
  }
  process.once("SIGINT", onSignal)
  process.once("SIGTERM", onSignal)

  try {
    io.log(`brain-sync — ${new Date().toLocaleString("fr-FR")}${opts.dryRun ? " (simulation : rien ne sera envoyé)" : ""}`)

    // 1. Zones (toutes, avec mots-clés) — repli sur le cache.
    const { cache, errors } = await refreshCache(api)
    if (errors.length) io.warn(`Attention : ${errors[0]} — zones lues depuis le cache local.`)
    const zones: ZoneHint[] = zoneHints(cache.zones ? cache : loadCache())
    const defaultZone = cache.whoami?.writable[0] ?? zones[0]?.id ?? "general"

    const distiller = await createDistiller(cfg, opts.distiller)
    io.log(`Distillation : ${DISTILLER_LABELS[distiller.kind]} — ${distiller.reason}`)

    // 2. Sources.
    const state = loadState()
    const results: SourceResult[] = []
    if (wanted.includes("claude")) results.push(readClaudeLogs({ dir: claudeDir(), state, since, explicitSince, reset: opts.reset, brainHome: brainHome() }))
    if (wanted.includes("codex")) results.push(readCodexLogs({ dir: codexDir(), state, since, explicitSince, reset: opts.reset }))
    let workflows: Awaited<ReturnType<typeof fetchScreenpipeWorkflows>> = []
    if (wanted.includes("screenpipe")) {
      const sp = await readScreenpipe({
        url: cfg.screenpipe_url,
        token: cfg.screenpipe_token,
        state: opts.reset ? {} : state,
        since,
        explicitSince,
        contentTypes: cfg.screenpipe_content_types,
        whitelist: cfg.app_whitelist,
      })
      results.push(sp)
      if (sp.available) workflows = await fetchScreenpipeWorkflows(cfg.screenpipe_url, cfg.screenpipe_token, zones)
    }

    io.log("Sources :")
    for (const r of results) {
      const label = SOURCE_LABELS[r.source]
      if (!r.available) io.log(`  - ${label} : ${r.source === "screenpipe" ? "indisponible, ignoré" : "aucun log trouvé"}`)
      else {
        const extra =
          r.source === "screenpipe"
            ? `${r.stats.items ?? 0} captures, type « ${r.stats.content_type ?? "?"} »`
            : `${plural(Number(r.stats.files ?? 0), "fichier")} lu${Number(r.stats.files) > 1 ? "s" : ""}, ${kb(Number(r.stats.bytes ?? 0))}${Number(r.stats.internal) ? `, ${r.stats.internal} session(s) interne(s) ignorée(s)` : ""}`
        const nothing = r.source !== "screenpipe" && !Number(r.stats.files) && r.conversations.length === 0
        io.log(`  - ${label} : ${nothing ? "rien de nouveau depuis la dernière synchro" : `${plural(r.conversations.length, "conversation")} (${extra})`}`)
      }
      for (const w of r.warnings) io.warn(`    ${w}`)
    }

    // 3. Vie privée.
    const all = results.flatMap((r) => r.conversations)
    const privacy = applyPrivacy(all)
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
    const items = finalizeItems(distilled.flat())

    const perZone: Record<string, number> = {}
    for (const i of items) perZone[i.zone] = (perZone[i.zone] ?? 0) + 1
    const zoneLine = Object.entries(perZone)
      .sort((a, b) => b[1] - a[1])
      .map(([z, n]) => `${z} : ${n}`)
      .join(", ")
    const convCounts: Partial<Record<SourceName, number>> = {}
    for (const r of results) convCounts[r.source] = r.conversations.length

    // 5. Simulation : on montre, on n'envoie rien, on n'avance pas les checkpoints.
    if (opts.dryRun) {
      io.log("")
      io.log(`[simulation] ${plural(items.length, "connaissance")} serai${items.length > 1 ? "en" : ""}t envoyée${items.length > 1 ? "s" : ""}${zoneLine ? ` (${zoneLine})` : ""} :`)
      items.forEach((i, n) => {
        io.log(`  ${n + 1}. [${i.zone}] ${KIND_LABELS[i.kind] ?? i.kind} — ${i.title}`)
        io.log(`     ${truncate(i.body.replace(/\s+/g, " "), verbose ? 2000 : 220)}`)
      })
      if (workflows.length) io.log(`[simulation] ${plural(workflows.length, "workflow répétitif", "workflows répétitifs")} Screenpipe serai${workflows.length > 1 ? "en" : ""}t remonté(s).`)
      io.log("Rien n'a été envoyé (simulation). Relancez sans --dry-run pour envoyer.")
      return { conversations: convCounts, items, sent: 0, zones: perZone, distiller: distiller.kind, deferred }
    }

    // 6. Envoi par lots de 50, puis checkpoints.
    let sent = 0
    for (let i = 0; i < items.length; i += 50) {
      const res = await api.ingest(items.slice(i, i + 50), "brain-sync")
      sent += res.inserted
    }
    if (workflows.length) {
      try {
        const r = await api.automations(workflows)
        io.log(`Automatisations : ${plural(r.saved, "workflow Screenpipe remonté", "workflows Screenpipe remontés")}.`)
      } catch (err) {
        io.warn(`Automatisations non remontées : ${(err as Error).message}`)
      }
    }
    const next: State = loadState()
    for (const r of results) {
      for (const c of r.commits) if (c.covers.every((id) => processed.has(id))) c.apply(next)
    }
    next.last_sync = { at: new Date().toISOString(), distiller: distiller.kind, items_sent: sent, conversations: convCounts, zones: perZone }
    saveState(next)
    io.log(`Envoyé : ${plural(sent, "connaissance")} au cerveau${zoneLine ? ` (${zoneLine})` : ""}.`)
    return { conversations: convCounts, items, sent, zones: perZone, distiller: distiller.kind, deferred }
  } finally {
    process.off("SIGINT", onSignal)
    process.off("SIGTERM", onSignal)
    release()
  }
}
