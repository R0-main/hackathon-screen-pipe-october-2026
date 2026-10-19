// `rezone`: files the knowledge already in the brain into its project's zone, once projects are added to the zones.
// The computer knows the folder of each Claude Code / Codex session (its logs); the brain knows which session each
// knowledge item comes from. Nothing is distilled again: the brain moves the caller's own knowledge.

import { readFileSync } from "node:fs"
import { basename, join } from "node:path"
import { projectZone, type ZoneHint } from "@brain/core"
import { ApiError, BrainApi } from "./api"
import { refreshCache, zoneHints, zoneName } from "./cache"
import { UserError, claudeDir, codexDir, requireConfig } from "./config"
import { remoteReader } from "./git-remote"
import { codexSessionId, parseCodexLine } from "./sources/codex-logs"
import { listJsonlFiles } from "./sources/jsonl"

type Log = (s: string) => void

/** Moves sent per request (the brain accepts 2000). */
export const REZONE_BATCH = 1000

/** Lines worth parsing: only those that carry a folder. */
function linesWithCwd(file: string): Record<string, unknown>[] {
  let text: string
  try {
    text = readFileSync(file, "utf8")
  } catch {
    return []
  }
  const out: Record<string, unknown>[] = []
  for (const line of text.split("\n")) {
    if (!line.includes('"cwd"')) continue
    try {
      out.push(JSON.parse(line) as Record<string, unknown>)
    } catch {
      // Line being written or truncated.
    }
  }
  return out
}

/** Folder of each local session: Claude Code (one file per project, a sessionId per line) and Codex (one file per session). */
export function localSessions(dirs: { claude: string; codex: string }): Map<string, string> {
  const sessions = new Map<string, string>()
  for (const file of listJsonlFiles(join(dirs.claude, "projects"), (name) => name === "subagents")) {
    for (const j of linesWithCwd(file)) {
      const cwd = typeof j.cwd === "string" ? j.cwd : undefined
      const id = typeof j.sessionId === "string" ? j.sessionId : basename(file, ".jsonl")
      if (cwd) sessions.set(id, cwd)
    }
  }
  for (const file of listJsonlFiles(join(dirs.codex, "sessions"))) {
    let cwd: string | undefined
    for (const j of linesWithCwd(file)) cwd = parseCodexLine(j).cwd ?? cwd
    if (cwd) sessions.set(codexSessionId(file), cwd)
  }
  return sessions
}

/** Session → zone of its project, for the sessions opened in a project that a zone lists. */
export function projectMoves(sessions: Map<string, string>, zones: ZoneHint[], remoteOf = remoteReader()): { session_id: string; zone: string }[] {
  const moves: { session_id: string; zone: string }[] = []
  for (const [session_id, cwd] of sessions) {
    const zone = projectZone({ cwd, repo: remoteOf(cwd) }, zones)
    if (zone) moves.push({ session_id, zone })
  }
  return moves
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`

/** `brain.mjs rezone [--dry-run]`. */
export async function cmdRezone(opts: { dryRun?: boolean } = {}, log: Log = console.log): Promise<number> {
  const cfg = requireConfig()
  const api = new BrainApi(cfg.url, cfg.token)
  const { cache, errors } = await refreshCache(api)
  if (errors.length) throw new UserError(`Could not read the zones from the brain: ${errors[0]}`)
  const zones = zoneHints(cache)
  if (!zones.some((z) => z.projects?.length))
    throw new UserError("No zone lists a project yet: add them in the dashboard (Team › Zones › Projects), then run rezone again.")

  const sessions = localSessions({ claude: claudeDir(), codex: codexDir() })
  const moves = projectMoves(sessions, zones)
  const perZone = new Map<string, number>()
  for (const m of moves) perZone.set(m.zone, (perZone.get(m.zone) ?? 0) + 1)
  log(`rezone — ${plural(sessions.size, "local session")}, ${plural(moves.length, "session")} in a project: ${[...perZone].map(([z, n]) => `${zoneName(cache, z)} ${n}`).join(", ") || "none"}.`)
  if (moves.length === 0) return 0

  const total = { moved: 0, already: 0, sessions: 0, zones: new Map<string, number>(), unknown: new Set<string>() }
  for (let i = 0; i < moves.length; i += REZONE_BATCH) {
    let r: Awaited<ReturnType<BrainApi["rezone"]>>
    try {
      r = await api.rezone(moves.slice(i, i + REZONE_BATCH), Boolean(opts.dryRun))
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) throw new UserError("This brain does not know rezone yet (route missing, 404): update the server.")
      throw err
    }
    total.moved += r.moved
    total.already += r.already
    total.sessions += r.sessions
    for (const [z, n] of Object.entries(r.zones)) total.zones.set(z, (total.zones.get(z) ?? 0) + n)
    for (const z of r.unknown_zones) total.unknown.add(z)
  }
  const detail = [...total.zones].map(([z, n]) => `${zoneName(cache, z)} ${n}`).join(", ")
  const verb = opts.dryRun ? "would be moved" : "moved"
  log(`${plural(total.moved, "knowledge item")} ${verb}${detail ? ` (${detail})` : ""}, ${total.already} already in place, from ${plural(total.sessions, "session")} known to the brain.`)
  if (total.unknown.size) log(`Zones unknown to the brain (ignored): ${[...total.unknown].join(", ")}.`)
  if (opts.dryRun && total.moved > 0) log("Dry run: nothing was moved. Run rezone without --dry-run to apply.")
  return 0
}
