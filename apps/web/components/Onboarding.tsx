"use client"

import Link from "next/link"
import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import type { KnowledgeItemInput } from "@brain/core"
import { PageScroll } from "./AppShell"
import { KIND_LABEL, api, errorMessage } from "./format"
import { BrainIcon, CheckIcon, CloseIcon, ErrorText } from "./ui"

type Question = { id: string; question: string }
type Draft = {
  company_name: string
  description: string
  zones: { id: string; name: string; description: string; keywords: string[] }[]
  items: KnowledgeItemInput[]
  generator: "claude" | "heuristic"
  pages: { url: string; title: string; truncated: boolean; error?: string }[]
}

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
  const done = step >= questions.length

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
      router.push("/")
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
      <div className="space-y-3">
        {questions.slice(0, Math.min(step + 1, questions.length)).map((q, i) => (
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

        {!done && (
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
              <h2 className="panel-title">Proposition {draft.generator === "claude" ? "de Claude" : "heuristique"}</h2>
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
              <button type="button" className="btn" onClick={() => setDraft(null)}>
                Recommencer la synthèse
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
