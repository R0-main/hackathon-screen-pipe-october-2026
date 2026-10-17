"use client"

import Link from "next/link"
import { useEffect, useMemo, useRef, useState } from "react"
import { slugify } from "@brain/core"
import { AgentLogos } from "./brand-logos"
import { PersonAvatar } from "./PersonDot"
import { PromptActions, copyText } from "./PromptActions"
import { TeamJoin } from "./TeamJoin"
import { api, errorMessage } from "./format"
import { CheckIcon, CloseIcon, Dot, ErrorText, LogoMark, PlusIcon, ZONE_PALETTE, ZoneTag, zoneColor } from "./ui"
import { possessive } from "@/lib/install-prompt"

type ZoneOption = { id: string; name: string; description: string; color: string; position: number }
type Step = "intro" | "company" | "about" | "you" | "zones" | "install" | "context" | "team"
/** A person added from this page: invited (their personal prompt), or accepted through the team message (empty prompt). */
type Invite = { id: string; name: string; title?: string; zones: string[]; prompt: string }
type Created = { orgName: string; meId: string; prompt: string; zones: ZoneOption[] }
type TeamUser = { id: string; last_at: string | null }

type Saved = {
  step: Step
  company: string
  description: string
  name: string
  title: string
  picked: string[]
  custom: string[]
  created: Created | null
  invites: Invite[]
}

/** Numbered steps (progress bar): the intro is not one of them. */
const STEPS: Step[] = ["company", "about", "you", "zones", "install", "context", "team"]
const DEFAULT_PICK = ["dev", "product", "leadership"]
/**
 * Progress survives a reload, in this tab only (sessionStorage, cleared when it closes). It
 * contains the prompts, hence the tokens: that is what lets them be copied again after a reload.
 */
const STORAGE_KEY = "nos-brainer:create"
/**
 * Set in the address when the flow opens (`/create?draft=1`): a reload or going back resumes the draft, whereas
 * arriving through a link ("Create my company") starts from scratch, even after a company was created.
 */
const DRAFT_PARAM = "draft"
const POLL_MS = 3000

function load(): Partial<Saved> | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as Partial<Saved>) : null
  } catch {
    return null
  }
}

/** Draft zones with their colors, assigned as the server will do it (POST /api/orgs): the preview does not change on creation. */
function draftZoneList(all: ZoneOption[], picked: string[], custom: string[]): ZoneOption[] {
  const chosen = all.filter((z) => picked.includes(z.id))
  const free = ZONE_PALETTE.filter((c) => !chosen.some((z) => z.color === c))
  const extra = custom.map((name, i) => ({ id: `custom-${slugify(name)}`, name, description: "", color: free[i] ?? zoneColor(null, chosen.length + i), position: 0 }))
  return [...chosen, ...extra].map((z, position) => ({ ...z, position }))
}

function save(s: Saved) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(s))
  } catch {}
}

function clear() {
  try {
    sessionStorage.removeItem(STORAGE_KEY)
  } catch {}
}

/**
 * Create your company from scratch, one question per screen: name, business, who you are, brain zones.
 * Then, the prompt to paste into Claude Code or Codex to connect your computer, then one prompt per colleague to invite them.
 * Connected computers show up live (reading /api/admin/team).
 */
export function CreateCompany({ zones, demo }: { zones: ZoneOption[]; demo: boolean }) {
  const [ready, setReady] = useState(false)
  const [step, setStep] = useState<Step>("intro")
  const [company, setCompany] = useState("")
  const [description, setDescription] = useState("")
  const [name, setName] = useState("")
  const [title, setTitle] = useState("")
  const [picked, setPicked] = useState<string[]>(DEFAULT_PICK)
  const [custom, setCustom] = useState<string[]>([])
  const [created, setCreated] = useState<Created | null>(null)
  const [invites, setInvites] = useState<Invite[]>([])
  const [team, setTeam] = useState<Record<string, string | null>>({})
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    const url = new URL(window.location.href)
    if (!url.searchParams.has(DRAFT_PARAM)) {
      clear()
      url.searchParams.set(DRAFT_PARAM, "1")
      window.history.replaceState(null, "", url)
    }
    const s = load()
    if (s) {
      if (s.step) setStep(s.step)
      setCompany(s.company ?? "")
      setDescription(s.description ?? "")
      setName(s.name ?? "")
      setTitle(s.title ?? "")
      if (s.picked) setPicked(s.picked)
      setCustom(s.custom ?? [])
      setCreated(s.created ?? null)
      setInvites(s.invites ?? [])
    }
    setReady(true)
  }, [])

  useEffect(() => {
    if (ready) save({ step, company, description, name, title, picked, custom, created, invites })
  }, [ready, step, company, description, name, title, picked, custom, created, invites])

  // Once the company is created: who has connected? Re-read regularly, the page updates on its own.
  useEffect(() => {
    if (!created) return
    let stop = false
    const tick = async () => {
      try {
        const r = await api<{ users: TeamUser[] }>("/api/admin/team")
        if (!stop) setTeam(Object.fromEntries(r.users.map((u) => [u.id, u.last_at])))
      } catch {}
    }
    void tick()
    const id = setInterval(tick, POLL_MS)
    return () => {
      stop = true
      clearInterval(id)
    }
  }, [created])

  // Draft zones, or the ones actually created: that is what the little brain on the right shows.
  const draftZones = useMemo<ZoneOption[]>(() => created?.zones ?? draftZoneList(zones, picked, custom), [zones, picked, custom, created])

  const go = (s: Step) => {
    setErr(null)
    setStep(s)
  }

  async function createOrg() {
    setBusy(true)
    setErr(null)
    try {
      const r = await api<{ org: { name: string }; profile: { id: string }; prompt: string; zones: ZoneOption[] }>("/api/orgs", {
        method: "POST",
        json: { company, description, name, title, zones: picked, custom },
      })
      setCreated({ orgName: r.org.name, meId: r.profile.id, prompt: r.prompt, zones: r.zones })
      setStep("install")
    } catch (e) {
      setErr(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  function restart() {
    if (created && !confirm(`Start over? ${possessive(created.orgName)} brain stays in place, you will create a new one.`)) return
    clear()
    setCompany("")
    setDescription("")
    setName("")
    setTitle("")
    setPicked(DEFAULT_PICK)
    setCustom([])
    setCreated(null)
    setInvites([])
    setTeam({})
    go("company")
  }

  const index = STEPS.indexOf(step)
  const org = created?.orgName ?? (company.trim() || "your company")
  const back: Partial<Record<Step, Step>> = { company: "intro", about: "company", you: "about", zones: "you", context: "install", team: "context" }
  const people = created
    ? [{ id: created.meId, name, connected: Boolean(team[created.meId]) }, ...invites.map((i) => ({ id: i.id, name: i.name, connected: Boolean(team[i.id]) }))]
    : name.trim()
      ? [{ id: "me", name, connected: false }]
      : []

  return (
    <main className="create flex min-h-dvh flex-col">
      <header className="create-wrap flex items-center justify-between gap-4 py-4">
        <Link href="/" className="flex items-center gap-2.5 rounded-[6px]">
          <LogoMark size={26} />
          <span className="whitespace-nowrap text-[15px] font-medium">NOS Brainer</span>
        </Link>
        <div className="flex items-center gap-3 text-[13px] text-trace">
          {index >= 0 && (
            <span className="hidden whitespace-nowrap tabular-nums sm:inline">
              Step {index + 1} of {STEPS.length}
            </span>
          )}
          {created ? (
            <Link href="/dashboard" className="btn">
              Open the dashboard
            </Link>
          ) : (
            <Link href={demo ? "/demo" : "/login"} className="btn btn-ghost">
              {demo ? "See the demo" : "Sign in"}
            </Link>
          )}
        </div>
      </header>
      <div className="create-progress" aria-hidden>
        <div className="create-progress-fill" style={{ transform: `scaleX(${index < 0 ? 0 : (index + 1) / STEPS.length})` }} />
      </div>

      <div className="create-wrap grid flex-1 gap-12 py-[clamp(40px,9vh,112px)] lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:gap-20">
        <section className="min-w-0 max-w-[640px]" aria-live="polite">
          {!ready ? null : (
            <div key={step} className="step-in">
              {back[step] && (
                <button type="button" className="mb-8 text-[13px] text-trace hover:text-ink" onClick={() => go(back[step]!)}>
                  Back
                </button>
              )}

              {step === "intro" && (
                <>
                  <h1 className="create-title">Let&apos;s build your company&apos;s brain.</h1>
                  <p className="create-lead">
                    Four questions to set up your dashboard. Then, a message to paste into Claude Code or Codex connects your computer, and one message per colleague
                    brings them into the brain. Two minutes in all.
                  </p>
                  <div className="mt-9 flex flex-wrap items-center gap-3">
                    <button type="button" className="btn btn-primary btn-lg" onClick={() => go("company")} autoFocus>
                      Get started
                    </button>
                    {demo && (
                      <Link href="/demo" className="btn btn-lg">
                        See the demo first
                      </Link>
                    )}
                  </div>
                </>
              )}

              {step === "company" && (
                <Question
                  title="What is your company called?"
                  onSubmit={() => go("about")}
                  canContinue={company.trim().length > 0}
                >
                  <input
                    className="create-input"
                    value={company}
                    maxLength={80}
                    autoFocus
                    aria-label="Company name"
                    placeholder="Butine"
                    onChange={(e) => setCompany(e.target.value)}
                  />
                </Question>
              )}

              {step === "about" && (
                <Question
                  title={`What does ${org} do, in one sentence?`}
                  lead="The brain uses it to place what it learns. Optional."
                  onSubmit={() => go("you")}
                  canContinue
                  skip={description.trim() ? undefined : () => go("you")}
                >
                  <textarea
                    className="create-input create-textarea"
                    value={description}
                    maxLength={300}
                    rows={2}
                    autoFocus
                    aria-label="Company business"
                    placeholder="Connected scales for beehives: beekeepers follow their bees from their phone."
                    onChange={(e) => setDescription(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault()
                        go("you")
                      }
                    }}
                  />
                </Question>
              )}

              {step === "you" && (
                <Question
                  title="And you?"
                  lead="You will be the brain's admin: you decide who sees what."
                  onSubmit={() => go("zones")}
                  canContinue={name.trim().length > 0}
                >
                  <div className="space-y-5">
                    <input
                      className="create-input"
                      value={name}
                      maxLength={80}
                      autoFocus
                      aria-label="Your name"
                      placeholder="Your name"
                      autoComplete="name"
                      onChange={(e) => setName(e.target.value)}
                    />
                    <input
                      className="create-input create-input-sm"
                      value={title}
                      maxLength={80}
                      aria-label="Your role"
                      placeholder="Your role: CEO, CTO, office manager…"
                      autoComplete="organization-title"
                      onChange={(e) => setTitle(e.target.value)}
                    />
                  </div>
                </Question>
              )}

              {step === "zones" && (
                <ZonesStep
                  org={org}
                  zones={zones}
                  preview={draftZones}
                  picked={picked}
                  setPicked={setPicked}
                  custom={custom}
                  setCustom={setCustom}
                  busy={busy}
                  err={err}
                  onCreate={createOrg}
                />
              )}

              {step === "install" && created && (
                <>
                  <h1 className="create-title">{possessive(created.orgName)} brain is ready.</h1>
                  <p className="create-lead">
                    Connect your computer: open this message in Claude Code or Codex. It installs Screenpipe, connects the MCP and the hooks, then opens your dashboard
                    already signed in. On a Mac, you will need to allow screen recording.
                  </p>
                  <div className="panel mt-8 px-5 py-5">
                    <PromptActions getPrompt={() => Promise.resolve(created.prompt)} />
                    <p className="mt-4 border-t border-line pt-4 text-[13px] leading-relaxed text-trace">
                      This message contains your personal token: keep it to yourself. No history is sent, the brain learns from the install onward.
                    </p>
                  </div>
                  <Presence connected={Boolean(team[created.meId])} self />
                  <div className="mt-9 flex flex-wrap items-center gap-x-6 gap-y-3">
                    <button type="button" className="btn btn-lg" onClick={() => go("context")}>
                      Continue
                    </button>
                    <Link href="/dashboard" className="landing-link text-[15px]">
                      Open the dashboard
                    </Link>
                  </div>
                </>
              )}

              {step === "context" && created && <ContextStep orgName={created.orgName} onNext={() => go("team")} />}

              {step === "team" && created && (
                <TeamStep created={created} invites={invites} setInvites={setInvites} team={team} />
              )}

              {(step === "install" || step === "context" || step === "team") && !created && (
                <>
                  <h1 className="create-title">This page lost your brain.</h1>
                  <p className="create-lead">It still exists: find it from the dashboard, or start over.</p>
                  <div className="mt-9 flex flex-wrap gap-3">
                    <Link href="/dashboard" className="btn btn-primary btn-lg">
                      Open the dashboard
                    </Link>
                    <button type="button" className="btn btn-lg" onClick={restart}>
                      Start over
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </section>

        <aside className="hidden lg:block" aria-label={`Preview of ${possessive(org)} brain`}>
          <div className="sticky top-10">
            <MiniBrain org={org} zones={draftZones} people={people} />
            {created && step !== "intro" && (
              <p className="mt-6 text-center text-[13px] text-trace">
                <button type="button" className="hover:text-ink" onClick={restart}>
                  Create another company
                </button>
              </p>
            )}
          </div>
        </aside>
      </div>
    </main>
  )
}

/**
 * Give the brain your accounts' context: Claude Code or Codex re-reads the computer's history and proposes zones and
 * first knowledge (POST /api/onboarding/import). The proposal is reviewed and validated on the Onboarding page.
 */
function ContextStep({ orgName, onNext }: { orgName: string; onNext: () => void }) {
  const prompt = useRef<Promise<string> | null>(null)
  const [received, setReceived] = useState<{ zones: number; items: number } | null>(null)

  const getPrompt = () => {
    prompt.current ??= api<{ prompt: string }>("/api/onboarding/agent", { method: "POST" }).then((r) => r.prompt)
    prompt.current.catch(() => (prompt.current = null))
    return prompt.current
  }

  useEffect(() => {
    if (received) return
    let stop = false
    const tick = async () => {
      try {
        const r = await api<{ draft: { zones: unknown[]; items: unknown[] } | null }>("/api/onboarding/import")
        if (!stop && r.draft) setReceived({ zones: r.draft.zones.length, items: r.draft.items.length })
      } catch {}
    }
    void tick()
    const id = setInterval(tick, POLL_MS)
    return () => {
      stop = true
      clearInterval(id)
    }
  }, [received])

  return (
    <>
      <h1 className="create-title">Give it your accounts&apos; context.</h1>
      <p className="create-lead">
        Claude Code or Codex re-reads your past conversations on this computer and your projects&apos; READMEs, and draws {possessive(orgName)} zones and first
        knowledge from them. It asks for your consent before reading anything, and nothing enters the brain before you have reviewed the proposal.
      </p>
      <div className="panel mt-8 px-5 py-5">
        <PromptActions getPrompt={getPrompt} sends />
        <p className="mt-4 border-t border-line pt-4 text-[13px] leading-relaxed text-trace">
          Claude Code or Codex, your choice. Never any secrets or personal data; the upload code it contains is valid for 2 hours.
        </p>
      </div>
      {received ? (
        <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2 text-[14px]" aria-live="polite">
          <span className="flex items-center gap-2">
            <span className="live-dot is-live" aria-hidden />
            Proposal received: {received.zones} zone{received.zones === 1 ? "" : "s"}, {received.items} item{received.items === 1 ? "" : "s"}.
          </span>
          <Link href="/onboarding" target="_blank" className="btn">
            Review and validate
          </Link>
        </div>
      ) : (
        <p className="mt-6 flex items-center gap-2 text-[14px]" aria-live="polite">
          <span className="live-dot" aria-hidden /> Waiting for the proposal. This page updates on its own.
        </p>
      )}
      <div className="mt-9 flex flex-wrap items-center gap-x-6 gap-y-3">
        <button type="button" className="btn btn-lg" onClick={onNext}>
          Invite my team
        </button>
        {!received && (
          <button type="button" className="landing-link text-[15px]" onClick={onNext}>
            Later
          </button>
        )}
      </div>
    </>
  )
}

/** One question per screen: title, help, field, then "Continue" (or Enter). */
function Question(props: { title: string; lead?: string; children: React.ReactNode; onSubmit: () => void; canContinue: boolean; skip?: () => void }) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        if (props.canContinue) props.onSubmit()
      }}
    >
      <h1 className="create-title">{props.title}</h1>
      {props.lead && <p className="create-lead">{props.lead}</p>}
      <div className="mt-9">{props.children}</div>
      <div className="mt-9 flex flex-wrap items-center gap-4">
        <button type="submit" className="btn btn-primary btn-lg" disabled={!props.canContinue}>
          Continue
        </button>
        {props.skip ? (
          <button type="button" className="landing-link text-[15px]" onClick={props.skip}>
            Skip
          </button>
        ) : (
          <span className="hidden text-[13px] text-trace sm:inline">or press Enter</span>
        )}
      </div>
    </form>
  )
}

function ZonesStep(props: {
  org: string
  zones: ZoneOption[]
  preview: ZoneOption[]
  picked: string[]
  setPicked: (f: (p: string[]) => string[]) => void
  custom: string[]
  setCustom: (f: (c: string[]) => string[]) => void
  busy: boolean
  err: string | null
  onCreate: () => void
}) {
  const [draft, setDraft] = useState("")
  const count = props.picked.length + props.custom.length
  const toggle = (id: string) => props.setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))
  const addCustom = () => {
    const v = draft.trim()
    if (!v) return
    const id = slugify(v)
    if (!props.zones.some((z) => z.id === id) && !props.custom.some((c) => slugify(c) === id)) props.setCustom((c) => [...c, v].slice(0, 8))
    else if (props.zones.some((z) => z.id === id)) props.setPicked((p) => (p.includes(id) ? p : [...p, id]))
    setDraft("")
  }

  return (
    <div>
      <h1 className="create-title">What should {possessive(props.org)} brain know?</h1>
      <p className="create-lead">One zone per function. You will then decide who reads which zone: finance doesn&apos;t need the code.</p>
      <div className="mt-9 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        {props.zones.map((z) => {
          const on = props.picked.includes(z.id)
          return (
            <button key={z.id} type="button" className="zone-option" aria-pressed={on} onClick={() => toggle(z.id)}>
              <span className="flex items-center justify-between gap-2">
                <ZoneTag name={z.name} color={zoneColor(z.color, z.position)} className="text-[15px] font-medium" />
                <span className={`zone-check ${on ? "is-on" : ""}`} aria-hidden>
                  {on && <CheckIcon size={12} />}
                </span>
              </span>
              <span className="mt-1 block text-[13px] leading-snug text-trace">{z.description}</span>
            </button>
          )
        })}
      </div>

      <div className="mt-5">
        {props.custom.length > 0 && (
          <ul className="mb-3 flex flex-wrap gap-1.5" aria-label="Added zones">
            {props.custom.map((c, i) => (
              <li key={c} className="chip h-7 pr-1 text-[13px]">
                <Dot color={props.preview.find((z) => z.name === c)?.color ?? zoneColor(null, props.zones.length + i)} />
                {c}
                <button
                  type="button"
                  className="grid size-5 place-items-center rounded-[4px] text-trace hover:text-ink"
                  aria-label={`Remove the ${c} zone`}
                  onClick={() => props.setCustom((list) => list.filter((x) => x !== c))}
                >
                  <CloseIcon size={12} />
                </button>
              </li>
            ))}
          </ul>
        )}
        <form
          className="flex max-w-[420px] gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            addCustom()
          }}
        >
          <input
            className="input"
            value={draft}
            maxLength={40}
            aria-label="Add a zone"
            placeholder="Add a zone: legal, ops, hiring…"
            onChange={(e) => setDraft(e.target.value)}
          />
          <button type="submit" className="btn btn-icon h-9 w-9 shrink-0" aria-label="Add this zone" disabled={!draft.trim() || props.custom.length >= 8}>
            <PlusIcon />
          </button>
        </form>
      </div>

      <div className="mt-10 flex flex-wrap items-center gap-4">
        <button type="button" className="btn btn-primary btn-lg" onClick={props.onCreate} disabled={props.busy || count === 0}>
          {props.busy ? "Creating the brain…" : "Create the brain"}
        </button>
        <span className="text-[13px] tabular-nums text-trace">
          {count === 0 ? "Choose at least one zone." : `${count} zone${count === 1 ? "" : "s"}`}
        </span>
      </div>
      {props.err && <ErrorText className="mt-3">{props.err}</ErrorText>}
    </div>
  )
}

function TeamStep(props: { created: Created; invites: Invite[]; setInvites: (f: (i: Invite[]) => Invite[]) => void; team: Record<string, string | null> }) {
  const { created, invites } = props
  const [name, setName] = useState("")
  const [title, setTitle] = useState("")
  const [zones, setZones] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const nameRef = useRef<HTMLInputElement>(null)

  async function invite(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    setBusy(true)
    setErr(null)
    try {
      const r = await api<{ profile: { id: string; name: string; title?: string }; prompt: string }>("/api/admin/users", {
        method: "POST",
        json: { name: name.trim(), title: title.trim() || undefined, role: "member", zones, manager_id: created.meId },
      })
      props.setInvites((list) => [{ id: r.profile.id, name: r.profile.name, title: r.profile.title, zones, prompt: r.prompt }, ...list])
      setName("")
      setTitle("")
      setZones([])
      await copy(r.profile.id, r.prompt)
      nameRef.current?.focus()
    } catch (e) {
      setErr(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  async function copy(id: string, prompt: string) {
    try {
      await copyText(prompt)
      setCopied(id)
    } catch {
      setErr("Could not copy: your browser refused it.")
    }
  }

  const zone = (id: string) => created.zones.find((z) => z.id === id)

  return (
    <div>
      <h1 className="create-title">Invite {possessive(created.orgName)} team.</h1>
      <p className="create-lead">
        Two ways, your choice: one message per person, with their own token, or a single message for the whole team, where each person asks to join. Either
        way, it is pasted into Claude Code or Codex, and the computer shows up here as soon as it is connected to {possessive(created.orgName)} brain.
      </p>
      <h2 className="mt-10 text-[19px] font-medium">One message per person</h2>

      <form onSubmit={invite} className="panel mt-4 space-y-4 px-5 py-5">
        <div className="grid gap-3 sm:grid-cols-2">
          <input ref={nameRef} className="input" value={name} maxLength={80} aria-label="Name" placeholder="First Last" onChange={(e) => setName(e.target.value)} />
          <input className="input" value={title} maxLength={80} aria-label="Role" placeholder="Role: dev, finance, sales…" onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div>
          <p className="text-[13px] text-trace">Zones they can read</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {created.zones.map((z) => {
              const on = zones.includes(z.id)
              return (
                <button
                  key={z.id}
                  type="button"
                  className={`chip h-7 text-[13px] ${on ? "chip-on" : ""}`}
                  aria-pressed={on}
                  onClick={() => setZones((list) => (on ? list.filter((x) => x !== z.id) : [...list, z.id]))}
                >
                  <Dot color={zoneColor(z.color, z.position)} />
                  {z.name}
                </button>
              )
            })}
          </div>
          {zones.length === 0 && <p className="mt-2 text-[12px] text-trace">Without a zone, they feed the brain but read nothing from it.</p>}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>
            {busy ? (
              "Creating the prompt…"
            ) : (
              <>
                <AgentLogos /> Create and copy their prompt
              </>
            )}
          </button>
          {err && <ErrorText>{err}</ErrorText>}
        </div>
      </form>

      {invites.length > 0 && (
        <ul className="mt-6 divide-y divide-line border-y border-line" aria-label="Invited people">
          {invites.map((i) => {
            const connected = Boolean(props.team[i.id])
            const first = i.zones.length > 0 ? zone(i.zones[0]) : undefined
            return (
              <li key={i.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3.5">
                <span className="relative shrink-0">
                  <PersonAvatar id={i.id} size={36} bg="surface" color={first ? zoneColor(first.color, first.position) : undefined} />
                  <span className={`absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border border-ink ${connected ? "bg-phosphor" : "bg-surface"}`} aria-hidden />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[15px] font-medium">{i.name}</p>
                  <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-trace">
                    <span>{connected ? "Connected" : "Waiting for their computer"}</span>
                    {i.zones.map((zid) => {
                      const z = zone(zid)
                      return z ? <ZoneTag key={zid} name={z.name} color={zoneColor(z.color, z.position)} /> : null
                    })}
                  </p>
                </div>
                {i.prompt ? (
                  <button type="button" className="btn" onClick={() => copy(i.id, i.prompt)}>
                    {copied === i.id ? (
                      <>
                        <CheckIcon size={14} /> Copied
                      </>
                    ) : (
                      "Copy their prompt"
                    )}
                  </button>
                ) : (
                  <span className="text-[12px] text-trace">Through the team message</span>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {copied && <p className="mt-3 text-[13px] text-trace" aria-live="polite">Prompt copied: send it to them (Slack, email), they paste it into Claude Code or Codex.</p>}

      <h2 className="mt-12 text-[19px] font-medium">Or a single message for the whole team</h2>
      <div className="mt-3">
        <TeamJoin
          compact
          orgName={created.orgName}
          zones={created.zones}
          defaultManager={created.meId}
          onAccepted={(p) => props.setInvites((list) => [{ ...p, prompt: "" }, ...list])}
        />
      </div>

      <div className="mt-10 flex flex-wrap items-center gap-x-6 gap-y-3">
        <Link href="/dashboard" className="btn btn-lg">
          Open the dashboard
        </Link>
        <Presence connected={Boolean(props.team[created.meId])} self compact />
      </div>
    </div>
  )
}

/** Connection state of a computer: waiting (empty indicator), or connected (lit indicator). */
function Presence({ connected, self, compact = false }: { connected: boolean; self?: boolean; compact?: boolean }) {
  return (
    <p className={`flex items-center gap-2 text-[14px] ${compact ? "" : "mt-6"}`} aria-live="polite">
      <span className={`live-dot ${connected ? "is-live" : ""}`} aria-hidden />
      {connected
        ? self
          ? "Your computer is connected. The brain lights up at every Claude Code session."
          : "Connected."
        : self
          ? compact
            ? "Your computer is not connected yet."
            : "Waiting for your computer. This page updates on its own."
          : "Waiting."}
    </p>
  )
}

/**
 * The brain being built, in the dashboard's language: a center, one bead per zone linked to the center,
 * and the people around it (filled once their computer is connected).
 */
function MiniBrain({ org, zones, people }: { org: string; zones: ZoneOption[]; people: { id: string; name: string; connected: boolean }[] }) {
  const C = 200
  const zoneR = 112
  const personR = 172
  const pts = zones.map((z, i) => {
    const a = -Math.PI / 2 + (i / Math.max(1, zones.length)) * Math.PI * 2
    return { z, x: C + Math.cos(a) * zoneR, y: C + Math.sin(a) * zoneR, a }
  })
  const shown = people.slice(0, 10)
  const ppl = shown.map((p, i) => {
    const a = -Math.PI / 2 + Math.PI / Math.max(1, shown.length) + (i / Math.max(1, shown.length)) * Math.PI * 2
    return { p, x: C + Math.cos(a) * personR, y: C + Math.sin(a) * personR }
  })
  const connected = people.filter((p) => p.connected).length
  return (
    <figure>
      <svg viewBox="0 0 400 400" className="h-auto w-full max-w-[440px]" role="img" aria-label={`${zones.length} zones, ${people.length} ${people.length === 1 ? "person" : "people"}`}>
        <circle cx={C} cy={C} r={zoneR} fill="none" stroke="var(--color-line)" strokeWidth="1" />
        {ppl.map(({ p, x, y }) => {
          const near = pts.reduce<(typeof pts)[number] | null>((best, q) => (!best || Math.hypot(q.x - x, q.y - y) < Math.hypot(best.x - x, best.y - y) ? q : best), null)
          return near ? <line key={`pl-${p.id}`} x1={x} y1={y} x2={near.x} y2={near.y} stroke="var(--color-line)" strokeWidth="1" /> : null
        })}
        {pts.map(({ z, x, y }) => (
          <line key={`l-${z.id}`} x1={C} y1={C} x2={x} y2={y} stroke="var(--color-line-strong)" strokeWidth="1" />
        ))}
        <circle cx={C} cy={C} r="11" fill="var(--color-surface)" stroke="var(--color-ink)" strokeWidth="1.5" />
        {pts.map(({ z, x, y, a }) => {
          const right = Math.cos(a) > 0.2
          const left = Math.cos(a) < -0.2
          return (
            <g key={z.id} className="mini-pop">
              <circle cx={x} cy={y} r="8" fill={zoneColor(z.color, z.position)} stroke="var(--color-ink)" strokeWidth="1.5" />
              <text
                x={x + (right ? 14 : left ? -14 : 0)}
                y={y + (right || left ? 4.5 : Math.sin(a) > 0 ? 24 : -15)}
                textAnchor={right ? "start" : left ? "end" : "middle"}
                className="fill-ink text-[12.5px]"
              >
                {z.name}
              </text>
            </g>
          )
        })}
        {ppl.map(({ p, x, y }) => (
          <g key={p.id} className="mini-pop">
            <circle cx={x} cy={y} r="5.5" fill={p.connected ? "var(--color-ink)" : "var(--color-surface)"} stroke="var(--color-ink)" strokeWidth="1.25" />
            <title>{`${p.name}: ${p.connected ? "connected" : "waiting"}`}</title>
          </g>
        ))}
      </svg>
      <figcaption className="mt-2 text-center">
        <span className="block text-[17px] font-medium">{org.charAt(0).toUpperCase() + org.slice(1)}</span>
        <span className="text-[13px] tabular-nums text-trace">
          {zones.length} zone{zones.length === 1 ? "" : "s"}
          {people.length > 0 && `, ${connected} of ${people.length} computer${people.length === 1 ? "" : "s"} connected`}
        </span>
      </figcaption>
    </figure>
  )
}
