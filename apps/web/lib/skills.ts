// Company skills: publishing with permission, assignment to a cortex (zone), distribution to the workstations.
//
// Visibility: a skill without a cortex goes to the whole company; assigned to a cortex, it is only given (dashboard, `brain.mjs
// skills`) to whoever reads that zone. Admins see everything. Same rule as the "skills per cortex" RLS policy.
// Publishing: reserved to admins and members with the `can_publish_skills` right, and only to a cortex
// they read themselves. Changing the cortex or removing a skill: an admin, or its author if they still have that right.

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

/** Expected refusal (permission, cortex, secret…): its status and message; any other error goes up to withViewer (500). */
export function skillErrorResponse(err: unknown): Response {
  if (err instanceof SkillError) return error(err.status, err.message, err.details)
  throw err
}

/** Right to publish, carried by the person actually signed in (not the one an admin "views as"). */
export function canPublishSkills(viewer: Viewer): boolean {
  return viewer.real.role === "admin" || viewer.real.can_publish_skills === true
}

export function canSeeSkill(viewer: Viewer, skill: Pick<Skill, "zone">): boolean {
  return skill.zone === null || canRead(viewer.access, skill.zone)
}

/** Cortexes the signed-in person can assign: all for an admin, otherwise those they read. */
function canAssign(viewer: Viewer, zone: string | null): boolean {
  return zone === null || viewer.real.role === "admin" || canRead(viewer.access, zone)
}

/** Changing the cortex or removing: an admin, or the author if they can still publish. */
export function canManageSkill(viewer: Viewer, skill: Skill): boolean {
  return viewer.real.role === "admin" || (canPublishSkills(viewer) && skill.author_id === viewer.real.id)
}

export async function listVisibleSkills(viewer: Viewer): Promise<Skill[]> {
  return (await getStore().listSkills()).filter((s) => canSeeSkill(viewer, s))
}

/** Checks that the cortex exists and that the person can assign it; returns its name. */
async function checkZone(viewer: Viewer, zone: string | null): Promise<string | null> {
  if (zone === null) return null
  const found = (await getStore().listZones()).find((z) => z.id === zone)
  if (!found) throw new SkillError(400, `Unknown cortex: "${zone}".`)
  if (!canAssign(viewer, zone)) throw new SkillError(403, "You can only assign a skill to a cortex you have access to.")
  return found.name
}

/** Neon: the skill's cortex lights up (the whole brain for a company-wide skill). */
async function emitSkillEvent(viewer: Viewer, skill: Skill, summary: string, agent: AgentName) {
  const store = getStore()
  const zones = skill.zone ? [skill.zone] : (await store.listZones()).map((z) => z.id)
  await store.insertEvents([{ user_id: viewer.real.id, agent, type: "write", zones, summary: truncate(summary, 200), at: new Date().toISOString() }])
}

/** `zone` absent: the previous version's cortex is kept (the whole company for a new skill). */
export type PublishInput = { name: string; description: string; zone?: string | null; files: SkillFile[]; agent?: AgentName }

/**
 * POST /api/skills — publishes a skill, or a new version of a skill with the same name.
 * SKILL.md gets the `name` / `description` front matter Claude Code expects; a file containing a secret is refused
 * (we don't rewrite a script, we send it back to its author).
 */
export async function publishSkill(viewer: Viewer, input: PublishInput): Promise<{ skill: Skill; created: boolean }> {
  if (!canPublishSkills(viewer)) throw new SkillError(403, "Publishing a skill requires permission: ask an admin for it.")
  const files = input.files.map((f) => ({ path: f.path.trim().replace(/^\.\//, ""), content: f.content.replace(/\r\n/g, "\n") }))
  const problems = skillFileProblems(files)
  if (problems.length) throw new SkillError(400, "Skill refused.", problems)
  const secrets = skillSecrets(files)
  if (secrets.length)
    throw new SkillError(
      400,
      "Skill refused: it contains a secret. Read it from an environment variable rather than writing it in the file.",
      secrets.map((s) => `${s.path}: ${s.kinds.join(", ")}`),
    )

  const store = getStore()
  const existing = await store.getSkillByName(input.name)
  // A skill with the same name filed in a cortex we don't read: we say nothing about it, and we don't overwrite it.
  if (existing && !canSeeSkill(viewer, existing)) throw new SkillError(409, `The name "${input.name}" is already taken: choose another one.`)
  const zone = input.zone === undefined ? (existing?.zone ?? null) : input.zone
  if (existing && !canManageSkill(viewer, existing) && existing.zone !== zone)
    throw new SkillError(403, "Only the skill's author or an admin can change its cortex.")
  await checkZone(viewer, zone)

  const main = files.find((f) => f.path === SKILL_MAIN_FILE)!
  const front = parseSkillFrontmatter(main.content).data
  const description = (input.description.trim() || front.description?.trim() || existing?.description || "").slice(0, 1024)
  if (!description) throw new SkillError(400, "Describe the skill: Claude Code relies on the description to know when to use it.")
  const normalized = files.map((f) => (f === main ? { ...f, content: withSkillFrontmatter(f.content, input.name, description) } : f))

  const skill = await store.publishSkill({ name: input.name, description, zone, files: normalized, publisher_id: viewer.real.id })
  const created = skill.version === 1
  await emitSkillEvent(viewer, skill, `Skill ${created ? "published" : "updated"}: ${skill.name} (v${skill.version})`, input.agent ?? "dashboard")
  return { skill, created }
}

async function managedSkill(viewer: Viewer, id: string): Promise<Skill> {
  const skill = await getStore().getSkill(id)
  if (!skill || !canSeeSkill(viewer, skill)) throw new SkillError(404, "Skill not found.")
  if (!canManageSkill(viewer, skill)) throw new SkillError(403, "Only the skill's author or an admin can change it.")
  return skill
}

/** PATCH /api/skills/:id — assigns the skill to a cortex (null: the whole company). */
export async function setSkillZone(viewer: Viewer, id: string, zone: string | null): Promise<Skill> {
  const skill = await managedSkill(viewer, id)
  const zoneName = await checkZone(viewer, zone)
  const updated = (await getStore().updateSkill(skill.id, { zone }))!
  await emitSkillEvent(viewer, updated, `Skill ${updated.name} assigned ${zoneName ? `to the ${zoneName} cortex` : "to the whole company"}`, "dashboard")
  return updated
}

/** DELETE /api/skills/:id — removes the skill from the brain; workstations uninstall it at their next sync. */
export async function removeSkill(viewer: Viewer, id: string): Promise<void> {
  const skill = await managedSkill(viewer, id)
  await getStore().deleteSkill(skill.id)
}
