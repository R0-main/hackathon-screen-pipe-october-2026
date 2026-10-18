"use client"

import { useRef, useState, type ReactNode } from "react"
import type { ImportReport } from "@/lib/backup"
import { api, errorMessage } from "./format"
import { ErrorText } from "./ui"

type Person = { id: string; name: string; title?: string }
type ZoneOption = { id: string; name: string }

type Props = {
  isAdmin: boolean
  canPublish: boolean
  meId: string
  people: Person[]
  zones: ZoneOption[]
}

/** What the import box holds: a NOS Brainer export (JSON) or a spreadsheet of clients (CSV). */
type Pending = { name: string; body: { backup: unknown } | { clients_csv: string; zone: string | null }; preview: ImportReport }

const KIND_LABEL: Record<ImportReport["kind"], string> = {
  brain: "a whole brain",
  skills: "skills",
  clients: "clients",
  person: "an employee sheet",
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

function ExportLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} download className="btn btn-sm">
      {children}
    </a>
  )
}

function ExportRow({ title, lead, children }: { title: string; lead: string; children: ReactNode }) {
  return (
    <li className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 space-y-0.5">
        <h3 className="text-[14px] font-medium">{title}</h3>
        <p className="text-[13px] text-trace">{lead}</p>
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">{children}</div>
    </li>
  )
}

function ReportLines({ r }: { r: ImportReport }) {
  const verb = r.dry_run ? "Will add" : "Added"
  const lines: string[] = []
  if (r.zones.added.length) lines.push(`${verb} ${plural(r.zones.added.length, "zone")}: ${r.zones.added.join(", ")}`)
  if (r.people.created.length) lines.push(`${verb} ${plural(r.people.created.length, "person", "people")}: ${r.people.created.join(", ")}`)
  if (r.people.matched) lines.push(`${plural(r.people.matched, "person", "people")} already in the brain, matched by email or name`)
  lines.push(`${verb} ${plural(r.items.added, "knowledge item")}${r.items.skipped ? `, ${r.items.skipped} already there` : ""}`)
  if (r.tasks.added || r.tasks.skipped) lines.push(`${verb} ${plural(r.tasks.added, "task")}${r.tasks.skipped ? `, ${r.tasks.skipped} already there` : ""}`)
  if (r.skills.published.length) lines.push(`${r.dry_run ? "Will publish" : "Published"} ${plural(r.skills.published.length, "skill")}: ${r.skills.published.join(", ")}`)
  if (r.skills.unchanged.length) lines.push(`${plural(r.skills.unchanged.length, "skill")} unchanged: ${r.skills.unchanged.join(", ")}`)
  return (
    <div className="space-y-2">
      <ul className="space-y-1 text-[13px]">
        {lines.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
      {r.skills.refused.length > 0 && (
        <ul className="space-y-1 text-[13px] text-danger">
          {r.skills.refused.map((s) => (
            <li key={s.name}>
              Skill {s.name} refused: {s.reason}
            </li>
          ))}
        </ul>
      )}
      {r.warnings.length > 0 && (
        <ul className="space-y-1 text-[13px] text-trace">
          {r.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Import and export: the whole brain, skills, clients, employee sheets. */
export function DataPanel({ isAdmin, canPublish, meId, people, zones }: Props) {
  const [person, setPerson] = useState(meId)
  const [zone, setZone] = useState("")
  const [pending, setPending] = useState<Pending | null>(null)
  const [done, setDone] = useState<{ name: string; report: ImportReport } | null>(null)
  const [busy, setBusy] = useState<"read" | "import" | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const canImport = isAdmin || canPublish

  async function read(file: File | undefined) {
    if (!file) return
    setErr(null)
    setDone(null)
    setPending(null)
    setBusy("read")
    try {
      const text = await file.text()
      let body: Pending["body"]
      if (/\.csv$/i.test(file.name) || !text.trimStart().startsWith("{")) body = { clients_csv: text, zone: zone || null }
      else {
        try {
          body = { backup: JSON.parse(text) }
        } catch {
          throw new Error("This file is not valid JSON.")
        }
      }
      const preview = await api<ImportReport>("/api/import", { method: "POST", json: { ...body, dry_run: true } })
      setPending({ name: file.name, body, preview })
    } catch (e) {
      setErr(errorMessage(e))
    } finally {
      setBusy(null)
      if (input.current) input.current.value = ""
    }
  }

  async function confirm() {
    if (!pending) return
    setErr(null)
    setBusy("import")
    try {
      const report = await api<ImportReport>("/api/import", { method: "POST", json: { ...pending.body, dry_run: false } })
      setDone({ name: pending.name, report })
      setPending(null)
    } catch (e) {
      setErr(`Import failed: ${errorMessage(e)}`)
    } finally {
      setBusy(null)
    }
  }

  const nothingToDo =
    pending &&
    pending.preview.items.added === 0 &&
    pending.preview.tasks.added === 0 &&
    pending.preview.zones.added.length === 0 &&
    pending.preview.people.created.length === 0 &&
    pending.preview.skills.published.length === 0

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-[22px] font-medium leading-tight">Import and export</h1>
        <p className="mt-1 max-w-3xl text-[13px] text-trace">
          Take the brain with you, move it to another company, or bring in what you already have. An export only holds what you can read; an import only
          adds, and what is already in the brain is skipped.
        </p>
      </div>

      <section className="panel p-4 sm:p-5">
        <h2 className="panel-title">Export</h2>
        <ul className="mt-4 divide-y divide-line">
          {isAdmin && (
            <ExportRow title="Company brain" lead="Zones, people and their access, current knowledge, tasks and skills. Tokens are never exported.">
              <ExportLink href="/api/export?what=brain">Download JSON</ExportLink>
            </ExportRow>
          )}
          <ExportRow title="Skills" lead="The skills you receive, with their scripts, to install in another brain.">
            <ExportLink href="/api/export?what=skills">Download JSON</ExportLink>
          </ExportRow>
          <ExportRow title="Clients" lead="Every client cited in your zones: a spreadsheet with one row per client, or the knowledge about them.">
            <ExportLink href="/api/export?what=clients&format=csv">Spreadsheet (CSV)</ExportLink>
            <ExportLink href="/api/export?what=clients">Knowledge (JSON)</ExportLink>
          </ExportRow>
          <ExportRow
            title="Employee sheet"
            lead="Who they are, where they work, and who did what: decisions, procedures, tasks, clients and tools, frequent prompts, skills."
          >
            {isAdmin && people.length > 1 && (
              <select aria-label="Person" className="input input-sm !w-auto" value={person} onChange={(e) => setPerson(e.target.value)}>
                {people.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {p.id === meId ? " (you)" : ""}
                  </option>
                ))}
              </select>
            )}
            <ExportLink href={`/api/export?what=person&id=${encodeURIComponent(person)}&format=md`}>Sheet (Markdown)</ExportLink>
            <ExportLink href={`/api/export?what=person&id=${encodeURIComponent(person)}`}>Data (JSON)</ExportLink>
          </ExportRow>
          {isAdmin && (
            <ExportRow title="Whole team" lead="Every employee's sheet, in a single Markdown document.">
              <ExportLink href="/api/export?what=team">All sheets (Markdown)</ExportLink>
            </ExportRow>
          )}
        </ul>
      </section>

      {canImport && (
        <section className="panel space-y-4 p-4 sm:p-5">
          <div className="space-y-1">
            <h2 className="panel-title">Import</h2>
            <p className="text-[13px] text-trace">
              {isAdmin
                ? "A file exported from a NOS Brainer brain (brain, skills, clients or an employee sheet), or a spreadsheet of clients in CSV: name, zone, notes, and any other column. People are matched by email, then by name; the others are created without a computer."
                : "A skills file exported from a NOS Brainer brain. Importing knowledge or people is for admins."}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <label className={`btn btn-sm cursor-pointer ${busy ? "pointer-events-none opacity-60" : ""}`}>
              {busy === "read" ? "Reading the file…" : "Choose a file"}
              <input
                ref={input}
                type="file"
                accept={isAdmin ? ".json,.csv,application/json,text/csv" : ".json,application/json"}
                className="sr-only"
                disabled={busy !== null}
                onChange={(e) => void read(e.target.files?.[0])}
              />
            </label>
            {isAdmin && zones.length > 0 && (
              <label className="flex items-center gap-2 text-[13px] text-trace">
                Clients without a zone go to
                <select className="input input-sm !w-auto" value={zone} onChange={(e) => (setZone(e.target.value), setPending(null))} disabled={busy !== null}>
                  <option value="">the closest zone</option>
                  {zones.map((z) => (
                    <option key={z.id} value={z.id}>
                      {z.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>

          {err && <ErrorText>{err}</ErrorText>}

          {pending && (
            <div className="inset space-y-3 p-4">
              <p className="text-[13px]">
                <span className="font-medium">{pending.name}</span>
                <span className="text-trace"> holds {KIND_LABEL[pending.preview.kind]}.</span>
              </p>
              <ReportLines r={pending.preview} />
              <div className="flex flex-wrap gap-2 pt-1">
                <button type="button" className="btn btn-primary btn-sm" onClick={confirm} disabled={busy !== null || Boolean(nothingToDo)}>
                  {busy === "import" ? "Importing…" : nothingToDo ? "Nothing new to import" : "Import"}
                </button>
                <button type="button" className="btn btn-sm" onClick={() => setPending(null)} disabled={busy !== null}>
                  Cancel
                </button>
              </div>
            </div>
          )}

          {done && (
            <div className="inset space-y-2 p-4" role="status">
              <p className="text-[13px] font-medium">{done.name} imported.</p>
              <ReportLines r={done.report} />
            </div>
          )}
        </section>
      )}
    </div>
  )
}
