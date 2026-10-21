"use client"

import Link from "next/link"
import { useEffect, useMemo, useRef, useState } from "react"
import { CORE_ZONE, slugify, type McpConnectorPublic } from "@brain/core"
import type { ZoneView } from "@/lib/brain"
import { AgentLogos } from "./brand-logos"
import { AgentRun, AgentToasts, useAgentOnboarding, type AgentEvent, type RunState } from "./AgentProgress"
import { Brain3D, type BrainPerson } from "./Brain3D"
import type { ZoneActivity } from "./BrainViz"
import { ConnectAiButton } from "./ConnectAi"
import { McpConnectors } from "./McpConnectors"
import { PersonAvatar } from "./PersonDot"
import { PromptActions, copyText } from "./PromptActions"
import { TeamJoin } from "./TeamJoin"
import { api, errorMessage } from "./format"
import { CheckIcon, CloseIcon, Dot, ErrorText, LogoMark, PlusIcon, ZONE_PALETTE, ZoneTag, zoneColor } from "./ui"
import { possessive } from "@/lib/install-prompt"

type ZoneOption = { id: string; name: string; description: string; color: string; position: number }
type Step = "intro" | "company" | "about" | "you" | "context" | "zones" | "install" | "team"
/** A person added from this page: invited (their personal prompt), or accepted through the team message (empty prompt). */
type Invite = { id: string; name: string; title?: string; zones: string[]; prompt: string }
/** `token`: the admin's token (already in `prompt`), sent back at the zones step to remake this prompt. */
type Created = { orgName: string; meId: string; prompt: string; zones: ZoneOption[]; token?: string }
type TeamUser = { id: string; last_at: string | null }
/** Zone proposed by Claude Code or Codex ("context" step). */
type ProposedZone = { id: string; name: string; description: string; keywords: string[] }
/** Proposal from Claude Code or Codex: zones, first knowledge, company description. `received_at`: its version. */
type Proposal = { zones: ProposedZone[]; items: unknown[]; description: string; received_at?: string }

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
  proposal: Proposal | null
}

/** Numbered steps (progress bar): the intro is not one of them. */
const STEPS: Step[] = ["company", "about", "you", "context", "zones", "install", "team"]
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
/** Page background (--color-bone): the preview brain blends into it, as on the landing. */
const BONE = 0xf6f6f3

function load(): Partial<Saved> | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as Partial<Saved>) : null
  } catch {
    return null
  }
}

/** Draft zones with their colors (proposed by Claude and kept, ticked, added): the little brain's preview. */
function draftZoneList(all: ZoneOption[], picked: string[], custom: string[], proposed: ProposedZone[] = []): ZoneOption[] {
  const fromClaude = proposed
    .filter((z) => picked.includes(z.id))
    .map((z, i) => ({ id: z.id, name: z.name, description: z.description, color: ZONE_PALETTE[i % ZONE_PALETTE.length], position: 0 }))
  const chosen = [...fromClaude, ...all.filter((z) => picked.includes(z.id) && !fromClaude.some((c) => c.id === z.id))]
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
 * Create your company from scratch, one question per screen: name, business, who you are. The brain is then created
 * (with no zone); Claude Code or Codex can propose its zones from the computer's conversations (skippable step), and
 * the zones step starts from its proposal. Then, the prompt to paste into Claude Code or Codex to connect your computer,
 * then one prompt per colleague to invite them.
 * Connected computers show up live (reading /api/admin/team).
 */
export function CreateCompany({ zones, demo }: { zones: ZoneOption[]; demo: boolean }) {
  const [ready, setReady] = useState(false)
  const brainFrame = useRef<HTMLDivElement>(null)
  const [step, setStep] = useState<Step>("intro")
  const [company, setCompany] = useState("")
  const [description, setDescription] = useState("")
  const [name, setName] = useState("")
  const [title, setTitle] = useState("")
  const [picked, setPicked] = useState<string[]>(DEFAULT_PICK)
  const [custom, setCustom] = useState<string[]>([])
  const [created, setCreated] = useState<Created | null>(null)
  const [invites, setInvites] = useState<Invite[]>([])
  const [proposal, setProposal] = useState<Proposal | null>(null)
  const [team, setTeam] = useState<Record<string, string | null>>({})
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // Claude Code or Codex works in the background once the brain is created: you can move on, its
  // signals arrive as notifications and its proposal joins the zones step as soon as it sends it.
  const agent = useAgentOnboarding<Proposal>(Boolean(created) && step !== "intro", step !== "context")
  const incoming = agent.draft

  useEffect(() => {
    const url = new URL(window.location.href)
    if (!url.searchParams.has(DRAFT_PARAM)) {
      clear()
      url.searchParams.set(DRAFT_PARAM, "1")
      window.history.replaceState(null, "", url)
    }
    const s = load()
    if (s) {
      // A draft saved by an older version may point to a step that no longer exists (the former "connectors" step).
      if (s.step) setStep(s.step === "intro" || STEPS.includes(s.step) ? s.step : "team")
      setCompany(s.company ?? "")
      setDescription(s.description ?? "")
      setName(s.name ?? "")
      setTitle(s.title ?? "")
      if (s.picked) setPicked(s.picked)
      setCustom(s.custom ?? [])
      setCreated(s.created ?? null)
      setInvites(s.invites ?? [])
      setProposal(s.proposal ?? null)
    }
    setReady(true)
  }, [])

  useEffect(() => {
    if (ready) save({ step, company, description, name, title, picked, custom, created, invites, proposal })
  }, [ready, step, company, description, name, title, picked, custom, created, invites, proposal])

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

  // A proposal (or its completed version) arrives during the zones step: it is added there, without removing what
  // the person already ticked or unticked. The default choice, if it has not been touched, gives way to it.
  useEffect(() => {
    if (step !== "zones" || !incoming || incoming.received_at === proposal?.received_at) return
    const before = new Set((proposal?.zones ?? []).map((z) => z.id))
    const ids = incoming.zones.map((z) => z.id)
    setProposal(incoming)
    setPicked((p) =>
      !proposal && p.join() === DEFAULT_PICK.join() ? ids : [...p, ...ids.filter((id) => !before.has(id) && !p.includes(id))],
    )
  }, [step, incoming, proposal])

  // Draft zones, or the ones actually created: that is what the little brain on the right shows.
  // Proposed knowledge per zone: the preview brain already has some, as beads.
  const proposalCounts = useMemo(() => {
    const out: Record<string, number> = {}
    for (const i of (proposal?.items ?? []) as { zone?: string }[]) if (i.zone) out[i.zone] = (out[i.zone] ?? 0) + 1
    return out
  }, [proposal])
  // While Claude prepares its proposal, no zone yet: the little brain shows none.
  const draftZones = useMemo<ZoneOption[]>(
    () => (created?.zones.length ? created.zones : step === "context" ? [] : draftZoneList(zones, picked, custom, proposal?.zones)),
    [zones, picked, custom, created, proposal, step],
  )

  const go = (s: Step) => {
    setErr(null)
    setStep(s)
  }

  /** After "And you?": the brain is created without a zone, so that Claude can propose them (upload code tied to the admin). */
  async function createOrg() {
    if (created) return go("context")
    setBusy(true)
    setErr(null)
    try {
      const r = await api<{ org: { name: string }; profile: { id: string }; prompt: string; zones: ZoneOption[]; token: string }>("/api/orgs", {
        method: "POST",
        json: { company, description, name, title, later: true },
      })
      setCreated({ orgName: r.org.name, meId: r.profile.id, prompt: r.prompt, zones: r.zones, token: r.token })
      setStep("context")
    } catch (e) {
      setErr(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  /** Proposal received (or step skipped): the zones step starts from its zones, all ticked. */
  function toZones(p: Proposal | null) {
    setProposal(p)
    if (p?.zones.length) setPicked(p.zones.map((z) => z.id))
    go("zones")
  }

  /** Zones step: creates the ones kept, adds the proposed knowledge, and receives the install prompt. */
  async function applyZones() {
    if (!created) return
    setBusy(true)
    setErr(null)
    try {
      const proposed = (proposal?.zones ?? []).filter((z) => picked.includes(z.id))
      const r = await api<{ zones: ZoneOption[]; prompt: string | null }>("/api/onboarding/zones", {
        method: "POST",
        json: {
          proposed,
          picked: picked.filter((id) => zones.some((z) => z.id === id) && !proposed.some((p) => p.id === id)),
          custom,
          items: proposal?.items ?? [],
          description: proposal?.description ?? "",
          token: created.token,
        },
      })
      // The proposal stays in memory: the preview keeps its knowledge per zone.
      setCreated({ ...created, zones: r.zones, prompt: r.prompt ?? created.prompt })
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
    setProposal(null)
    setTeam({})
    go("company")
  }

  const index = STEPS.indexOf(step)
  const org = created?.orgName ?? (company.trim() || "your company")
  // Once the brain is created (after "And you?"), no going back to the questions that named it.
  const back: Partial<Record<Step, Step>> = { company: "intro", about: "company", you: "about", zones: "context", team: "install" }
  const people = created
    ? [{ id: created.meId, name, connected: Boolean(team[created.meId]) }, ...invites.map((i) => ({ id: i.id, name: i.name, connected: Boolean(team[i.id]) }))]
    : name.trim()
      ? [{ id: "me", name, connected: false }]
      : []

  return (
    <main className="create flex min-h-dvh flex-col">
      {/* Positioned and first: everything that follows (positioned too) goes in front. */}
      <MiniBrain frame={brainFrame} zones={draftZones} people={people} counts={proposalCounts} />
      <header className="create-wrap relative flex items-center justify-between gap-4 py-4">
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
      <div className="create-progress relative" aria-hidden>
        <div className="create-progress-fill" style={{ transform: `scaleX(${index < 0 ? 0 : (index + 1) / STEPS.length})` }} />
      </div>

      {/* The brain is the page background: where there is no content, dragging and zooming go to it. */}
      <div className="create-wrap pointer-events-none relative grid flex-1 gap-12 py-[clamp(40px,9vh,112px)] lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:gap-20">
        <section className="pointer-events-auto min-w-0 max-w-[640px]" aria-live="polite">
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
                    Three questions to set up your dashboard, then Claude Code or Codex proposes its zones from your conversations and the tools you connect
                    (Notion, Linear, GitHub…). Then, a message connects your computer, and one message per colleague brings them into the brain. A few
                    minutes in all.
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
                    placeholder="Encore"
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
                    placeholder="Refurbished smartphones with a 2-year warranty, for individuals and companies."
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
                  onSubmit={createOrg}
                  canContinue={name.trim().length > 0 && !busy}
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
                    {busy && <p className="text-[13px] text-trace">Creating the brain…</p>}
                    {err && <ErrorText>{err}</ErrorText>}
                  </div>
                </Question>
              )}

              {step === "context" && created && <ContextStep orgName={created.orgName} run={agent.run} state={agent.state} received={incoming} onNext={toZones} />}

              {step === "zones" && created && (
                <ZonesStep
                  org={org}
                  zones={zones}
                  proposal={proposal}
                  agentBusy={agent.state === "running"}
                  preview={draftZones}
                  picked={picked}
                  setPicked={setPicked}
                  custom={custom}
                  setCustom={setCustom}
                  busy={busy}
                  err={err}
                  onCreate={applyZones}
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
                    <PromptActions getPrompt={() => Promise.resolve(created.prompt)} terminal />
                    <p className="mt-4 border-t border-line pt-4 text-[13px] leading-relaxed text-trace">
                      This message contains your personal token: keep it to yourself. No history is sent, the brain learns from the install onward.
                    </p>
                  </div>
                  <Presence connected={Boolean(team[created.meId])} self />
                  <div className="mt-9 flex flex-wrap items-center gap-x-6 gap-y-3">
                    <button type="button" className="btn btn-lg" onClick={() => go("team")}>
                      Continue
                    </button>
                    <Link href="/dashboard" className="landing-link text-[15px]">
                      Open the dashboard
                    </Link>
                  </div>
                </>
              )}

              {step === "team" && created && (
                <TeamStep created={created} invites={invites} setInvites={setInvites} team={team} />
              )}

              {(step === "context" || step === "zones" || step === "install" || step === "team") && !created && (
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
            <BrainCaption frame={brainFrame} org={org} zones={draftZones} people={people} />
            {created && step !== "intro" && (
              <p className="mt-6 text-center text-[13px] text-trace">
                <button type="button" className="pointer-events-auto hover:text-ink" onClick={restart}>
                  Create another company
                </button>
              </p>
            )}
          </div>
        </aside>
      </div>
      {/* At the "context" step, the thread is already in the page. After the zones, the proposal is reviewed in Onboarding. */}
      {step !== "context" && (
        <AgentToasts
          toasts={agent.toasts}
          dismiss={agent.dismiss}
          draftAction={
            step === "install" || step === "team" ? (
              <Link href="/onboarding" className="landing-link">
                Review it in Onboarding
              </Link>
            ) : undefined
          }
        />
      )}
    </main>
  )
}

/**
 * Before the zones (optional): Claude Code or Codex rereads the computer's conversations about the company (its name
 * and description, and nothing else), then proposes zones and first knowledge (POST /api/onboarding/import).
 * The page receives it live; the zones step starts from this proposal. You can skip and choose yourself.
 */
function ContextStep(props: { orgName: string; run: AgentEvent[]; state: RunState; received: Proposal | null; onNext: (p: Proposal | null) => void }) {
  const { orgName, run, state, received, onNext } = props
  const prompt = useRef<Promise<string> | null>(null)

  const getPrompt = () => {
    prompt.current ??= api<{ prompt: string }>("/api/onboarding/agent", { method: "POST" }).then((r) => r.prompt)
    prompt.current.catch(() => (prompt.current = null))
    return prompt.current
  }

  const started = state !== "idle"
  return (
    <>
      <h1 className="create-title">Let Claude propose the zones.</h1>
      <p className="create-lead">
        Open this message in Claude Code or Codex. It rereads your conversations on this computer about {orgName}, and only those, along with the tools
        you connect below, then proposes the brain&apos;s zones and its first knowledge. It asks for your consent before reading anything, and you review
        everything at the next step.
      </p>
      <div className="panel mt-8 px-5 py-5">
        <PromptActions getPrompt={getPrompt} sends />
        <p className="mt-4 border-t border-line pt-4 text-[13px] leading-relaxed text-trace">
          Claude Code or Codex, your choice. Never any secrets or personal data; the upload code it contains is valid for 2 hours.
        </p>
      </div>
      {received ? (
        <p className="mt-6 flex items-center gap-2 text-[14px]" aria-live="polite">
          <span className="live-dot is-live" aria-hidden />
          Proposal received: {received.zones.length} zone{received.zones.length === 1 ? "" : "s"}, {received.items.length} knowledge item
          {received.items.length === 1 ? "" : "s"}.{state === "running" && " Claude keeps completing it: the next step will follow."}
        </p>
      ) : started ? (
        <p className="mt-6 text-[14px]" aria-live="polite">
          {state === "error"
            ? "Claude stopped before sending its proposal. Send the message again, or choose the zones yourself."
            : "It's running. You can move on: Claude keeps going in the background, its zones will be added to the next step as soon as it sends them, and each finding shows up as a notification."}
        </p>
      ) : (
        <p className="mt-6 flex items-center gap-2 text-[14px]" aria-live="polite">
          <span className="live-dot" aria-hidden /> Waiting for Claude. This page updates on its own.
        </p>
      )}
      <AgentRun run={run} className="mt-4" />
      <div className="mt-9 flex flex-wrap items-center gap-x-6 gap-y-3">
        {received && (
          <button type="button" className="btn btn-primary btn-lg" onClick={() => onNext(received)}>
            See the proposed zones
          </button>
        )}
        {!received && started && state !== "error" && (
          <button type="button" className="btn btn-primary btn-lg" onClick={() => onNext(null)}>
            Continue while Claude works
          </button>
        )}
        <button type="button" className={received || (started && state !== "error") ? "landing-link text-[15px]" : "btn btn-lg"} onClick={() => onNext(null)}>
          {received ? "Ignore it and choose myself" : started && state !== "error" ? "Choose the zones without waiting for Claude" : "Skip: I'll choose the zones myself"}
        </button>
      </div>
      <ContextTools />
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
  proposal: Proposal | null
  /** Claude is still working: its proposal (or its completed version) will be added to this step. */
  agentBusy: boolean
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
  const proposed = props.proposal?.zones ?? []
  const others = props.zones.filter((z) => !proposed.some((p) => p.id === z.id))
  const items = props.proposal?.items.length ?? 0
  const option = (z: { id: string; name: string; description: string }, color: string) => {
    const on = props.picked.includes(z.id)
    return (
      <button key={z.id} type="button" className="zone-option" aria-pressed={on} onClick={() => toggle(z.id)}>
        <span className="flex items-center justify-between gap-2">
          <ZoneTag name={z.name} color={color} className="text-[15px] font-medium" />
          <span className={`zone-check ${on ? "is-on" : ""}`} aria-hidden>
            {on && <CheckIcon size={12} />}
          </span>
        </span>
        <span className="mt-1 block text-[13px] leading-snug text-trace">{z.description}</span>
      </button>
    )
  }
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
      <p className="create-lead">
        {proposed.length
          ? "Claude proposed them from your conversations: keep, remove, add. You will then decide who reads which zone."
          : "One zone per function. You will then decide who reads which zone: finance doesn't need the code."}
      </p>
      {props.agentBusy && (
        <p className="mt-4 flex items-center gap-2 text-[13px] text-trace" aria-live="polite">
          <span className="live-dot is-live" aria-hidden />
          {proposed.length ? "Claude is still completing its proposal: its new zones will be added here." : "Claude is still preparing its zones: they will be added here as soon as it sends them."}
        </p>
      )}
      {proposed.length > 0 && (
        <>
          <h2 className="mt-9 text-[13px] font-medium text-trace">Proposed by Claude</h2>
          <div className="mt-3 grid grid-cols-1 gap-2.5 sm:grid-cols-2">{proposed.map((z, i) => option(z, ZONE_PALETTE[i % ZONE_PALETTE.length]))}</div>
          <h2 className="mt-8 text-[13px] font-medium text-trace">Other zones</h2>
        </>
      )}
      <div className={`${proposed.length ? "mt-3" : "mt-9"} grid grid-cols-1 gap-2.5 sm:grid-cols-2`}>
        {others.map((z) => option(z, zoneColor(z.color, z.position)))}
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
          {props.busy ? "Creating the zones…" : "Confirm the zones"}
        </button>
        <span className="text-[13px] tabular-nums text-trace">
          {count === 0
            ? "Choose at least one zone."
            : `${count} zone${count === 1 ? "" : "s"}${items ? `, ${items} proposed knowledge item${items === 1 ? "" : "s"} added to the brain` : ""}`}
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
                <ConnectAiButton userId={i.id} isSelf={false} className="btn" />
              </li>
            )
          })}
        </ul>
      )}
      {copied && <p className="mt-3 text-[13px] text-trace" aria-live="polite">Prompt copied: send it to them (Slack, email), they paste it into Claude Code or Codex.</p>}
      {invites.length > 0 && <p className="mt-1.5 text-[12px] text-trace">No install? “Connect an AI” gives their MCP address, for Claude, ChatGPT, Cursor and the rest.</p>}

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
        <Link href="/dashboard" className="btn btn-primary btn-lg">
          Open the dashboard
        </Link>
        <Presence connected={Boolean(props.team[created.meId])} self compact />
      </div>
    </div>
  )
}

/**
 * The tools connected while Claude reads (step "context"): "Connect" goes through the tool's sign-in page, then comes
 * back here (/create?draft=1 resumes the flow at this step). The agent lists them through the upload code and uses their
 * read-only tools to shape the zones and the first knowledge.
 */
function ContextTools() {
  const [data, setData] = useState<{ connectors: McpConnectorPublic[]; redirect_uri: string } | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    api<{ connectors: McpConnectorPublic[]; redirect_uri: string }>("/api/connectors/mcp").then(setData, (e) => setErr(errorMessage(e)))
  }, [])

  return (
    <section className="mt-12 border-t border-line pt-10" aria-labelledby="context-tools">
      <h2 id="context-tools" className="text-[19px] font-medium">
        While Claude reads, connect your tools
      </h2>
      <p className="mt-2 text-[14px] leading-relaxed text-trace">
        Notion, Linear, GitHub, Slack, Stripe… Claude explores them read-only, alongside your conversations, to name the zones and write the first
        knowledge. Each one goes through its own sign-in page, then you come back here; tokens stay on the brain&apos;s server. You can add others later,
        from the Connectors page.
      </p>
      <div className="mt-5">
        {err ? <ErrorText>{err}</ErrorText> : data ? <McpConnectors initial={data.connectors} redirectUri={data.redirect_uri} returnTo="create" bare /> : <p className="text-[14px] text-trace">Loading…</p>}
      </div>
    </section>
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
 * The company's brain being born: the same 3D brain as the dashboard and the landing, without its controls. Each zone
 * that appears lights up for a moment; people take their place once the brain is created. It frames itself on its
 * box, on the right, but it is drawn over the whole page, behind the content: you zoom right into it without ever
 * hitting a frame.
 */
function MiniBrain(props: { frame: React.RefObject<HTMLDivElement | null>; zones: ZoneOption[]; people: { id: string; name: string; connected: boolean }[]; counts: Record<string, number> }) {
  const { frame, zones, people, counts } = props
  const views = useMemo<ZoneView[]>(
    // The core is there from the start, at the center: every company's brain has one, the zones come around it.
    () => [CORE_ZONE, ...zones].map((z) => ({ ...z, keywords: [], count: counts[z.id] ?? 0, last_at: null, contributors: 0, locked: false, entities: [] })),
    [zones, counts],
  )
  const [now, setNow] = useState(() => Date.now())
  const [activity, setActivity] = useState<Record<string, ZoneActivity>>({})
  const seen = useRef(new Set<string>())
  useEffect(() => {
    const t = Date.now()
    const fresh = zones.filter((z) => !seen.current.has(z.id))
    for (const z of fresh) seen.current.add(z.id)
    if (fresh.length) setActivity((a) => ({ ...a, ...Object.fromEntries(fresh.map((z) => [z.id, { until: t + 1800, startedAt: t }])) }))
  }, [zones])
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(id)
  }, [])
  // One dot per person already created (not before: it leads to their page), placed at the edge of the first zone.
  const dots: BrainPerson[] = people
    .filter((p) => p.id !== "me")
    .map((p, i) => ({ id: p.id, name: p.name, zone: zones[0]?.id ?? null, working: p.connected, me: i === 0 }))
  return (
    <div className="fixed inset-0 hidden lg:block">
      <Brain3D zones={views} synapses={[]} activity={activity} ripples={[]} now={now} people={dots} controls={false} paper={BONE} anchor={frame} />
    </div>
  )
}

/** The box the brain frames itself on (the brain itself is drawn over the whole page), and its caption. */
function BrainCaption(props: { frame: React.RefObject<HTMLDivElement | null>; org: string; zones: ZoneOption[]; people: { connected: boolean }[] }) {
  const { frame, org, zones, people } = props
  const connected = people.filter((p) => p.connected).length
  return (
    <figure>
      <div ref={frame} className="h-[min(62vh,520px)] w-full" />
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
