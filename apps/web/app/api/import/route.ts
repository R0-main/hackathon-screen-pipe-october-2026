import { z } from "zod"
import { parseBackup } from "@brain/core"
import { BackupError, clientsCsvBackup, importBackup } from "@/lib/backup"
import { error, json, parseBody, withViewer } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** A whole brain fits well below this; beyond, the file is refused before being read. */
const MAX_BYTES = 25 * 1024 * 1024

// The spreadsheet first: `backup: unknown` would also accept a body without a backup.
const Schema = z.union([
  z.object({ clients_csv: z.string().min(1).max(5_000_000), zone: z.string().max(64).nullable().optional(), dry_run: z.boolean().default(false) }),
  z.object({ backup: z.unknown(), dry_run: z.boolean().default(false) }),
])

/**
 * Imports a file into the signed-in person's company: a NOS Brainer export (`backup`), or a spreadsheet of clients
 * (`clients_csv`). `dry_run`: the report of what would be added, without writing anything.
 */
export const POST = withViewer(async (req, viewer) => {
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BYTES) return error(413, "File too large (25 MB at most).")
  const body = await parseBody(req, Schema)
  if ("response" in body) return body.response
  try {
    let warnings: string[] = []
    let backup
    if ("clients_csv" in body.data) {
      const read = await clientsCsvBackup(body.data.clients_csv, body.data.zone)
      backup = read.backup
      warnings = read.problems
    } else {
      const parsed = parseBackup(body.data.backup)
      if ("problems" in parsed) return error(400, "This file cannot be imported.", parsed.problems)
      backup = parsed.backup
    }
    const report = await importBackup(viewer, backup, { dryRun: body.data.dry_run })
    report.warnings.unshift(...warnings)
    return json(report)
  } catch (err) {
    if (err instanceof BackupError) return error(err.status, err.message, err.details)
    throw err
  }
})
