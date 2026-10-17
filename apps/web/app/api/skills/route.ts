import { SkillPublishSchema } from "@brain/core"
import { canManageSkill, canPublishSkills, listVisibleSkills, publishSkill, skillErrorResponse } from "@/lib/skills"
import { json, parseBody, withViewer } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** Skills the person receives (whole company + their cortexes), files included: this is what the workstation installs. */
export const GET = withViewer(async (_req, viewer) => {
  const skills = await listVisibleSkills(viewer)
  return json({
    can_publish: canPublishSkills(viewer),
    skills: skills.map((s) => ({ ...s, can_manage: canManageSkill(viewer, s) })),
  })
})

/** Publishes a skill (or its next version): admins and authorized members only. */
export const POST = withViewer(async (req, viewer) => {
  const body = await parseBody(req, SkillPublishSchema)
  if ("response" in body) return body.response
  try {
    const { skill, created } = await publishSkill(viewer, body.data)
    return json(skill, created ? 201 : 200)
  } catch (err) {
    return skillErrorResponse(err)
  }
})
