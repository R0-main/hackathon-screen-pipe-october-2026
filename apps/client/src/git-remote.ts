// The git repository a session's folder belongs to: its `origin` remote (or the first one), read from .git/config
// without running git. Lets a zone's project match a repository cloned under any folder name (projectZone).

import { existsSync, readFileSync, statSync } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"

/** The `.git/config` of the repository containing `dir` (worktrees included), or undefined. */
function gitConfig(dir: string): string | undefined {
  let d = resolve(dir)
  for (let i = 0; i < 40; i++) {
    const git = join(d, ".git")
    try {
      if (statSync(git).isDirectory()) return join(git, "config")
      // Worktree or submodule: `.git` is a file "gitdir: <path>"; a worktree's gitdir points to the main .git through `commondir`.
      const m = readFileSync(git, "utf8").match(/^gitdir:\s*(.+)$/m)
      if (!m) return undefined
      const gitdir = isAbsolute(m[1].trim()) ? m[1].trim() : resolve(d, m[1].trim())
      const common = join(gitdir, "commondir")
      const base = existsSync(common) ? resolve(gitdir, readFileSync(common, "utf8").trim()) : gitdir
      return join(base, "config")
    } catch {
      // No .git here: the parent folder.
    }
    const up = dirname(d)
    if (up === d) return undefined
    d = up
  }
  return undefined
}

/** URL of the `origin` remote of the repository containing `dir` (otherwise its first remote), or undefined. */
export function gitRemote(dir: string): string | undefined {
  const config = gitConfig(dir)
  if (!config) return undefined
  let text: string
  try {
    text = readFileSync(config, "utf8")
  } catch {
    return undefined
  }
  const remotes: { name: string; url: string }[] = []
  let current: string | undefined
  for (const line of text.split(/\r?\n/)) {
    const section = line.match(/^\s*\[\s*remote\s+"([^"]+)"\s*\]/)
    if (section) current = section[1]
    else if (/^\s*\[/.test(line)) current = undefined
    else if (current) {
      const url = line.match(/^\s*url\s*=\s*(.+?)\s*$/)
      if (url) remotes.push({ name: current, url: url[1] })
    }
  }
  return (remotes.find((r) => r.name === "origin") ?? remotes[0])?.url
}

/** gitRemote, read once per folder for the duration of a sync. */
export function remoteReader(): (dir: string | undefined) => string | undefined {
  const seen = new Map<string, string | undefined>()
  return (dir) => {
    if (!dir) return undefined
    if (!seen.has(dir)) seen.set(dir, gitRemote(dir))
    return seen.get(dir)
  }
}
