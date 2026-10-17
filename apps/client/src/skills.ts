// Skills de l'entreprise sur le poste : installation dans ~/.claude/skills et publication depuis un dossier.
//
// Le cerveau ne donne à chacun que les skills de toute l'entreprise et ceux des cortex (zones) qu'il lit. Chaque skill
// installé porte un marqueur (.company-brain.json) : le client ne modifie ni ne supprime jamais un dossier sans marqueur
// (un skill personnel du même nom est laissé tel quel), et retire ceux qui ne lui sont plus attribués.

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

/** Dossiers de skills posés par ce client (avec marqueur), par nom. */
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

/** Écrit les fichiers d'un skill dans `target` (remplacé d'un coup : jamais de skill à moitié écrit). */
function writeSkill(dir: string, target: string, skill: ApiSkill, url: string) {
  const tmp = join(dir, `.${skill.name}.tmp-${process.pid}`)
  const old = join(dir, `.${skill.name}.old-${process.pid}`)
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp, { recursive: true })
  try {
    for (const f of skill.files) {
      const file = resolve(tmp, f.path)
      // Défense en profondeur : le cerveau a déjà validé les chemins.
      if (!file.startsWith(tmp + sep)) throw new Error(`chemin refusé : ${f.path}`)
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
  if (!SKILL_NAME_RE.test(skill.name)) return "nom invalide"
  if (!skill.files.some((f) => f.path === SKILL_MAIN_FILE)) return `${SKILL_MAIN_FILE} manquant`
  const bad = skill.files.find((f) => !isSafeSkillPath(f.path))
  return bad ? `chemin refusé (${bad.path})` : null
}

/**
 * Aligne ~/.claude/skills sur les skills reçus : installe les nouveaux, met à jour ceux dont la version a changé, retire
 * ceux de ce cerveau qui ne sont plus attribués à la personne (skill supprimé, ou cortex qu'elle ne lit plus).
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
      report.skipped.push({ name: skill.name, reason: `un skill personnel du même nom existe déjà (${target})` })
      continue
    }
    if (marker && marker.url !== url) {
      report.skipped.push({ name: skill.name, reason: `déjà installé depuis un autre cerveau (${marker.url})` })
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

/** Retire tous les skills posés par ce client (uninstall). */
export function removeInstalledSkills(log: Log = console.log, dir = skillsDir()): number {
  const mine = installedSkills(dir)
  for (const name of mine.keys()) rmSync(join(dir, name), { recursive: true, force: true })
  log(mine.size ? `Skills de l'entreprise retirés de ${dir} (${mine.size}).` : "Skills de l'entreprise : rien à retirer.")
  return mine.size
}

const IGNORED_DIRS = new Set(["node_modules", "__pycache__", "venv", "dist", "build"])

/** Fichiers texte d'un dossier de skill (chemins relatifs en « / »), sans fichiers cachés ni dossiers de dépendances. */
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
          ignored.push(`${rel} (trop gros)`)
          continue
        }
        const content = readFileSync(full, "utf8")
        if (content.includes("\u0000") || content.includes("�")) ignored.push(`${rel} (pas un fichier texte)`)
        else files.push({ path: rel, content })
      }
    }
  }
  walk(root)
  return { files, ignored }
}

const COMPANY_WIDE = new Set(["entreprise", "tous", "toute-l-entreprise", "aucun", "none", "all"])

/** `skills push <dossier> [--cortex <zone>] [--name <nom>] [--description <texte>]` */
async function pushSkill(api: BrainApi, folder: string | undefined, flags: Record<string, string | boolean>, log: Log): Promise<number> {
  if (!folder) throw new UserError(`Dossier du skill manquant : node ${selfScript()} skills push <dossier> [--cortex <zone>]`)
  const root = resolve(folder)
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new UserError(`Dossier introuvable : ${root}`)
  const { files, ignored } = readSkillDir(root)
  const main = files.find((f) => f.path === SKILL_MAIN_FILE)
  if (!main) throw new UserError(`${SKILL_MAIN_FILE} introuvable à la racine de ${root}.`)
  const front = parseSkillFrontmatter(main.content).data
  const name = typeof flags.name === "string" ? flags.name : skillSlug(front.name || basename(root))
  if (!SKILL_NAME_RE.test(name)) throw new UserError(`Nom de skill invalide : « ${name} » (minuscules, chiffres et tirets). Précisez-le avec --name.`)
  const description = typeof flags.description === "string" ? flags.description : (front.description ?? "")
  const cortex = typeof flags.cortex === "string" ? flags.cortex : typeof flags.zone === "string" ? flags.zone : undefined
  const zone = cortex === undefined ? undefined : COMPANY_WIDE.has(cortex.toLowerCase()) ? null : cortex
  if (ignored.length) log(`Ignorés : ${ignored.join(", ")}`)
  let skill
  try {
    skill = await api.publishSkill({ name, description, zone, files })
  } catch (err) {
    // Refus du cerveau (droit, cortex, secret, nom pris…) : son message, sans la mécanique HTTP.
    if (err instanceof ApiError && [400, 403, 409].includes(err.status))
      throw new UserError(`Publication refusée : ${err.message.replace(/^Le cerveau a répondu \d+ : /, "")}`)
    throw err
  }
  const where = skill.zone ? `le cortex « ${skill.zone} »` : "toute l'entreprise"
  log(`Skill « ${skill.name} » publié (v${skill.version}, ${files.length} fichier${files.length > 1 ? "s" : ""}) pour ${where}.`)
  log("Les postes concernés le reçoivent à leur prochaine synchro (toutes les 15 min), ou tout de suite avec `skills`.")
  return 0
}

function reportLines(r: InstallReport, dir: string): string[] {
  const lines: string[] = []
  if (r.installed.length) lines.push(`Installés : ${r.installed.join(", ")}`)
  if (r.updated.length) lines.push(`Mis à jour : ${r.updated.join(", ")}`)
  if (r.removed.length) lines.push(`Retirés (plus attribués à ce poste) : ${r.removed.join(", ")}`)
  for (const s of r.skipped) lines.push(`Non installé : ${s.name} (${s.reason})`)
  if (!lines.length) lines.push(`Skills à jour dans ${dir}.`)
  return lines
}

/** Installe les skills attribués à ce poste ; ne lève jamais (appelé après chaque synchro et par setup). */
export async function refreshSkills(log: Log = console.log, opts: { quiet?: boolean } = {}): Promise<InstallReport | null> {
  try {
    const cfg = requireConfig()
    const { skills } = await new BrainApi(cfg.url, cfg.token).skills()
    const report = installSkills(skills, cfg.url)
    const changed = report.installed.length + report.updated.length + report.removed.length + report.skipped.length > 0
    if (!opts.quiet || changed) for (const l of reportLines(report, skillsDir())) log(`Skills : ${l}`)
    return report
  } catch (err) {
    // Cerveau d'avant les skills : rien à installer.
    if (err instanceof ApiError && err.status === 404) return null
    log(`Skills : mise à jour impossible (${(err as Error).message}).`)
    return null
  }
}

/** `skills [sync|list|push]` */
export async function cmdSkills(positional: string[], flags: Record<string, string | boolean>, log: Log = console.log): Promise<number> {
  const sub = positional[0] ?? "sync"
  const cfg = requireConfig()
  const api = new BrainApi(cfg.url, cfg.token)
  if (sub === "push") return pushSkill(api, positional[1], flags, log)
  if (sub !== "sync" && sub !== "list") throw new UserError(`Sous-commande inconnue : « ${sub} » (sync, list ou push).`)
  const { skills, can_publish } = await api.skills()
  if (sub === "sync") for (const l of reportLines(installSkills(skills, cfg.url), skillsDir())) log(l)
  log("")
  log(skills.length ? `${skills.length} skill${skills.length > 1 ? "s" : ""} pour ce poste :` : "Aucun skill attribué à ce poste pour l'instant.")
  for (const s of skills) log(`  ${s.name} (v${s.version}, ${s.zone ? `cortex ${s.zone}` : "toute l'entreprise"}) : ${s.description}`)
  log("")
  log(
    can_publish
      ? `Publier : node ${selfScript()} skills push <dossier> [--cortex <zone>]`
      : "Publier un skill demande une autorisation : demandez-la à un admin.",
  )
  return 0
}
