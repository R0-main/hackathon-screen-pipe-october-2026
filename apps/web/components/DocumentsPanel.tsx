"use client"

import { useMemo, useRef, useState } from "react"
import { DOCUMENT_FORMATS, DOCUMENT_MAX_BYTES, formatBytes, type AddDocumentResult, type BrainDocument } from "@brain/core"
import { PageScroll } from "./AppShell"
import { useBrainLive } from "./BrainLive"
import { documentHref } from "./DocumentLinks"
import { api, errorMessage, firstName } from "./format"
import { RelTime } from "./RelTime"
import { CloseIcon, Dot, ErrorText, PaperclipIcon, SearchIcon, ZoneTag, zoneColor } from "./ui"

const ACCEPT = DOCUMENT_FORMATS.map((f) => `.${f.ext}`).join(",")
const AUTO = "__auto__"
const ALL = "__all__"

/** The file in base64, without the data: URL prefix. */
function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""))
    reader.onerror = () => reject(new Error("Could not read the file."))
    reader.readAsDataURL(file)
  })
}

/**
 * The Documents page: the files (PDF, Word, Excel…) kept in the brain with the knowledge they back, in the zones the
 * person reads. Most arrive with the sync, from the sessions that worked on them; one can also be added here.
 */
export function DocumentsView({ initial }: { initial: BrainDocument[] }) {
  const { state, now, refresh } = useBrainLive()
  const [docs, setDocs] = useState(initial)
  const [zone, setZone] = useState(ALL)
  const [q, setQ] = useState("")
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const readable = state.zones.filter((z) => !z.locked)
  const zoneById = useMemo(() => new Map(state.zones.map((z) => [z.id, z])), [state.zones])
  const isAdmin = state.real.role === "admin"

  const shown = useMemo(() => {
    const terms = q.trim().toLowerCase().split(/\s+/).filter(Boolean)
    return docs.filter((d) => (zone === ALL || d.zone === zone) && terms.every((t) => `${d.name} ${d.title} ${d.summary}`.toLowerCase().includes(t)))
  }, [docs, zone, q])

  async function reload() {
    setDocs((await api<{ documents: BrainDocument[] }>("/api/documents")).documents)
    refresh()
  }

  async function remove(d: BrainDocument) {
    if (!window.confirm(`Remove ${d.name} from the brain? The knowledge it backs stays.`)) return
    setBusy(d.id)
    setErr(null)
    try {
      await api(`/api/documents/${d.id}`, { method: "DELETE" })
      await reload()
    } catch (e) {
      setErr(`Could not remove ${d.name}: ${errorMessage(e)}`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <PageScroll width="max-w-[960px]">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 max-w-2xl">
          <h1 className="text-[22px] font-medium leading-tight">Documents</h1>
          <p className="mt-1 text-[13px] leading-relaxed text-trace">
            The files behind the knowledge: the revenue report a figure comes from, a price list, a contract template. The sync
            sends the ones an AI session worked on, with what it learned from them; agents read them with get_document. Same
            rights as the knowledge: only the zones you read.
          </p>
        </div>
        {/* One primary button per view: the form's, once it is open. */}
        {!adding && (
          <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>
            Add a document
          </button>
        )}
      </header>

      {adding && (
        <AddDocument
          zones={readable}
          onClose={() => setAdding(false)}
          onAdded={async () => {
            setAdding(false)
            await reload()
          }}
        />
      )}

      {docs.length === 0 ? (
        <p className="mt-8 max-w-[60ch] text-[14px] text-trace">
          No document yet. They arrive with the knowledge of the sessions that use them (a PDF Claude Code read, a spreadsheet
          dropped in a prompt), or with <span className="mono">brain docs add &lt;file&gt;</span>.
        </p>
      ) : (
        <>
          <div className="mt-5 space-y-3">
            <div className="relative max-w-xl">
              <SearchIcon className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-trace" />
              <input
                type="search"
                className="input !pl-9"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search a name, a title…"
                aria-label="Search documents"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by zone">
              <button type="button" className={`chip ${zone === ALL ? "chip-on" : ""}`} aria-pressed={zone === ALL} onClick={() => setZone(ALL)}>
                All
              </button>
              {readable
                .filter((z) => docs.some((d) => d.zone === z.id))
                .map((z) => (
                  <button key={z.id} type="button" className={`chip ${zone === z.id ? "chip-on" : ""}`} aria-pressed={zone === z.id} onClick={() => setZone(z.id)}>
                    <Dot color={zoneColor(z.color, z.position)} />
                    {z.name}
                    <span className={`tabular-nums ${zone === z.id ? "text-line-strong" : "text-trace"}`}>{docs.filter((d) => d.zone === z.id).length}</span>
                  </button>
                ))}
            </div>
          </div>
          {err && <ErrorText className="mt-4">{err}</ErrorText>}
          <ul className="mt-5 space-y-2">
            {shown.map((d) => {
              const z = zoneById.get(d.zone)
              const canDelete = isAdmin || d.author_id === state.real.id
              return (
                <li key={d.id} className="rounded-[8px] border border-line bg-surface p-4">
                  <div className="flex items-start gap-3">
                    <PaperclipIcon className="mt-0.5 shrink-0 text-trace" aria-hidden />
                    <div className="min-w-0 flex-1">
                      <a href={documentHref(d.id)} target="_blank" rel="noopener" className="text-[14px] font-medium leading-snug hover:underline [overflow-wrap:anywhere]">
                        {d.title}
                      </a>
                      <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-trace">
                        <span className="text-ink [overflow-wrap:anywhere]">{d.name}</span>
                        <span className="tabular-nums">
                          {formatBytes(d.size)}
                          {d.pages ? `, ${d.pages} page${d.pages > 1 ? "s" : ""}` : ""}
                        </span>
                        {z && <ZoneTag name={z.name} color={zoneColor(z.color, z.position)} />}
                        <span>
                          {firstName(state.names[d.author_id] ?? "?")}, <RelTime iso={d.created_at} now={now} />
                        </span>
                        {d.item_ids.length > 0 && <span className="tabular-nums">backs {d.item_ids.length} knowledge item{d.item_ids.length > 1 ? "s" : ""}</span>}
                      </p>
                      {d.summary && <p className="mt-2 line-clamp-2 max-w-[72ch] text-[13px] leading-relaxed text-trace">{d.summary}</p>}
                    </div>
                    {canDelete && (
                      <button type="button" className="btn btn-icon" onClick={() => void remove(d)} disabled={busy === d.id} aria-label={`Remove ${d.name}`}>
                        <CloseIcon size={14} />
                      </button>
                    )}
                  </div>
                </li>
              )
            })}
            {shown.length === 0 && <p className="text-[14px] text-trace">No document matches.</p>}
          </ul>
        </>
      )}
    </PageScroll>
  )
}

/** Adding a document by hand: checked by the brain like the sync's (secret, personal data: refused). */
function AddDocument({ zones, onClose, onAdded }: { zones: { id: string; name: string; color: string; position: number }[]; onClose: () => void; onAdded: () => Promise<void> }) {
  const [file, setFile] = useState<File | null>(null)
  const [zone, setZone] = useState(AUTO)
  const [title, setTitle] = useState("")
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!file) return
    if (file.size > DOCUMENT_MAX_BYTES) {
      setErr(`${file.name} is too large (${formatBytes(file.size)}): ${formatBytes(DOCUMENT_MAX_BYTES)} at most.`)
      return
    }
    setBusy(true)
    setErr(null)
    try {
      const content = await readBase64(file)
      await api<AddDocumentResult>("/api/documents", {
        method: "POST",
        json: { name: file.name, content, zone: zone === AUTO ? undefined : zone, title: title.trim() || undefined, source: { app: "dashboard", tool: "agent" }, agent: "dashboard" },
      })
      await onAdded()
    } catch (e) {
      setErr(errorMessage(e))
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="panel mt-5 space-y-4 p-4">
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-[15px] font-medium">Add a document</h2>
        <button type="button" className="btn btn-icon" onClick={onClose} aria-label="Close">
          <CloseIcon size={14} />
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <label className="btn cursor-pointer">
          {file ? "Choose another file" : "Choose a file"}
          <input ref={input} type="file" accept={ACCEPT} className="sr-only" disabled={busy} onChange={(e) => (setFile(e.target.files?.[0] ?? null), setErr(null))} />
        </label>
        <span className="text-[13px] text-trace">{file ? `${file.name}, ${formatBytes(file.size)}` : `PDF, Word, Excel, PowerPoint, CSV, Markdown or text, ${formatBytes(DOCUMENT_MAX_BYTES)} at most`}</span>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1.5 block text-[13px] font-medium">Zone</span>
          <select className="input" value={zone} onChange={(e) => setZone(e.target.value)} disabled={busy}>
            <option value={AUTO}>From its content</option>
            {zones.map((z) => (
              <option key={z.id} value={z.id}>
                {z.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1.5 block text-[13px] font-medium">Title</span>
          <input className="input" value={title} maxLength={160} placeholder="From the file name" onChange={(e) => setTitle(e.target.value)} disabled={busy} />
        </label>
      </div>
      <p className="text-[12px] leading-relaxed text-trace">
        The brain reads the file and refuses it if it holds a secret (API key, password) or personal data (payslip, ID, a
        list of customers&apos; emails). Only the people who read its zone can open it.
      </p>
      {err && <ErrorText>{err}</ErrorText>}
      <div className="flex justify-end">
        <button type="submit" className="btn btn-primary" disabled={!file || busy}>
          {busy ? "Sending…" : "Add to the brain"}
        </button>
      </div>
    </form>
  )
}
