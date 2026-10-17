import { z } from "zod"
import { removeSkill, setSkillZone, skillErrorResponse } from "@/lib/skills"
import { json, parseBody, withViewer } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ id: string }> }

const Schema = z.object({ zone: z.string().min(1).max(64).nullable() })

/** Assigns the skill to a cortex (`zone`), or to the whole company (`null`). */
export const PATCH = withViewer<Ctx>(async (req, viewer, { params }) => {
  const { id } = await params
  const body = await parseBody(req, Schema)
  if ("response" in body) return body.response
  try {
    return json(await setSkillZone(viewer, id, body.data.zone))
  } catch (err) {
    return skillErrorResponse(err)
  }
})

/** Removes the skill: workstations uninstall it at their next sync. */
export const DELETE = withViewer<Ctx>(async (_req, viewer, { params }) => {
  const { id } = await params
  try {
    await removeSkill(viewer, id)
    return json({ deleted: id })
  } catch (err) {
    return skillErrorResponse(err)
  }
})
