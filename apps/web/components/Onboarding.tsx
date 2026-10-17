"use client"

import Link from "next/link"
import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import type { KnowledgeItemInput } from "@brain/core"
import { PageScroll } from "./AppShell"
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
  /** Proposition déposée par un agent (Claude Code ou Codex) depuis l'historique du poste. */
  source?: "claude-code" | "codex" | "autre"
  received_at?: string
}

const AGENT_LABEL = { "claude-code": "Claude Code", codex: "Codex", autre: "votre agent" } as const
const POLL_MS = 4000

const GENERATOR_LABEL = (d: Draft) => (d.generator === "agent" ? `de ${AGENT_LABEL[d.source ?? "autre"]}` : d.generator === "claude" ? "de Claude" : "heuristique")

/** Une zone par identifiant (la synthèse peut en renvoyer deux identiques) : clés React et zones appliquées uniques. */
function withUniqueZones(d: Draft): Draft {
  const seen = new Set<string>()
  const zones = d.zones.filter((z) => (seen.has(z.id) ? false : (seen.add(z.id), true)))
  return zones.length === d.zones.length ? d : { ...d, zones }
}

/** Interview de 5 à 10 minutes : le dirigeant présente l'entreprise, le cerveau en tire ses zones et ses premières connaissances. */
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
  const done = step >= questions.length
  // L'interview est l'autre chemin, replié par défaut : le contexte des comptes passe en premier.
  const showInterview = (interview || step > 0 || Boolean(draft)) && draft?.generator !== "agent"

  // La proposition de Claude Code ou Codex arrive par l'API : la page la relit et se remplit toute seule.
  useEffect(() => {
    if (draft) return
    let stop = false
    const tick = async () => {
      try {
        const r = await api<{ draft: (Omit<Draft, "generator" | "pages"> & { received_at: string }) | null }>("/api/onboarding/import")
        if (stop || !r.draft) return
        const d = withUniqueZones({ ...r.draft, generator: "agent", pages: [] })
        setDraft(d)
        setKeep(d.items.map(() => true))
        setWaiting(false)
      } catch {}
    }
    void tick()
    const id = setInterval(tick, POLL_MS)
    return () => {
      stop = true
      clearInterval(id)
    }
  }, [draft])

  // Un code d'envoi neuf par visite (valable 2 h), demandé au premier clic.
  const getAgentPrompt = () => {
    agentPrompt.current ??= api<{ prompt: string }>("/api/onboarding/agent", { method: "POST" }).then((r) => r.prompt)
    agentPrompt.current.catch(() => (agentPrompt.current = null))
    setWaiting(true)
    return agentPrompt.current
  }

  async function discard() {
    if (draft?.generator === "agent") await api("/api/onboarding/import", { method: "DELETE" }).catch(() => {})
    setDraft(null)
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
      setErr(`Synthèse impossible : ${errorMessage(e)}`)
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
      setErr(`Application impossible : ${errorMessage(e)}`)
      setBusy(null)
    }
  }

  return (
    <PageScroll width="max-w-[900px]">
      <header className="mb-5">
        <h1 className="text-[22px] font-medium leading-tight">Onboarding de l&apos;entreprise</h1>
        <p className="mt-1 text-[13px] text-trace">
          5 à 10 minutes pour donner au cerveau de {orgName} sa première mémoire, {claude ? "avec une synthèse par Claude" : "en mode sans Claude (synthèse heuristique)"}.
        </p>
      </header>
      {!draft && (
        <section className="panel mb-6 px-5 py-6 sm:px-7" aria-labelledby="agent-fill">
          <h2 id="agent-fill" className="text-[20px] font-medium leading-tight">
            Donnez au cerveau le contexte de vos comptes
          </h2>
          <p className="mt-2 max-w-[46em] text-[14px] leading-relaxed text-trace">
            Claude Code ou Codex relit vos anciennes conversations sur ce poste et les README de vos projets, en tire les zones et les premières connaissances de{" "}
            {orgName}, et les envoie au cerveau. Il vous demande votre accord avant de lire quoi que ce soit ; la proposition s&apos;affiche ici toute seule, et
            rien n&apos;est appliqué avant que vous l&apos;ayez relue et validée.
          </p>
          <div className="mt-4">
            <PromptActions getPrompt={getAgentPrompt} size="md" sends />
          </div>
          <p className="text-[12px] text-trace">Le code d&apos;envoi qu&apos;il contient vaut 2 heures.</p>
          {waiting && (
            <p className="mt-3 flex items-center gap-2 text-[13px]" aria-live="polite">
              <span className="live-dot" aria-hidden /> En attente de la proposition de votre agent. Cette page se remplira toute seule.
            </p>
          )}
        </section>
      )}
      {!draft && !showInterview && (
        <p className="text-[13px] text-trace">
          Pas d&apos;historique sur ce poste ?{" "}
          <button type="button" className="landing-link text-ink" onClick={() => setInterview(true)}>
            Répondez plutôt à 7 questions
          </button>
          .
        </p>
      )}
      {!draft && showInterview && <h2 className="mb-3 text-[15px] font-medium">Ou répondez à l&apos;interview</h2>}
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
                  {answers[q.id] || <span className="text-line-strong">(passé)</span>}
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
              aria-label="Votre réponse"
              onChange={(e) => setCurrent(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) answer(e)
              }}
              placeholder="Votre réponse. Entrée pour envoyer, Maj+Entrée pour aller à la ligne, vide pour passer."
            />
            <button type="submit" className="btn btn-primary self-end">
              Envoyer
            </button>
          </form>
        )}

        {done && !draft && (
          <div className="panel p-5 text-center">
            <p className="text-[13px] text-trace">Merci. Le cerveau va lire les liens fournis et proposer ses zones et ses premières connaissances.</p>
            <button type="button" className="btn btn-primary mt-3" onClick={generate} disabled={busy === "draft"}>
              {busy === "draft" ? "Lecture des liens et synthèse" : "Générer le cerveau"}
            </button>
          </div>
        )}

        {draft && (
          <div className="panel space-y-4 p-5">
            <div>
              <h2 className="panel-title">Proposition {GENERATOR_LABEL(draft)}</h2>
              {draft.generator === "agent" && (
                <p className="mt-1 text-[12px] text-trace">
                  Tirée de vos anciennes conversations{draft.received_at ? `, reçue ${relativeTime(draft.received_at)}` : ""}. Relisez, décochez ce qui ne doit pas
                  entrer, puis validez : rien n&apos;est appliqué avant.
                </p>
              )}
              <input
                className="input mt-2 text-[18px] font-medium"
                aria-label="Nom de l'entreprise"
                value={draft.company_name}
                onChange={(e) => setDraft({ ...draft, company_name: e.target.value })}
              />
              <textarea className="input mt-2 min-h-[70px]" aria-label="Description" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
            </div>
            {draft.pages.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-trace">
                <span>Liens lus :</span>
                {draft.pages.map((p, i) => (
                  <span key={`${p.url}-${i}`} className="chip h-auto min-h-[22px] whitespace-normal break-all py-0.5">
                    {p.error ? <CloseIcon size={12} /> : <CheckIcon size={12} />}
                    {p.error ? `${p.url} (${p.error})` : `${p.title || p.url}${p.truncated ? " (tronqué à 20 000 caractères)" : ""}`}
                  </span>
                ))}
              </div>
            )}
            <div>
              <h3 className="panel-title">Zones</h3>
              {/* grid-cols-1 explicite : sans gabarit, la colonne prend la largeur de la ligne de mots-clés et la page déborde sur mobile. */}
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
                Premières connaissances (<span className="tabular-nums">{keep.filter(Boolean).length}</span>/<span className="tabular-nums">{draft.items.length}</span>)
              </h3>
              <div className="mt-2 space-y-1.5">
                {draft.items.map((it, i) => (
                  <label key={i} className="inset flex cursor-pointer items-start gap-2.5 p-3">
                    <input type="checkbox" className="mt-1 size-4" checked={keep[i]} onChange={() => setKeep((k) => k.map((v, j) => (j === i ? !v : v)))} />
                    <div className="min-w-0">
                      <div className="flex flex-wrap gap-1.5 text-[12px]">
                        <span className="chip">{KIND_LABEL[it.kind]}</span>
                        <span className="chip">{draft.zones.find((z) => z.id === it.zone)?.name ?? it.zone}</span>
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
                {draft.generator === "agent" ? "Écarter la proposition" : "Recommencer la synthèse"}
              </button>
              <button type="button" className="btn btn-primary" onClick={apply} disabled={busy === "apply"}>
                {busy === "apply" ? "Création en cours" : "Valider et allumer le cerveau"}
              </button>
            </div>
          </div>
        )}
        {err && <ErrorText>{err}</ErrorText>}
        <div ref={endRef} />
      </div>
    </PageScroll>
  )
}
