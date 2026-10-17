import { z } from "zod"
import { getStore } from "@/lib/store"
import { canRead } from "@/lib/access"
import { error, json, parseBody, withViewer } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ id: string }> }
const Schema = z.object({ status: z.enum(["open", "done"]) })

export const PATCH = withViewer<Ctx>(async (req, viewer, { params }) => {
  const { id } = await params
  const body = await parseBody(req, Schema)
  if ("response" in body) return body.response
  const store = getStore()
  const task = (await store.listTasks({ zones: viewer.access.readable })).find((t) => t.id === id)
  if (!task || !canRead(viewer.access, task.zone)) return error(404, "Task not found.")
  return json(await store.updateTask(id, body.data))
})
