import { BackupError, exportBrain, exportClients, exportFileName, exportSkills, personSheet, teamSheets } from "@/lib/backup"
import { error, withViewer } from "@/lib/http"
import { getStore } from "@/lib/store"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const TYPES = { json: "application/json", md: "text/markdown", csv: "text/csv" } as const
type Format = keyof typeof TYPES

function download(body: string, format: Format, name: string): Response {
  return new Response(body, {
    headers: {
      "content-type": `${TYPES[format]}; charset=utf-8`,
      "content-disposition": `attachment; filename="${name}"`,
      "cache-control": "no-store",
    },
  })
}

const asJson = (data: unknown) => `${JSON.stringify(data, null, 2)}\n`

/**
 * Downloads an export:
 * - `what=brain` (admins): the whole brain, JSON;
 * - `what=skills`: the skills the reader receives, JSON;
 * - `what=clients`: the clients of the readable zones, `format=csv` (a row per client) or JSON (with their knowledge);
 * - `what=person&id=…`: an employee's sheet (admins, or the employee), `format=md` or JSON (to import it elsewhere);
 * - `what=team` (admins): every employee's sheet, Markdown.
 */
export const GET = withViewer(async (req, viewer) => {
  const url = new URL(req.url)
  const what = url.searchParams.get("what")
  const format = (url.searchParams.get("format") ?? "json") as Format
  if (!(format in TYPES)) return error(400, "Unknown format: json, md or csv.")
  try {
    const org = (await getStore().getOrg()).name
    switch (what) {
      case "brain":
        return download(asJson(await exportBrain(viewer)), "json", exportFileName(org, "brain", "json"))
      case "skills":
        return download(asJson(await exportSkills(viewer)), "json", exportFileName(org, "skills", "json"))
      case "clients": {
        const { backup, csv } = await exportClients(viewer)
        return format === "csv" ? download(csv, "csv", exportFileName(org, "clients", "csv")) : download(asJson(backup), "json", exportFileName(org, "clients", "json"))
      }
      case "person": {
        const id = url.searchParams.get("id") ?? viewer.real.id
        const sheet = await personSheet(viewer, id)
        if (!sheet) return error(404, "Person not found.")
        return format === "md"
          ? download(sheet.markdown, "md", exportFileName(sheet.sheet.person.name, "sheet", "md"))
          : download(asJson(sheet.backup), "json", exportFileName(sheet.sheet.person.name, "sheet", "json"))
      }
      case "team":
        return download(await teamSheets(viewer), "md", exportFileName(org, "team-sheets", "md"))
      default:
        return error(400, "Unknown export: brain, skills, clients, person or team.")
    }
  } catch (err) {
    if (err instanceof BackupError) return error(err.status, err.message, err.details)
    throw err
  }
})
