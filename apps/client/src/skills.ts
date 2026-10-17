// Company skills on the computer: install into ~/.claude/skills and publishing from a folder.
//
// The brain only gives each person the company-wide skills and those of the cortices (zones) they read. Each installed
// skill carries a marker (.company-brain.json): the client never modifies or deletes a folder without a marker
// (a personal skill with the same name is left as is), and removes those no longer assigned to it.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { basename, dirname, join, relative, resolve, sep } from "node:path"
import {
  SKILL_LIMITS,
  SKILL_MAIN_FILE,
  SKILL_MARKER_FILE,
  SKILL_NAME_RE,
  isExecutableSkillFile,
  isSafeSkillPath,
  parseSkillFrontmatter,
  skillSlug,
  type SkillFile,
} from "@brain/core"
import { ApiError, BrainApi, type ApiSkill } from "./api"
import { UserError, claudeDir, readJson, requireConfig, selfScript } from "./config"

type Log = (s: string) => void

export type SkillMarker = { id: string; name: string; version: number; zone: string | null; url: string; installed_at: string }

export type InstallReport = { installed: string[]; updated: string[]; unchanged: string[]; removed: string[]; skipped: { name: string; reason: string }[] }

export function skillsDir(): string {
  return join(claudeDir(), "skills")
}

function readMarker(dir: string): SkillMarker | null {
  const m = readJson<SkillMarker>(join(dir, SKILL_MARKER_FILE))
  return m && typeof m.id === "string" && typeof m.url === "string" ? m : null
}

/** Skill folders laid down by this client (with a marker), by name. */
export function installedSkills(dir = skillsDir()): Map<string, SkillMarker> {
  const out = new Map<string, SkillMarker>()
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".")) continue
    const marker = readMarker(join(dir, name))
    if (marker) out.set(name, marker)
  }
  return out
}

/** Writes a skill's files into `target` (replaced in one go: never a half-written skill). */
function writeSkill(dir: string, target: string, skill: ApiSkill, url: string) {
  const tmp = join(dir, `.${skill.name}.tmp-${process.pid}`)
  const old = join(dir, `.${skill.name}.old-${process.pid}`)
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp, { recursive: true })
  try {
    for (const f of skill.files) {
      const file = resolve(tmp, f.path)
      // Defense in depth: the brain has already validated the paths.
      if (!file.startsWith(tmp + sep)) throw new Error(`path refused: ${f.path}`)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, f.content, { mode: isExecutableSkillFile(f) ? 0o755 : 0o644 })
    }
    const marker: SkillMarker = { id: skill.id, name: skill.name, version: skill.version, zone: skill.zone, url, installed_at: new Date().toISOString() }
    writeFileSync(join(tmp, SKILL_MARKER_FILE), JSON.stringify(marker, null, 2) + "\n")
    if (existsSync(target)) renameSync(target, old)
    renameSync(tmp, target)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
    rmSync(old, { recursive: true, force: true })
  }
}

function invalidReason(skill: ApiSkill): string | null {
  if (!SKILL_NAME_RE.test(skill.name)) return "invalid name"
  if (!skill.files.some((f) => f.path === SKILL_MAIN_FILE)) return `${SKILL_MAIN_FILE} missing`
  const bad = skill.files.find((f) => !isSafeSkillPath(f.path))
  return bad ? `path refused (${bad.path})` : null
}

/**
 * Aligns ~/.claude/skills with the skills received: installs the new ones, updates those whose version changed, removes
 * those from this brain no longer assigned to the person (skill deleted, or a cortex they no longer read).
 */
export function installSkills(skills: ApiSkill[], url: string, dir = skillsDir()): InstallReport {
  const report: InstallReport = { installed: [], updated: [], unchanged: [], removed: [], skipped: [] }
  mkdirSync(dir, { recursive: true })
  const mine = installedSkills(dir)
  const wanted = new Set<string>()
  for (const skill of skills) {
    const invalid = invalidReason(skill)
    if (invalid) {
      report.skipped.push({ name: skill.name, reason: invalid })
      continue
    }
    wanted.add(skill.name)
    const target = join(dir, skill.name)
    const marker = mine.get(skill.name)
    if (existsSync(target) && !marker) {
      report.skipped.push({ name: skill.name, reason: `a personal skill with the same name already exists (${target})` })
      continue
    }
    if (marker && marker.url !== url) {
      report.skipped.push({ name: skill.name, reason: `already installed from another brain (${marker.url})` })
      continue
    }
    if (marker && marker.id === skill.id && marker.version === skill.version) {
      report.unchanged.push(skill.name)
      continue
    }
    try {
      writeSkill(dir, target, skill, url)
      ;(marker ? report.updated : report.installed).push(skill.name)
    } catch (err) {
      report.skipped.push({ name: skill.name, reason: (err as Error).message })
    }
  }
  for (const [name, marker] of mine) {
    if (marker.url !== url || wanted.has(name)) continue
    rmSync(join(dir, name), { recursive: true, force: true })
    report.removed.push(name)
  }
  return report
}

/** Removes every skill laid down by this client (uninstall). */
export function removeInstalledSkills(log: Log = console.log, dir = skillsDir()): number {
  const mine = installedSkills(dir)
  for (const name of mine.keys()) rmSync(join(dir, name), { recursive: true, force: true })
  log(mine.size ? `Company skills removed from ${dir} (${mine.size}).` : "Company skills: nothing to remove.")
  return mine.size
}

const IGNORED_DIRS = new Set(["node_modules", "__pycache__", "venv", "dist", "build"])

/** Text files of a skill folder (relative paths with "/"), without hidden files or dependency folders. */
export function readSkillDir(root: string): { files: SkillFile[]; ignored: string[] } {
  const files: SkillFile[] = []
  const ignored: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name)
      const rel = relative(root, full).split(sep).join("/")
      if (name.startsWith(".") || IGNORED_DIRS.has(name)) {
        ignored.push(rel)
        continue
      }
      const st = statSync(full)
      if (st.isDirectory()) walk(full)
      else if (st.isFile()) {
        if (st.size > SKILL_LIMITS.fileChars * 4) {
          ignored.push(`${rel} (too large)`)
          continue
        }
        const content = readFileSync(full, "utf8")
        if (content.includes("\u0000") || content.includes("�")) ignored.push(`${rel} (not a text file)`)
        else files.push({ path: rel, content })
      }
    }
  }
  walk(root)
  return { files, ignored }
}

const COMPANY_WIDE = new Set(["company", "all", "whole-company", "none", "entreprise", "tous", "toute-l-entreprise", "aucun"])

/** `skills push <folder> [--cortex <zone>] [--name <name>] [--description <text>]` */
async function pushSkill(api: BrainApi, folder: string | undefined, flags: Record<string, string | boolean>, log: Log): Promise<number> {
  if (!folder) throw new UserError(`Skill folder missing: node ${selfScript()} skills push <folder> [--cortex <zone>]`)
  const root = resolve(folder)
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new UserError(`Folder not found: ${root}`)
  const { files, ignored } = readSkillDir(root)
  const main = files.find((f) => f.path === SKILL_MAIN_FILE)
  if (!main) throw new UserError(`${SKILL_MAIN_FILE} not found at the root of ${root}.`)
  const front = parseSkillFrontmatter(main.content).data
  const name = typeof flags.name === "string" ? flags.name : skillSlug(front.name || basename(root))
  if (!SKILL_NAME_RE.test(name)) throw new UserError(`Invalid skill name: "${name}" (lowercase letters, digits and hyphens). Set it with --name.`)
  const description = typeof flags.description === "string" ? flags.description : (front.description ?? "")
  const cortex = typeof flags.cortex === "string" ? flags.cortex : typeof flags.zone === "string" ? flags.zone : undefined
  const zone = cortex === undefined ? undefined : COMPANY_WIDE.has(cortex.toLowerCase()) ? null : cortex
  if (ignored.length) log(`Ignored: ${ignored.join(", ")}`)
  let skill
  try {
    skill = await api.publishSkill({ name, description, zone, files })
  } catch (err) {
    // Refused by the brain (permission, cortex, secret, name taken…): its message, without the HTTP mechanics.
    if (err instanceof ApiError && [400, 403, 409].includes(err.status))
      throw new UserError(`Publishing refused: ${err.message.replace(/^The brain answered \d+: /, "")}`)
    throw err
  }
  const where = skill.zone ? `the "${skill.zone}" cortex` : "the whole company"
  log(`Skill "${skill.name}" published (v${skill.version}, ${files.length} file${files.length === 1 ? "" : "s"}) for ${where}.`)
  log("The computers concerned receive it on their next sync (every 15 min), or right away with `skills`.")
  return 0
}

function reportLines(r: InstallReport, dir: string): string[] {
  const lines: string[] = []
  if (r.installed.length) lines.push(`Installed: ${r.installed.join(", ")}`)
  if (r.updated.length) lines.push(`Updated: ${r.updated.join(", ")}`)
  if (r.removed.length) lines.push(`Removed (no longer assigned to this computer): ${r.removed.join(", ")}`)
  for (const s of r.skipped) lines.push(`Not installed: ${s.name} (${s.reason})`)
  if (!lines.length) lines.push(`Skills up to date in ${dir}.`)
  return lines
}

/** Installs the skills assigned to this computer; never throws (called after each sync and by setup). */
export async function refreshSkills(log: Log = console.log, opts: { quiet?: boolean } = {}): Promise<InstallReport | null> {
  try {
    const cfg = requireConfig()
    const { skills } = await new BrainApi(cfg.url, cfg.token).skills()
    const report = installSkills(skills, cfg.url)
    const changed = report.installed.length + report.updated.length + report.removed.length + report.skipped.length > 0
    if (!opts.quiet || changed) for (const l of reportLines(report, skillsDir())) log(`Skills: ${l}`)
    return report
  } catch (err) {
    // Brain from before skills: nothing to install.
    if (err instanceof ApiError && err.status === 404) return null
    log(`Skills: update impossible (${(err as Error).message}).`)
    return null
  }
}

/** `skills [sync|list|push]` */
export async function cmdSkills(positional: string[], flags: Record<string, string | boolean>, log: Log = console.log): Promise<number> {
  const sub = positional[0] ?? "sync"
  const cfg = requireConfig()
  const api = new BrainApi(cfg.url, cfg.token)
  if (sub === "push") return pushSkill(api, positional[1], flags, log)
  if (sub !== "sync" && sub !== "list") throw new UserError(`Unknown subcommand: "${sub}" (sync, list or push).`)
  const { skills, can_publish } = await api.skills()
  if (sub === "sync") for (const l of reportLines(installSkills(skills, cfg.url), skillsDir())) log(l)
  log("")
  log(skills.length ? `${skills.length} skill${skills.length === 1 ? "" : "s"} for this computer:` : "No skill assigned to this computer for now.")
  for (const s of skills) log(`  ${s.name} (v${s.version}, ${s.zone ? `cortex ${s.zone}` : "whole company"}): ${s.description}`)
  log("")
  log(
    can_publish
      ? `Publish: node ${selfScript()} skills push <folder> [--cortex <zone>]`
      : "Publishing a skill requires permission: ask an admin for it.",
  )
  return 0
}
