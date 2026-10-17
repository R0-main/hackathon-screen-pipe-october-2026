// Incremental reading of JSONL files (Claude Code / Codex logs) with one offset per file.

import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import type { FileCheckpoint } from "../config"

/** Recursive list of *.jsonl under `root` (without following symbolic links). */
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
  /** Absolute end offset of each line of `lines` (to resume in the middle of a chunk). */
  ends: number[]
  /** Absolute offset where this chunk starts. */
  start: number
  checkpoint: FileCheckpoint
  bytesRead: number
  /** True if the file shrank (truncated / replaced): read again from the start. */
  reset: boolean
}

/**
 * Reads the bytes added since the last checkpoint. An incomplete last line
 * (being written) is left for the next pass.
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
  // Last chunk without a line break: only consumed if it is complete JSON.
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

/**
 * End offset of a file's complete lines (as readNewLines would do it): the whole file, except a last
 * line being written. Only reads the end of the file.
 */
export function completeLinesEnd(file: string): { offset: number; size: number; mtime: number } | null {
  let st
  try {
    st = statSync(file)
  } catch {
    return null
  }
  const size = st.size
  const mtime = Math.round(st.mtimeMs)
  if (size === 0) return { offset: 0, size, mtime }
  const window = Math.min(size, 1024 * 1024)
  const buf = Buffer.alloc(window)
  const fd = openSync(file, "r")
  try {
    readSync(fd, buf, 0, window, size - window)
  } finally {
    closeSync(fd)
  }
  const nl = buf.lastIndexOf(0x0a)
  const tail = buf.subarray(nl + 1).toString("utf8").trim()
  if (!tail) return { offset: size, size, mtime }
  try {
    const v = JSON.parse(tail)
    if (v && typeof v === "object") return { offset: size, size, mtime }
  } catch {
    // incomplete last line
  }
  return { offset: nl === -1 ? Math.max(0, size - window) : size - window + nl + 1, size, mtime }
}
