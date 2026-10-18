"use client"

import Link from "next/link"
import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { CORE_ZONE, type KnowledgeItemInput } from "@brain/core"
import { PageScroll } from "./AppShell"
import { AgentRun, AgentToasts, useAgentOnboarding } from "./AgentProgress"
import { PromptActions } from "./PromptActions"
import { KIND_LABEL, api, errorMessage, relativeTime } from "./format"
import { BrainIcon, CheckIcon, CloseIcon, ErrorText } from "./ui"

type Question = { id: string; question: string }
type Draft = {
  company_name: string
  description: string
  zones: { id: string; name: string; description: string; keywords: string[] }[]
  items: KnowledgeItemInput[]
  generator: "claude" | "heuristic" | "agent"
  pages: { url: string; title: string; truncated: boolean; error?: string }[]
  /** Proposal uploaded by an agent (Claude Code or Codex) from the computer's history. */
  source?: "claude-code" | "codex" | "other"
  received_at?: string
}

const AGENT_LABEL: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex" }
type Incoming = Omit<Draft, "generator" | "pages"> & { received_at: string }
const fromAgent = (d: Incoming): Draft => withUniqueZones({ ...d, generator: "agent", pages: [] })

const GENERATOR_LABEL = (d: Draft) => (d.generator === "agent" ? `from ${AGENT_LABEL[d.source ?? ""] ?? "your agent"}` : d.generator === "claude" ? "from Claude" : "(heuristic)")

/** One zone per id (the synthesis may return two identical ones): unique React keys and applied zones. */
function withUniqueZones(d: Draft): Draft {
  const seen = new Set<string>()
  const zones = d.zones.filter((z) => (seen.has(z.id) ? false : (seen.add(z.id), true)))
  return zones.length === d.zones.length ? d : { ...d, zones }
}

/** A 5 to 10 minute interview: the founder presents the company, the brain draws its zones and first knowledge from it. */
export function Onboarding({ questions, orgName, claude }: { questions: Question[]; orgName: string; claude: boolean }) {
  const router = useRouter()
  const [step, setStep] = useState(0)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [current, setCurrent] = useState("")
  const [draft, setDraft] = useState<Draft | null>(null)
  const [keep, setKeep] = useState<boolean[]>([])
  const [busy, setBusy] = useState<"draft" | "apply" | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const agentPrompt = useRef<Promise<string> | null>(null)
  const [waiting, setWaiting] = useState(false)
  const [interview, setInterview] = useState(false)
  /** The person edited the proposal shown: a completed version waits for their approval instead of overwriting it. */
  const [dirty, setDirty] = useState(false)
  const discarded = useRef<string | null>(null)
  const agent = useAgentOnboarding<Incoming>(true)
  const incoming = agent.draft && agent.draft.received_at !== discarded.current ? agent.draft : null
  const newer = draft?.generator === "agent" && incoming && incoming.received_at !== draft.received_at ? incoming : null
  const done = step >= questions.length
  // The interview is the other path, collapsed by default: the accounts' context comes first.
  const showInterview = (interview || step > 0 || Boolean(draft)) && draft?.generator !== "agent"

  // The proposal from Claude Code or Codex arrives through the API: the page fills itself in, then follows its completed
  // versions as long as the person has not touched it.
  useEffect(() => {
    if (!incoming || (draft && (draft.generator !== "agent" || dirty || draft.received_at === incoming.received_at))) return
    const d = fromAgent(incoming)
    setDraft(d)
    setKeep(d.items.map(() => true))
    setWaiting(false)
  }, [incoming, draft, dirty])

  function loadNewer() {
    if (!newer) return
    const d = fromAgent(newer)
    setDraft(d)
    setKeep(d.items.map(() => true))
    setDirty(false)
  }

  // A fresh upload code per visit (valid 2 h), requested on the first click.
  const getAgentPrompt = () => {
    agentPrompt.current ??= api<{ prompt: string }>("/api/onboarding/agent", { method: "POST" }).then((r) => r.prompt)
    agentPrompt.current.catch(() => (agentPrompt.current = null))
    setWaiting(true)
    return agentPrompt.current
  }

  async function discard() {
    if (draft?.generator === "agent") {
      discarded.current = incoming?.received_at ?? draft.received_at ?? null
      await api("/api/onboarding/import", { method: "DELETE" }).catch(() => {})
    }
    setDraft(null)
    setDirty(false)
  }

  useEffect(() => endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }), [step, draft])

  function answer(e: React.FormEvent) {
    e.preventDefault()
    const q = questions[step]
    setAnswers((a) => ({ ...a, [q.id]: current.trim() }))
    setCurrent("")
    setStep((s) => s + 1)
  }

  async function generate() {
    setBusy("draft")
    setErr(null)
    try {
      const d = withUniqueZones(await api<Draft>("/api/onboarding", { method: "POST", json: { answers } }))
      setDraft(d)
      setKeep(d.items.map(() => true))
    } catch (e) {
      setErr(`Could not synthesize: ${errorMessage(e)}`)
    } finally {
      setBusy(null)
    }
  }

  async function apply() {
    if (!draft) return
    setBusy("apply")
    setErr(null)
    try {
      await api("/api/onboarding/apply", {
        method: "POST",
        json: { company_name: draft.company_name, description: draft.description, zones: draft.zones, items: draft.items.filter((_, i) => keep[i]) },
      })
      router.push("/dashboard")
      router.refresh()
    } catch (e) {
      setErr(`Could not apply: ${errorMessage(e)}`)
      setBusy(null)
    }
  }

  return (
    <PageScroll width="max-w-[900px]">
      <header className="mb-5">
        <h1 className="text-[22px] font-medium leading-tight">Company onboarding</h1>
        <p className="mt-1 text-[13px] text-trace">
          5 to 10 minutes to give {orgName}&apos;s brain its first memory, {claude ? "with a synthesis by Claude" : "without Claude (heuristic synthesis)"}.
        </p>
      </header>
      {!draft && (
        <section className="panel mb-6 px-5 py-6 sm:px-7" aria-labelledby="agent-fill">
          <h2 id="agent-fill" className="text-[20px] font-medium leading-tight">
            Give the brain your accounts&apos; context
          </h2>
          <p className="mt-2 max-w-[46em] text-[14px] leading-relaxed text-trace">
            Claude Code or Codex re-reads your past conversations on this computer and your projects&apos; READMEs, draws the zones and first knowledge of{" "}
            {orgName} from them, and sends them to the brain. It asks for your consent before reading anything; the proposal shows up here on its own, and
            nothing is applied before you have reviewed and validated it.
          </p>
          <div className="mt-4">
            <PromptActions getPrompt={getAgentPrompt} size="md" sends />
          </div>
          <p className="text-[12px] text-trace">The upload code it contains is valid for 2 hours.</p>
          {agent.state !== "idle" ? (
            <>
              <p className="mt-3 text-[13px]" aria-live="polite">
                {agent.state === "error"
                  ? "Your agent stopped before sending its proposal. Send the message again, or answer the interview."
                  : "It's running: your agent is working in the background. You can leave this page, the proposal will be waiting for you here."}
              </p>
              <AgentRun run={agent.run} className="mt-3" />
            </>
          ) : (
            waiting && (
              <p className="mt-3 flex items-center gap-2 text-[13px]" aria-live="polite">
                <span className="live-dot" aria-hidden /> Waiting for your agent&apos;s proposal. This page will fill itself in.
              </p>
            )
          )}
        </section>
      )}
      {!draft && !showInterview && (
        <p className="text-[13px] text-trace">
          No history on this computer?{" "}
          <button type="button" className="landing-link text-ink" onClick={() => setInterview(true)}>
            Answer 7 questions instead
          </button>
          .
        </p>
      )}
      {!draft && showInterview && <h2 className="mb-3 text-[15px] font-medium">Or answer the interview</h2>}
      <div className="space-y-3">
        {showInterview &&
          questions.slice(0, Math.min(step + 1, questions.length)).map((q, i) => (
          <div key={q.id} className="space-y-2">
            <div className="flex gap-3">
              <span className="mt-1 shrink-0" aria-hidden>
                <BrainIcon size={24} />
              </span>
              <div className="panel bubble-in max-w-[85%] break-words px-4 py-3 text-[14px]">
                <span className="mr-2 text-[12px] tabular-nums text-trace">
                  {i + 1}/{questions.length}
                </span>
                {q.question}
              </div>
            </div>
            {answers[q.id] !== undefined && (
              <div className="flex justify-end">
                <div className="bubble-in max-w-[85%] whitespace-pre-line break-words rounded-[8px] bg-ink px-4 py-3 text-[14px] text-surface">
                  {answers[q.id] || <span className="text-line-strong">(skipped)</span>}
                </div>
              </div>
            )}
          </div>
        ))}

        {!done && showInterview && (
          <form onSubmit={answer} className="panel sticky bottom-4 flex gap-2 p-3">
            <textarea
              className="input min-h-[60px] flex-1"
              value={current}
              autoFocus
              aria-label="Your answer"
              onChange={(e) => setCurrent(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) answer(e)
              }}
              placeholder="Your answer. Enter to send, Shift+Enter for a new line, empty to skip."
            />
            <button type="submit" className="btn btn-primary self-end">
              Send
            </button>
          </form>
        )}

        {done && !draft && (
          <div className="panel p-5 text-center">
            <p className="text-[13px] text-trace">Thank you. The brain will read the links provided and propose its zones and first knowledge.</p>
            <button type="button" className="btn btn-primary mt-3" onClick={generate} disabled={busy === "draft"}>
              {busy === "draft" ? "Reading links and synthesizing" : "Generate the brain"}
            </button>
          </div>
        )}

        {draft && (
          <div className="panel space-y-4 p-5">
            <div>
              <h2 className="panel-title">Proposal {GENERATOR_LABEL(draft)}</h2>
              {draft.generator === "agent" && (
                <p className="mt-1 text-[12px] text-trace">
                  Drawn from your past conversations{draft.received_at ? `, received ${relativeTime(draft.received_at)}` : ""}. Review, untick what should not
                  go in, then validate: nothing is applied before that.
                </p>
              )}
              {draft.generator === "agent" && agent.state === "running" && !newer && (
                <p className="mt-2 flex items-center gap-2 text-[12px]" aria-live="polite">
                  <span className="live-dot is-live" aria-hidden /> {agent.run.at(-1)?.message ?? "Your agent is still completing its proposal."}
                </p>
              )}
              {newer && (
                <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]" aria-live="polite">
                  <span>
                    Completed version received: {newer.zones.length} zone{newer.zones.length === 1 ? "" : "s"}, {newer.items.length} knowledge item{newer.items.length === 1 ? "" : "s"}.
                  </span>
                  <button type="button" className="landing-link text-ink" onClick={loadNewer}>
                    Load it (your edits will be lost)
                  </button>
                </p>
              )}
              <input
                className="input mt-2 text-[18px] font-medium"
                aria-label="Company name"
                value={draft.company_name}
                onChange={(e) => {
                  setDraft({ ...draft, company_name: e.target.value })
                  setDirty(true)
                }}
              />
              <textarea className="input mt-2 min-h-[70px]" aria-label="Description" value={draft.description} onChange={(e) => {
                  setDraft({ ...draft, description: e.target.value })
                  setDirty(true)
                }}
              />
            </div>
            {draft.pages.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-trace">
                <span>Links read:</span>
                {draft.pages.map((p, i) => (
                  <span key={`${p.url}-${i}`} className="chip h-auto min-h-[22px] whitespace-normal break-all py-0.5">
                    {p.error ? <CloseIcon size={12} /> : <CheckIcon size={12} />}
                    {p.error ? `${p.url} (${p.error})` : `${p.title || p.url}${p.truncated ? " (truncated at 20,000 characters)" : ""}`}
                  </span>
                ))}
              </div>
            )}
            <div>
              <h3 className="panel-title">Zones</h3>
              {/* Explicit grid-cols-1: without a template, the column takes the width of the keyword line and the page overflows on mobile. */}
              <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                {draft.zones.map((z) => (
                  <div key={z.id} className="inset min-w-0 p-3">
                    <div className="break-words font-medium">{z.name}</div>
                    <div className="break-words text-[12px] text-trace">{z.description}</div>
                    <div className="mt-1 truncate text-[12px] text-trace" title={z.keywords.join(", ")}>
                      {z.keywords.join(", ")}
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <h3 className="panel-title">
                First knowledge (<span className="tabular-nums">{keep.filter(Boolean).length}</span>/<span className="tabular-nums">{draft.items.length}</span>)
              </h3>
              <div className="mt-2 space-y-1.5">
                {draft.items.map((it, i) => (
                  <label key={i} className="inset flex cursor-pointer items-start gap-2.5 p-3">
                    <input type="checkbox" className="mt-1 size-4" checked={keep[i]} onChange={() => {
                        setKeep((k) => k.map((v, j) => (j === i ? !v : v)))
                        setDirty(true)
                      }}
                    />
                    <div className="min-w-0">
                      <div className="flex flex-wrap gap-1.5 text-[12px]">
                        <span className="chip">{KIND_LABEL[it.kind]}</span>
                        <span className="chip">{draft.zones.find((z) => z.id === it.zone)?.name ?? (it.zone === CORE_ZONE.id ? CORE_ZONE.name : it.zone)}</span>
                      </div>
                      <div className="mt-1 text-[13.5px] font-medium">{it.title}</div>
                      <div className="mt-0.5 line-clamp-2 text-[12px] text-trace">{it.body}</div>
                    </div>
                  </label>
                ))}
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" className="btn" onClick={discard}>
                {draft.generator === "agent" ? "Discard the proposal" : "Redo the synthesis"}
              </button>
              <button type="button" className="btn btn-primary" onClick={apply} disabled={busy === "apply"}>
                {busy === "apply" ? "Creating" : "Validate and light up the brain"}
              </button>
            </div>
          </div>
        )}
        {err && <ErrorText>{err}</ErrorText>}
        <div ref={endRef} />
      </div>
      {/* Before the proposal, the thread is in the page; afterwards, its signals arrive as notifications. */}
      {draft && <AgentToasts toasts={agent.toasts} dismiss={agent.dismiss} />}
    </PageScroll>
  )
}
