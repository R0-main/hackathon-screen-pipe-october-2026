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

const COMPANY = "__entreprise__"
const CLI_PUSH = "~/.company-brain/brain skills push ./mon-skill --cortex compta"

/**
 * L'onglet Skills : les skills de l'entreprise (SKILL.md et leurs scripts) regroupés par cortex. Chacun ne voit que ceux
 * de toute l'entreprise et ceux des cortex qu'il lit ; ce sont aussi ceux que son poste installe dans ~/.claude/skills.
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
      setErr(`Chargement des skills impossible : ${errorMessage(e)}`)
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  // Cortex qu'on peut attribuer : tous pour un admin, sinon ceux qu'on lit.
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
      setErr(`${what} impossible pour ${s.name} : ${errorMessage(e)}`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <PageScroll>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 max-w-2xl">
          <h1 className="text-[22px] font-medium leading-tight">Skills de l&apos;entreprise</h1>
          <p className="mt-1 text-[13px] leading-relaxed text-trace">
            Les savoir-faire prêts à l&apos;emploi pour Claude Code, avec les scripts qu&apos;ils utilisent. Un skill attribué à un cortex n&apos;est donné qu&apos;aux
            personnes qui ont accès à ce contexte ; chaque poste installe les siens dans ~/.claude/skills à chaque synchro.
          </p>
        </div>
        {canPublish ? (
          <button type="button" className="btn btn-primary" onClick={() => setPublishing(true)}>
            Publier un skill
          </button>
        ) : (
          <p className="inset flex max-w-xs items-start gap-2 px-3 py-2 text-[12px] leading-snug">
            <LockIcon size={14} className="mt-px shrink-0" />
            Publier un skill demande une autorisation : demandez-la à un admin.
          </p>
        )}
      </header>

      {err && <ErrorText className="mt-4">{err}</ErrorText>}

      <div className="mt-6 space-y-6" aria-busy={skills === null}>
        {skills === null && !err && <p className="text-[13px] text-trace">Chargement des skills…</p>}
        {skills !== null && groups.length === 0 && (
          <p className="panel p-5 text-[13px] text-trace">
            Aucun skill pour vous pour l&apos;instant.{" "}
            {canPublish ? "Publiez le premier : un dossier avec un SKILL.md, et les scripts qu'il utilise." : "Ils apparaîtront ici dès qu'une personne autorisée en publiera."}
          </p>
        )}
        {groups.map((g) => (
          <section key={g.id} aria-labelledby={`cortex-${g.id}`}>
            <h2 id={`cortex-${g.id}`} className="mb-2.5 flex items-baseline gap-2 text-[15px] font-medium">
              {g.zone ? <ZoneTag name={`Cortex ${g.zone.name}`} color={zoneColor(g.zone.color, g.zone.position)} /> : "Toute l'entreprise"}
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
                  onZone={(zone) => act(s, () => api(`/api/skills/${s.id}`, { method: "PATCH", json: { zone } }), "Changement de cortex")}
                  onDelete={() => {
                    if (confirm(`Retirer le skill « ${s.name} » ? Les postes le désinstallent à leur prochaine synchro.`))
                      void act(s, () => api(`/api/skills/${s.id}`, { method: "DELETE" }), "Retrait")
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
            <div className="flex flex-wrap gap-1.5" role="group" aria-label={`Fichiers de ${s.name}`}>
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
                  <option value="">Toute l&apos;entreprise</option>
                  {props.zones.map((z) => (
                    <option key={z.id} value={z.id}>
                      {z.name}
                    </option>
                  ))}
                </select>
              </label>
              <button type="button" className="btn btn-sm ml-auto" disabled={props.busy} onClick={props.onDelete}>
                Retirer
              </button>
            </div>
          )}
        </div>
      )}
    </article>
  )
}

/** Chemin relatif d'un fichier importé d'un dossier (sans le dossier lui-même), ou null s'il faut l'ignorer. */
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

  /** Reprend nom et description de l'en-tête de SKILL.md quand les champs sont encore vides. */
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
      // Un fichier ajouté seul (sans dossier) va dans scripts/.
      else added.push({ path: f.webkitRelativePath ? path : `scripts/${path}`, content })
    }
    setScripts((prev) => [...prev.filter((p) => !added.some((a) => a.path === p.path)), ...added])
    if (skipped.length) setErr(`Fichiers ignorés (pas du texte) : ${skipped.join(", ")}`)
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
              Publier un skill
            </h2>
            <p className="mt-1 text-[13px] text-trace">Même nom qu&apos;un skill existant : il passe à la version suivante.</p>
          </div>
          <button type="button" className="btn btn-icon shrink-0" onClick={onClose} aria-label="Fermer">
            <CloseIcon />
          </button>
        </div>

        <div className="flex flex-wrap gap-2">
          <label className="btn btn-sm cursor-pointer">
            Importer un dossier
            <input
              type="file"
              className="sr-only"
              multiple
              onChange={(e) => void addFiles(e.target.files)}
              {...({ webkitdirectory: "" } as Record<string, string>)}
            />
          </label>
          <label className="btn btn-sm cursor-pointer">
            Ajouter des scripts
            <input type="file" className="sr-only" multiple onChange={(e) => void addFiles(e.target.files)} />
          </label>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1.5 block text-[13px] font-medium">Nom</span>
            <input className="input mono" required value={name} placeholder="cloture-mensuelle" pattern="[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?" onChange={(e) => setName(e.target.value)} />
            <span className="mt-1 block text-[12px] text-trace">Minuscules, chiffres et tirets : c&apos;est le nom du dossier sur les postes.</span>
          </label>
          <label className="block">
            <span className="mb-1.5 block text-[13px] font-medium">Cortex</span>
            <select className="input" value={zone} onChange={(e) => setZone(e.target.value)}>
              <option value="">Toute l&apos;entreprise</option>
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
                  Seules les personnes qui ont accès à ce cortex le reçoivent.
                </>
              ) : (
                "Tout le monde le reçoit."
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
            placeholder="Clôturer le mois : export Pennylane et envoi au cabinet avant le 5"
            onChange={(e) => setDescription(e.target.value)}
          />
          <span className="mt-1 block text-[12px] text-trace">Claude Code s&apos;en sert pour savoir quand utiliser le skill.</span>
        </label>

        <label className="block">
          <span className="mb-1.5 block text-[13px] font-medium">SKILL.md</span>
          <textarea
            className="input mono !h-auto min-h-48 py-2 text-[12px] leading-relaxed"
            required
            rows={10}
            value={main}
            placeholder={"# Clôture mensuelle\n\n1. Lancer scripts/export.py\n2. …"}
            onChange={(e) => setMain(e.target.value)}
          />
        </label>

        <div>
          <span className="mb-1.5 block text-[13px] font-medium">Scripts utilisés par le skill</span>
          {scripts.length === 0 ? (
            <p className="text-[12px] text-trace">Aucun. Importez le dossier du skill, ou ajoutez ses scripts.</p>
          ) : (
            <ul className="flex flex-wrap gap-1.5">
              {scripts.map((f) => (
                <li key={f.path} className="chip mono">
                  {f.path}
                  <button type="button" className="-mr-1 rounded-full p-0.5 hover:bg-bone" aria-label={`Retirer ${f.path}`} onClick={() => setScripts((prev) => prev.filter((p) => p.path !== f.path))}>
                    <CloseIcon size={12} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <p className="inset px-3 py-2 text-[12px] leading-snug text-trace">
          Depuis un poste : <span className="mono text-ink">{CLI_PUSH}</span>. Un fichier qui contient un secret (clé API, mot de passe) est refusé : lisez-le
          depuis une variable d&apos;environnement.
        </p>

        {err && <ErrorText>{err}</ErrorText>}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn" onClick={onClose}>
            Annuler
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? "Publication en cours" : "Publier"}
          </button>
        </div>
      </form>
    </div>
  )
}
