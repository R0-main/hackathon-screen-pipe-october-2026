"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { SKILL_MAIN_FILE, parseSkillFrontmatter, skillSlug, type Skill, type SkillFile } from "@brain/core"
import type { ZoneView } from "@/lib/brain"
import { PageScroll } from "./AppShell"
import { useBrainLive } from "./BrainLive"
import { api, errorMessage, firstName } from "./format"
import { RelTime } from "./RelTime"
import { CloseIcon, Dot, ErrorText, LockIcon, ZoneTag, zoneColor } from "./ui"

type ApiSkill = Skill & { can_manage: boolean }

const COMPANY = "__company__"
const CLI_PUSH = "~/.company-brain/brain skills push ./my-skill --cortex finance"

/**
 * The Skills tab: the company's skills (SKILL.md and their scripts) grouped by cortex. Each person only sees the
 * company-wide ones and those of the cortexes they read; these are also the ones their computer installs in ~/.claude/skills.
 */
export function SkillsView() {
  const { state, now, refresh } = useBrainLive()
  const [skills, setSkills] = useState<ApiSkill[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [publishing, setPublishing] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const isAdmin = state.real.role === "admin"
  const canPublish = state.can_publish_skills

  const load = useCallback(async () => {
    try {
      setSkills((await api<{ skills: ApiSkill[] }>("/api/skills")).skills)
    } catch (e) {
      setErr(`Could not load the skills: ${errorMessage(e)}`)
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  // Cortexes one can assign: all for an admin, otherwise those one reads.
  const assignable = state.zones.filter((z) => isAdmin || !z.locked)
  const groups = useMemo(() => {
    const list = skills ?? []
    const out: { id: string; zone: ZoneView | null; skills: ApiSkill[] }[] = [{ id: COMPANY, zone: null, skills: list.filter((s) => s.zone === null) }]
    for (const z of state.zones) out.push({ id: z.id, zone: z, skills: list.filter((s) => s.zone === z.id) })
    return out.filter((g) => g.skills.length > 0)
  }, [skills, state.zones])

  async function act(s: ApiSkill, run: () => Promise<unknown>, what: string) {
    setBusy(s.id)
    setErr(null)
    try {
      await run()
      await load()
      refresh()
    } catch (e) {
      setErr(`${what} failed for ${s.name}: ${errorMessage(e)}`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <PageScroll>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 max-w-2xl">
          <h1 className="text-[22px] font-medium leading-tight">Company skills</h1>
          <p className="mt-1 text-[13px] leading-relaxed text-trace">
            Ready-to-use know-how for Claude Code, with the scripts it uses. A skill assigned to a cortex is only given to the
            people who have access to that context; each computer installs its own in ~/.claude/skills at every sync.
          </p>
        </div>
        {canPublish ? (
          <button type="button" className="btn btn-primary" onClick={() => setPublishing(true)}>
            Publish a skill
          </button>
        ) : (
          <p className="inset flex max-w-xs items-start gap-2 px-3 py-2 text-[12px] leading-snug">
            <LockIcon size={14} className="mt-px shrink-0" />
            Publishing a skill requires permission: ask an admin for it.
          </p>
        )}
      </header>

      {err && <ErrorText className="mt-4">{err}</ErrorText>}

      <div className="mt-6 space-y-6" aria-busy={skills === null}>
        {skills === null && !err && <p className="text-[13px] text-trace">Loading skills…</p>}
        {skills !== null && groups.length === 0 && (
          <p className="panel p-5 text-[13px] text-trace">
            No skill for you yet.{" "}
            {canPublish ? "Publish the first one: a folder with a SKILL.md, and the scripts it uses." : "They will show up here as soon as an authorized person publishes one."}
          </p>
        )}
        {groups.map((g) => (
          <section key={g.id} aria-labelledby={`cortex-${g.id}`}>
            <h2 id={`cortex-${g.id}`} className="mb-2.5 flex items-baseline gap-2 text-[15px] font-medium">
              {g.zone ? <ZoneTag name={`${g.zone.name} cortex`} color={zoneColor(g.zone.color, g.zone.position)} /> : "The whole company"}
              <span className="text-[12px] font-normal tabular-nums text-trace">{g.skills.length}</span>
            </h2>
            <div className="grid gap-2.5 md:grid-cols-2">
              {g.skills.map((s) => (
                <SkillCard
                  key={s.id}
                  skill={s}
                  names={state.names}
                  zones={assignable}
                  now={now}
                  busy={busy === s.id}
                  onZone={(zone) => act(s, () => api(`/api/skills/${s.id}`, { method: "PATCH", json: { zone } }), "Changing the cortex")}
                  onDelete={() => {
                    if (confirm(`Remove the skill "${s.name}"? Computers uninstall it at their next sync.`))
                      void act(s, () => api(`/api/skills/${s.id}`, { method: "DELETE" }), "Removal")
                  }}
                />
              ))}
            </div>
          </section>
        ))}
      </div>

      {publishing && (
        <PublishModal
          zones={assignable}
          onClose={() => setPublishing(false)}
          onPublished={() => {
            setPublishing(false)
            void load()
            refresh()
          }}
        />
      )}
    </PageScroll>
  )
}

function SkillCard(props: {
  skill: ApiSkill
  names: Record<string, string>
  zones: ZoneView[]
  now: number
  busy: boolean
  onZone: (zone: string | null) => void
  onDelete: () => void
}) {
  const { skill: s, names } = props
  const [open, setOpen] = useState(false)
  const [file, setFile] = useState(SKILL_MAIN_FILE)
  const shown = s.files.find((f) => f.path === file) ?? s.files[0]
  const scripts = s.files.filter((f) => f.path !== SKILL_MAIN_FILE)
  const author = s.updated_by ? names[s.updated_by] : s.author_id ? names[s.author_id] : undefined
  return (
    <article className="rounded-[6px] border border-line bg-surface p-3.5 transition-colors hover:border-line-strong" aria-busy={props.busy}>
      <button type="button" className="w-full rounded-[4px] text-left" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <div className="flex items-baseline gap-2">
          <h3 className="mono min-w-0 flex-1 truncate text-[13.5px] font-medium">{s.name}</h3>
          <span className="shrink-0 text-[12px] text-trace">
            v{s.version}
            {author ? `, ${firstName(author)}` : ""}, <RelTime iso={s.updated_at} now={props.now} className="tabular-nums" />
          </span>
        </div>
        <p className="mt-1.5 text-[13px] leading-relaxed text-trace">{s.description}</p>
        <div className="mt-2 flex flex-wrap gap-1.5 text-[12px]">
          <span className="chip">SKILL.md</span>
          {scripts.slice(0, 4).map((f) => (
            <span key={f.path} className="chip mono">
              {f.path}
            </span>
          ))}
          {scripts.length > 4 && <span className="chip text-trace">+{scripts.length - 4}</span>}
        </div>
      </button>

      {open && (
        <div className="mt-3 space-y-3 border-t border-line pt-3">
          {s.files.length > 1 && (
            <div className="flex flex-wrap gap-1.5" role="group" aria-label={`Files of ${s.name}`}>
              {s.files.map((f) => (
                <button key={f.path} type="button" className={`chip mono ${f.path === shown.path ? "chip-on" : ""}`} aria-pressed={f.path === shown.path} onClick={() => setFile(f.path)}>
                  {f.path}
                </button>
              ))}
            </div>
          )}
          <pre className="mono scroll-thin inset max-h-80 overflow-auto whitespace-pre-wrap break-words p-3 text-[12px] leading-relaxed">{shown.content}</pre>
          {s.can_manage && (
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex min-w-0 items-center gap-2 text-[13px]">
                <span className="shrink-0">Cortex</span>
                <select className="input input-sm" value={s.zone ?? ""} disabled={props.busy} onChange={(e) => props.onZone(e.target.value || null)}>
                  <option value="">The whole company</option>
                  {props.zones.map((z) => (
                    <option key={z.id} value={z.id}>
                      {z.name}
                    </option>
                  ))}
                </select>
              </label>
              <button type="button" className="btn btn-sm ml-auto" disabled={props.busy} onClick={props.onDelete}>
                Remove
              </button>
            </div>
          )}
        </div>
      )}
    </article>
  )
}

/** Relative path of a file imported from a folder (without the folder itself), or null if it must be ignored. */
function importedPath(file: File): string | null {
  const parts = (file.webkitRelativePath || file.name).split("/")
  if (parts.length > 1) parts.shift()
  if (parts.some((p) => p.startsWith(".") || p === "node_modules" || p === "__pycache__")) return null
  return parts.join("/")
}

function PublishModal({ zones, onClose, onPublished }: { zones: ZoneView[]; onClose: () => void; onPublished: () => void }) {
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [zone, setZone] = useState("")
  const [main, setMain] = useState("")
  const [scripts, setScripts] = useState<SkillFile[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose()
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  /** Takes name and description from the SKILL.md front matter when the fields are still empty. */
  function applyMain(content: string, folder?: string) {
    setMain(content)
    const front = parseSkillFrontmatter(content).data
    if (!name && (front.name || folder)) setName(skillSlug(front.name || folder || ""))
    if (!description && front.description) setDescription(front.description)
  }

  async function addFiles(list: FileList | null) {
    if (!list?.length) return
    setErr(null)
    const added: SkillFile[] = []
    const skipped: string[] = []
    for (const f of Array.from(list)) {
      const path = importedPath(f)
      if (!path) continue
      const content = await f.text()
      if (content.includes("\u0000")) {
        skipped.push(path)
        continue
      }
      if (path === SKILL_MAIN_FILE) applyMain(content, f.webkitRelativePath.split("/")[0] || undefined)
      // A file added on its own (without a folder) goes into scripts/.
      else added.push({ path: f.webkitRelativePath ? path : `scripts/${path}`, content })
    }
    setScripts((prev) => [...prev.filter((p) => !added.some((a) => a.path === p.path)), ...added])
    if (skipped.length) setErr(`Files ignored (not text): ${skipped.join(", ")}`)
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setErr(null)
    try {
      await api("/api/skills", {
        method: "POST",
        json: { name, description, zone: zone || null, files: [{ path: SKILL_MAIN_FILE, content: main }, ...scripts] },
      })
      onPublished()
    } catch (e2) {
      setErr(errorMessage(e2))
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-ink/20 p-4" onClick={onClose}>
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="publish-skill-title"
        className="panel my-auto w-full max-w-2xl space-y-4 p-5"
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
        aria-busy={busy}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id="publish-skill-title" className="text-[18px] font-medium">
              Publish a skill
            </h2>
            <p className="mt-1 text-[13px] text-trace">Same name as an existing skill: it moves to the next version.</p>
          </div>
          <button type="button" className="btn btn-icon shrink-0" onClick={onClose} aria-label="Close">
            <CloseIcon />
          </button>
        </div>

        <div className="flex flex-wrap gap-2">
          <label className="btn btn-sm cursor-pointer">
            Import a folder
            <input
              type="file"
              className="sr-only"
              multiple
              onChange={(e) => void addFiles(e.target.files)}
              {...({ webkitdirectory: "" } as Record<string, string>)}
            />
          </label>
          <label className="btn btn-sm cursor-pointer">
            Add scripts
            <input type="file" className="sr-only" multiple onChange={(e) => void addFiles(e.target.files)} />
          </label>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1.5 block text-[13px] font-medium">Name</span>
            <input className="input mono" required value={name} placeholder="month-end-close" pattern="[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?" onChange={(e) => setName(e.target.value)} />
            <span className="mt-1 block text-[12px] text-trace">Lowercase, digits and dashes: it is the folder name on the computers.</span>
          </label>
          <label className="block">
            <span className="mb-1.5 block text-[13px] font-medium">Cortex</span>
            <select className="input" value={zone} onChange={(e) => setZone(e.target.value)}>
              <option value="">The whole company</option>
              {zones.map((z) => (
                <option key={z.id} value={z.id}>
                  {z.name}
                </option>
              ))}
            </select>
            <span className="mt-1 flex items-center gap-1.5 text-[12px] text-trace">
              {zone ? (
                <>
                  <Dot color={zoneColor(zones.find((z) => z.id === zone)?.color, zones.find((z) => z.id === zone)?.position)} />
                  Only people with access to this cortex receive it.
                </>
              ) : (
                "Everyone receives it."
              )}
            </span>
          </label>
        </div>

        <label className="block">
          <span className="mb-1.5 block text-[13px] font-medium">Description</span>
          <input
            className="input"
            required
            maxLength={1024}
            value={description}
            placeholder="Close the month: Pennylane export and send to the firm before the 5th"
            onChange={(e) => setDescription(e.target.value)}
          />
          <span className="mt-1 block text-[12px] text-trace">Claude Code uses it to know when to use the skill.</span>
        </label>

        <label className="block">
          <span className="mb-1.5 block text-[13px] font-medium">SKILL.md</span>
          <textarea
            className="input mono !h-auto min-h-48 py-2 text-[12px] leading-relaxed"
            required
            rows={10}
            value={main}
            placeholder={"# Month-end close\n\n1. Run scripts/export.py\n2. …"}
            onChange={(e) => setMain(e.target.value)}
          />
        </label>

        <div>
          <span className="mb-1.5 block text-[13px] font-medium">Scripts used by the skill</span>
          {scripts.length === 0 ? (
            <p className="text-[12px] text-trace">None. Import the skill&apos;s folder, or add its scripts.</p>
          ) : (
            <ul className="flex flex-wrap gap-1.5">
              {scripts.map((f) => (
                <li key={f.path} className="chip mono">
                  {f.path}
                  <button type="button" className="-mr-1 rounded-full p-0.5 hover:bg-bone" aria-label={`Remove ${f.path}`} onClick={() => setScripts((prev) => prev.filter((p) => p.path !== f.path))}>
                    <CloseIcon size={12} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <p className="inset px-3 py-2 text-[12px] leading-snug text-trace">
          From a computer: <span className="mono text-ink">{CLI_PUSH}</span>. A file containing a secret (API key, password) is refused: read it
          from an environment variable.
        </p>

        {err && <ErrorText>{err}</ErrorText>}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? "Publishing" : "Publish"}
          </button>
        </div>
      </form>
    </div>
  )
}
