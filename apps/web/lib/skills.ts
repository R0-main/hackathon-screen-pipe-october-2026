// Skills de l'entreprise : publication sous autorisation, attribution à un cortex (zone), distribution aux postes.
//
// Visibilité : un skill sans cortex va à toute l'entreprise ; attribué à un cortex, il n'est donné (dashboard, `brain.mjs
// skills`) qu'à qui lit cette zone. Les admins voient tout. Même règle que la politique RLS « skills par cortex ».
// Publication : réservée aux admins et aux membres qui ont le droit `can_publish_skills`, et seulement vers un cortex
// qu'ils lisent eux-mêmes. Changer le cortex ou retirer un skill : un admin, ou son auteur s'il a toujours ce droit.

import {
  SKILL_MAIN_FILE,
  parseSkillFrontmatter,
  skillFileProblems,
  skillSecrets,
  truncate,
  withSkillFrontmatter,
  type AgentName,
  type Skill,
  type SkillFile,
} from "@brain/core"
import { canRead } from "./access"
import type { Viewer } from "./auth"
import { error } from "./http"
import { getStore } from "./store"

export class SkillError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: string[],
  ) {
    super(message)
  }
}

/** Refus attendu (droit, cortex, secret…) : son statut et son message ; toute autre erreur remonte à withViewer (500). */
export function skillErrorResponse(err: unknown): Response {
  if (err instanceof SkillError) return error(err.status, err.message, err.details)
  throw err
}

/** Droit de publier, porté par la personne réellement connectée (pas celle qu'un admin « voit en tant que »). */
export function canPublishSkills(viewer: Viewer): boolean {
  return viewer.real.role === "admin" || viewer.real.can_publish_skills === true
}

export function canSeeSkill(viewer: Viewer, skill: Pick<Skill, "zone">): boolean {
  return skill.zone === null || canRead(viewer.access, skill.zone)
}

/** Cortex que la personne connectée peut attribuer : tous pour un admin, sinon ceux qu'elle lit. */
function canAssign(viewer: Viewer, zone: string | null): boolean {
  return zone === null || viewer.real.role === "admin" || canRead(viewer.access, zone)
}

/** Changer le cortex ou retirer : un admin, ou l'auteur s'il peut toujours publier. */
export function canManageSkill(viewer: Viewer, skill: Skill): boolean {
  return viewer.real.role === "admin" || (canPublishSkills(viewer) && skill.author_id === viewer.real.id)
}

export async function listVisibleSkills(viewer: Viewer): Promise<Skill[]> {
  return (await getStore().listSkills()).filter((s) => canSeeSkill(viewer, s))
}

/** Vérifie que le cortex existe et que la personne peut l'attribuer ; renvoie son nom. */
async function checkZone(viewer: Viewer, zone: string | null): Promise<string | null> {
  if (zone === null) return null
  const found = (await getStore().listZones()).find((z) => z.id === zone)
  if (!found) throw new SkillError(400, `Cortex inconnu : « ${zone} ».`)
  if (!canAssign(viewer, zone)) throw new SkillError(403, "Vous ne pouvez attribuer un skill qu'à un cortex auquel vous avez accès.")
  return found.name
}

/** Néon : le cortex du skill s'allume (tout le cerveau pour un skill de toute l'entreprise). */
async function emitSkillEvent(viewer: Viewer, skill: Skill, summary: string, agent: AgentName) {
  const store = getStore()
  const zones = skill.zone ? [skill.zone] : (await store.listZones()).map((z) => z.id)
  await store.insertEvents([{ user_id: viewer.real.id, agent, type: "write", zones, summary: truncate(summary, 200), at: new Date().toISOString() }])
}

/** `zone` absent : on garde le cortex de la version précédente (toute l'entreprise pour un nouveau skill). */
export type PublishInput = { name: string; description: string; zone?: string | null; files: SkillFile[]; agent?: AgentName }

/**
 * POST /api/skills — publie un skill, ou une nouvelle version d'un skill du même nom.
 * SKILL.md reçoit l'en-tête `name` / `description` que Claude Code attend ; un fichier qui contient un secret est refusé
 * (on ne réécrit pas un script, on le renvoie à son auteur).
 */
export async function publishSkill(viewer: Viewer, input: PublishInput): Promise<{ skill: Skill; created: boolean }> {
  if (!canPublishSkills(viewer)) throw new SkillError(403, "Publier un skill demande une autorisation : demandez-la à un admin.")
  const files = input.files.map((f) => ({ path: f.path.trim().replace(/^\.\//, ""), content: f.content.replace(/\r\n/g, "\n") }))
  const problems = skillFileProblems(files)
  if (problems.length) throw new SkillError(400, "Skill refusé.", problems)
  const secrets = skillSecrets(files)
  if (secrets.length)
    throw new SkillError(
      400,
      "Skill refusé : il contient un secret. Lisez-le depuis une variable d'environnement plutôt que de l'écrire dans le fichier.",
      secrets.map((s) => `${s.path} : ${s.kinds.join(", ")}`),
    )

  const store = getStore()
  const existing = await store.getSkillByName(input.name)
  // Un skill du même nom rangé dans un cortex que l'on ne lit pas : on n'en dit rien, et on ne l'écrase pas.
  if (existing && !canSeeSkill(viewer, existing)) throw new SkillError(409, `Le nom « ${input.name} » est déjà pris : choisissez-en un autre.`)
  const zone = input.zone === undefined ? (existing?.zone ?? null) : input.zone
  if (existing && !canManageSkill(viewer, existing) && existing.zone !== zone)
    throw new SkillError(403, "Seul l'auteur du skill ou un admin peut changer son cortex.")
  await checkZone(viewer, zone)

  const main = files.find((f) => f.path === SKILL_MAIN_FILE)!
  const front = parseSkillFrontmatter(main.content).data
  const description = (input.description.trim() || front.description?.trim() || existing?.description || "").slice(0, 1024)
  if (!description) throw new SkillError(400, "Décrivez le skill : Claude Code s'appuie sur la description pour savoir quand l'utiliser.")
  const normalized = files.map((f) => (f === main ? { ...f, content: withSkillFrontmatter(f.content, input.name, description) } : f))

  const skill = await store.publishSkill({ name: input.name, description, zone, files: normalized, publisher_id: viewer.real.id })
  const created = skill.version === 1
  await emitSkillEvent(viewer, skill, `Skill ${created ? "publié" : "mis à jour"} : ${skill.name} (v${skill.version})`, input.agent ?? "dashboard")
  return { skill, created }
}

async function managedSkill(viewer: Viewer, id: string): Promise<Skill> {
  const skill = await getStore().getSkill(id)
  if (!skill || !canSeeSkill(viewer, skill)) throw new SkillError(404, "Skill introuvable.")
  if (!canManageSkill(viewer, skill)) throw new SkillError(403, "Seul l'auteur du skill ou un admin peut le modifier.")
  return skill
}

/** PATCH /api/skills/:id — attribue le skill à un cortex (null : toute l'entreprise). */
export async function setSkillZone(viewer: Viewer, id: string, zone: string | null): Promise<Skill> {
  const skill = await managedSkill(viewer, id)
  const zoneName = await checkZone(viewer, zone)
  const updated = (await getStore().updateSkill(skill.id, { zone }))!
  await emitSkillEvent(viewer, updated, `Skill ${updated.name} attribué ${zoneName ? `au cortex ${zoneName}` : "à toute l'entreprise"}`, "dashboard")
  return updated
}

/** DELETE /api/skills/:id — retire le skill du cerveau ; les postes le désinstallent à leur prochaine synchro. */
export async function removeSkill(viewer: Viewer, id: string): Promise<void> {
  const skill = await managedSkill(viewer, id)
  await getStore().deleteSkill(skill.id)
}
