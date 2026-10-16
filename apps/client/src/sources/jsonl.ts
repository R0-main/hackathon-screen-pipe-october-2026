// Lecture incrémentale de fichiers JSONL (logs Claude Code / Codex) avec un offset par fichier.

import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import type { FileCheckpoint } from "../config"

/** Liste récursive des *.jsonl sous `root` (sans suivre les liens symboliques). */
export function listJsonlFiles(root: string, skipDir: (name: string) => boolean = () => false, maxDepth = 8): string[] {
  const out: string[] = []
  const walk = (dir: string, depth: number) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        if (depth < maxDepth && !skipDir(e.name)) walk(p, depth + 1)
      } else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p)
    }
  }
  walk(root, 0)
  return out.sort()
}

export type JsonlChunk = {
  lines: Record<string, unknown>[]
  /** Offset absolu de fin de chaque ligne de `lines` (pour reprendre au milieu d'un morceau). */
  ends: number[]
  /** Offset absolu où commence ce morceau. */
  start: number
  checkpoint: FileCheckpoint
  bytesRead: number
  /** Vrai si le fichier a rétréci (tronqué / remplacé) : relu depuis le début. */
  reset: boolean
}

/**
 * Lit les octets ajoutés depuis le dernier checkpoint. Une dernière ligne incomplète
 * (en cours d'écriture) est laissée pour le prochain passage.
 */
export function readNewLines(file: string, prev?: FileCheckpoint): JsonlChunk | null {
  let st
  try {
    st = statSync(file)
  } catch {
    return null
  }
  const size = st.size
  const mtime = Math.round(st.mtimeMs)
  let offset = prev?.offset ?? 0
  let reset = false
  if (size < offset) {
    offset = 0
    reset = true
  }
  const checkpoint: FileCheckpoint = { offset, size, mtime, ...(prev?.internal ? { internal: true } : {}) }
  if (size === offset) return { lines: [], ends: [], start: offset, checkpoint, bytesRead: 0, reset }

  const length = size - offset
  const buf = Buffer.alloc(length)
  const fd = openSync(file, "r")
  try {
    let read = 0
    while (read < length) {
      const n = readSync(fd, buf, read, length - read, offset + read)
      if (n === 0) break
      read += n
    }
  } finally {
    closeSync(fd)
  }

  let consumed = buf.lastIndexOf(0x0a) + 1
  const lines: Record<string, unknown>[] = []
  const ends: number[] = []
  const parse = (s: string, end: number) => {
    const t = s.trim()
    if (!t) return true
    try {
      const v = JSON.parse(t)
      if (v && typeof v === "object" && !Array.isArray(v)) {
        lines.push(v as Record<string, unknown>)
        ends.push(end)
      }
      return true
    } catch {
      return false
    }
  }
  let pos = 0
  while (pos < consumed) {
    const nl = buf.indexOf(0x0a, pos)
    const stop = nl === -1 || nl >= consumed ? consumed : nl + 1
    parse(buf.subarray(pos, stop).toString("utf8"), offset + stop)
    pos = stop
  }
  // Dernier morceau sans saut de ligne : on ne le consomme que s'il est un JSON complet.
  if (consumed < length) {
    const tail = buf.subarray(consumed).toString("utf8")
    const before = lines.length
    if (tail.trim().startsWith("{") && parse(tail, offset + length) && lines.length > before) consumed = length
  }
  checkpoint.offset = offset + consumed
  return { lines, ends, start: offset, checkpoint, bytesRead: consumed, reset }
}

export function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined
}

export function toIso(v: unknown): string | undefined {
  if (typeof v !== "string" && typeof v !== "number") return undefined
  const t = typeof v === "number" ? (v < 1e12 ? v * 1000 : v) : Date.parse(v)
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined
}
