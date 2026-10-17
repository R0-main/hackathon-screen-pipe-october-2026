// Skills de l'entreprise : format, validation et garde-fous partagés par le cerveau et le client du poste.
//
// Un skill est un dossier Claude Code (SKILL.md à la racine, plus les scripts qu'il utilise). Le cerveau le conserve
// tel quel, et chaque poste l'installe dans ~/.claude/skills/<nom>/ s'il a accès à son cortex (sa zone).

import { z } from "zod"
import { redact } from "./privacy"
import type { SkillFile } from "./types"

export const SKILL_MAIN_FILE = "SKILL.md"
/** Fichier posé par le client dans chaque skill qu'il installe : il ne touche jamais aux autres dossiers. */
export const SKILL_MARKER_FILE = ".company-brain.json"

export const SKILL_LIMITS = { files: 40, fileChars: 100_000, totalChars: 400_000, description: 1024 }

/** Même règle que Claude Code : minuscules, chiffres et tirets, 64 caractères au plus. */
export const SKILL_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/

const SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/

/** Chemin relatif sûr dans le dossier du skill : pas de « .. », pas de chemin absolu, pas de fichier caché. */
export function isSafeSkillPath(p: string): boolean {
  if (p.length === 0 || p.length > 200 || p.includes("\\") || p.startsWith("/")) return false
  const parts = p.split("/")
  if (parts.length > 6) return false
  return parts.every((s) => SEGMENT_RE.test(s) && !s.includes("..")) && p !== SKILL_MARKER_FILE
}

/** Nom de skill à partir d'un texte libre (nom de dossier, titre). */
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

/** En-tête YAML simple de SKILL.md (`name`, `description`…), sans dépendance : une clé par ligne. */
export function parseSkillFrontmatter(md: string): { data: Record<string, string>; body: string } {
  const m = md.match(FRONTMATTER_RE)
  if (!m) return { data: {}, body: md }
  const data: Record<string, string> = {}
  let block: string | null = null
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/)
    if (!kv) {
      // Suite d'une valeur sur plusieurs lignes (`description: >` ou `|`).
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
 * SKILL.md avec un en-tête `name` / `description` cohérent avec le skill publié : Claude Code s'en sert pour savoir
 * quand l'utiliser. Les autres clés de l'en-tête (allowed-tools…) sont gardées telles quelles, lignes de suite comprises.
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

/** Masquages qui signalent une donnée personnelle et non un secret : un script peut citer l'email du support. */
const NOT_SECRET = new Set(["email", "phone_fr", "phone_intl", "iban", "card", "nir"])

/** Fichiers d'un skill qui contiennent un secret (clé API, jeton, mot de passe, clé privée…), et lesquels. */
export function skillSecrets(files: SkillFile[]): { path: string; kinds: string[] }[] {
  const out: { path: string; kinds: string[] }[] = []
  for (const f of files) {
    const kinds = Object.keys(redact(f.content).redactions).filter((k) => !NOT_SECRET.has(k))
    if (kinds.length) out.push({ path: f.path, kinds })
  }
  return out
}

/** Problèmes d'un ensemble de fichiers de skill (vide si tout va bien). */
export function skillFileProblems(files: SkillFile[]): string[] {
  const problems: string[] = []
  if (!files.some((f) => f.path === SKILL_MAIN_FILE)) problems.push(`${SKILL_MAIN_FILE} manquant à la racine du skill.`)
  if (files.length > SKILL_LIMITS.files) problems.push(`Trop de fichiers (${files.length}, ${SKILL_LIMITS.files} au plus).`)
  const seen = new Set<string>()
  let total = 0
  for (const f of files) {
    if (!isSafeSkillPath(f.path)) problems.push(`Chemin refusé : « ${f.path.slice(0, 80)} » (relatif, sans « .. » ni fichier caché).`)
    if (seen.has(f.path.toLowerCase())) problems.push(`Fichier en double : ${f.path}.`)
    seen.add(f.path.toLowerCase())
    if (f.content.length > SKILL_LIMITS.fileChars) problems.push(`${f.path} est trop gros (${SKILL_LIMITS.fileChars / 1000} k caractères au plus).`)
    if (f.content.includes("\u0000")) problems.push(`${f.path} n'est pas un fichier texte.`)
    total += f.content.length
  }
  if (total > SKILL_LIMITS.totalChars) problems.push(`Skill trop gros (${SKILL_LIMITS.totalChars / 1000} k caractères au plus en tout).`)
  return problems
}

/** Un script se lance tel quel s'il commence par un shebang, ou s'il est rangé dans scripts/ ou bin/. */
export function isExecutableSkillFile(f: SkillFile): boolean {
  return f.content.startsWith("#!") || /^(?:scripts|bin)\/[^/]+\.(?:sh|bash|zsh|py|rb|mjs|js|ts)$/.test(f.path)
}

/** POST /api/skills : publier un skill (ou une nouvelle version du même nom). */
export const SkillPublishSchema = z.object({
  name: z.string().regex(SKILL_NAME_RE, "nom : minuscules, chiffres et tirets (64 caractères au plus)"),
  description: z.string().max(SKILL_LIMITS.description).default(""),
  /** Cortex (zone) auquel attribuer le skill ; null : toute l'entreprise ; absent : celui de la version précédente (sinon null). */
  zone: z.string().min(1).max(64).nullable().optional(),
  files: z
    .array(z.object({ path: z.string().min(1).max(200), content: z.string().max(SKILL_LIMITS.fileChars) }))
    .min(1)
    .max(SKILL_LIMITS.files),
  agent: z.enum(["dashboard", "brain-sync", "mcp", "claude-code"]).default("dashboard"),
})

export type SkillPublishInput = z.input<typeof SkillPublishSchema>
