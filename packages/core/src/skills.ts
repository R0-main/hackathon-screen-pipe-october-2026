// Company skills: format, validation and safeguards shared by the brain and the workstation client.
//
// A skill is a Claude Code folder (SKILL.md at the root, plus the scripts it uses). The brain keeps it
// as is, and each workstation installs it in ~/.claude/skills/<name>/ if it has access to its cortex (its zone).

import { z } from "zod"
import { redact } from "./privacy"
import type { SkillFile } from "./types"

export const SKILL_MAIN_FILE = "SKILL.md"
/** File the client drops in each skill it installs: it never touches other folders. */
export const SKILL_MARKER_FILE = ".company-brain.json"

export const SKILL_LIMITS = { files: 40, fileChars: 100_000, totalChars: 400_000, description: 1024 }

/** Same rule as Claude Code: lowercase, digits and dashes, 64 characters at most. */
export const SKILL_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/

const SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/

/** Safe relative path inside the skill folder: no "..", no absolute path, no hidden file. */
export function isSafeSkillPath(p: string): boolean {
  if (p.length === 0 || p.length > 200 || p.includes("\\") || p.startsWith("/")) return false
  const parts = p.split("/")
  if (parts.length > 6) return false
  return parts.every((s) => SEGMENT_RE.test(s) && !s.includes("..")) && p !== SKILL_MARKER_FILE
}

/** Skill name from free text (folder name, title). */
export function skillSlug(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "")
}

const FRONTMATTER_RE = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/

/** Simple YAML front matter of SKILL.md (`name`, `description`…), dependency-free: one key per line. */
export function parseSkillFrontmatter(md: string): { data: Record<string, string>; body: string } {
  const m = md.match(FRONTMATTER_RE)
  if (!m) return { data: {}, body: md }
  const data: Record<string, string> = {}
  let block: string | null = null
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/)
    if (!kv) {
      // Continuation of a multi-line value (`description: >` or `|`).
      if (block && /^\s+\S/.test(line)) data[block] = `${data[block]} ${line.trim()}`.trim()
      continue
    }
    let v = kv[2].trim()
    block = /^[>|][+-]?$/.test(v) ? kv[1] : null
    if (block) v = ""
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    data[kv[1]] = v
  }
  return { data, body: md.slice(m[0].length) }
}

/**
 * SKILL.md with a `name` / `description` front matter consistent with the published skill: Claude Code uses it to know
 * when to use it. Other front-matter keys (allowed-tools…) are kept as is, continuation lines included.
 */
export function withSkillFrontmatter(md: string, name: string, description: string): string {
  const m = md.match(FRONTMATTER_RE)
  const kept: string[] = []
  let skipping = false
  for (const line of m ? m[1].split(/\r?\n/) : []) {
    const key = line.match(/^([A-Za-z][\w-]*)\s*:/)?.[1]
    if (key) skipping = key === "name" || key === "description"
    if (!skipping && line.trim() !== "") kept.push(line)
  }
  const body = (m ? md.slice(m[0].length) : md.replace(/^\uFEFF/, "")).replace(/^\s*\n/, "")
  return ["---", `name: ${name}`, `description: ${JSON.stringify(description.replace(/\s+/g, " ").trim())}`, ...kept, "---", "", body].join("\n")
}

/** Redactions that flag personal data rather than a secret: a script may mention the support email. */
const NOT_SECRET = new Set(["email", "phone_fr", "phone_intl", "phone_us", "iban", "card", "nir", "ssn"])

/** Files of a skill that contain a secret (API key, token, password, private key…), and which ones. */
export function skillSecrets(files: SkillFile[]): { path: string; kinds: string[] }[] {
  const out: { path: string; kinds: string[] }[] = []
  for (const f of files) {
    const kinds = Object.keys(redact(f.content).redactions).filter((k) => !NOT_SECRET.has(k))
    if (kinds.length) out.push({ path: f.path, kinds })
  }
  return out
}

/** Problems of a set of skill files (empty if all is well). */
export function skillFileProblems(files: SkillFile[]): string[] {
  const problems: string[] = []
  if (!files.some((f) => f.path === SKILL_MAIN_FILE)) problems.push(`${SKILL_MAIN_FILE} missing at the root of the skill.`)
  if (files.length > SKILL_LIMITS.files) problems.push(`Too many files (${files.length}, ${SKILL_LIMITS.files} at most).`)
  const seen = new Set<string>()
  let total = 0
  for (const f of files) {
    if (!isSafeSkillPath(f.path)) problems.push(`Path rejected: "${f.path.slice(0, 80)}" (relative, no ".." and no hidden file).`)
    if (seen.has(f.path.toLowerCase())) problems.push(`Duplicate file: ${f.path}.`)
    seen.add(f.path.toLowerCase())
    if (f.content.length > SKILL_LIMITS.fileChars) problems.push(`${f.path} is too large (${SKILL_LIMITS.fileChars / 1000}k characters at most).`)
    if (f.content.includes("\u0000")) problems.push(`${f.path} is not a text file.`)
    total += f.content.length
  }
  if (total > SKILL_LIMITS.totalChars) problems.push(`Skill too large (${SKILL_LIMITS.totalChars / 1000}k characters at most in total).`)
  return problems
}

/** A script runs as is if it starts with a shebang, or if it lives in scripts/ or bin/. */
export function isExecutableSkillFile(f: SkillFile): boolean {
  return f.content.startsWith("#!") || /^(?:scripts|bin)\/[^/]+\.(?:sh|bash|zsh|py|rb|mjs|js|ts)$/.test(f.path)
}

/** POST /api/skills: publish a skill (or a new version under the same name). */
export const SkillPublishSchema = z.object({
  name: z.string().regex(SKILL_NAME_RE, "name: lowercase, digits and dashes (64 characters at most)"),
  description: z.string().max(SKILL_LIMITS.description).default(""),
  /** Cortex (zone) to assign the skill to; null: the whole company; absent: the previous version's (otherwise null). */
  zone: z.string().min(1).max(64).nullable().optional(),
  files: z
    .array(z.object({ path: z.string().min(1).max(200), content: z.string().max(SKILL_LIMITS.fileChars) }))
    .min(1)
    .max(SKILL_LIMITS.files),
  agent: z.enum(["dashboard", "brain-sync", "mcp", "claude-code"]).default("dashboard"),
})

export type SkillPublishInput = z.input<typeof SkillPublishSchema>
