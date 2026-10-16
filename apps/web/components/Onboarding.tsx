"use client"

import Link from "next/link"
import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import type { KnowledgeItemInput } from "@brain/core"
import { BrainIcon } from "./TopBar"
import { KIND_COLOR, KIND_LABEL, api } from "./format"

type Question = { id: string; question: string }
type Draft = {
  company_name: string
  description: string
  zones: { id: string; name: string; description: string; keywords: string[] }[]
  items: KnowledgeItemInput[]
  generator: "claude" | "heuristic"
  pages: { url: string; title: string; truncated: boolean; error?: string }[]
}

/** Interview de 5-10 min : le dirigeant présente l'entreprise, le cerveau en tire ses zones et ses premières connaissances. */
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
      const d = await api<Draft>("/api/onboarding", { method: "POST", json: { answers } })
      setDraft(d)
      setKeep(d.items.map(() => true))
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
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
      setErr(e instanceof Error ? e.message : String(e))
      setBusy(null)
    }
  }

  return (
    <div className="min-h-screen">
      <header className="border-b border-[var(--border)] bg-[rgba(4,6,12,0.75)] backdrop-blur-md">
        <div className="mx-auto flex max-w-[900px] items-center gap-3 px-4 py-3">
          <BrainIcon />
          <div>
            <div className="font-semibold">Onboarding de l&apos;entreprise</div>
            <div className="text-xs text-[var(--muted)]">
              5-10 minutes pour donner au cerveau de {orgName} sa première mémoire {claude ? "(synthèse par Claude)" : "(mode sans Claude : synthèse heuristique)"}
            </div>
          </div>
          <Link href="/" className="btn ml-auto">
            ← Cerveau
          </Link>
        </div>
      </header>
      <main className="mx-auto max-w-[900px] space-y-3 px-4 py-6">
        {questions.slice(0, Math.min(step + 1, questions.length)).map((q, i) => (
          <div key={q.id} className="space-y-2">
            <div className="flex gap-3">
              <span className="mt-1 shrink-0">
                <BrainIcon size={24} />
              </span>
              <div className="panel bubble-in max-w-[85%] px-4 py-3 text-[14px]">
                <span className="mr-2 text-xs text-[var(--faint)]">
                  {i + 1}/{questions.length}
                </span>
                {q.question}
              </div>
            </div>
            {answers[q.id] !== undefined && (
              <div className="flex justify-end">
                <div className="bubble-in max-w-[85%] whitespace-pre-line rounded-2xl border border-cyan-400/30 bg-cyan-400/10 px-4 py-3 text-[14px]">
                  {answers[q.id] || <span className="italic text-[var(--faint)]">(passé)</span>}
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
              onChange={(e) => setCurrent(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) answer(e)
              }}
              placeholder="Votre réponse (Entrée pour envoyer, Maj+Entrée pour aller à la ligne, vide pour passer)"
            />
            <button className="btn btn-primary self-end">Envoyer</button>
          </form>
        )}

        {done && !draft && (
          <div className="panel p-5 text-center">
            <p className="text-sm text-[var(--muted)]">Merci ! Le cerveau va lire les liens fournis et proposer ses zones et ses premières connaissances.</p>
            <button className="btn btn-primary mt-3" onClick={generate} disabled={busy === "draft"}>
              {busy === "draft" ? "Lecture des liens et synthèse…" : "Générer le cerveau"}
            </button>
          </div>
        )}

        {draft && (
          <div className="panel space-y-4 p-5">
            <div>
              <div className="panel-title">Proposition {draft.generator === "claude" ? "de Claude" : "(heuristique)"}</div>
              <input className="input mt-2 text-lg font-semibold" value={draft.company_name} onChange={(e) => setDraft({ ...draft, company_name: e.target.value })} />
              <textarea className="input mt-2 min-h-[70px]" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
            </div>
            {draft.pages.length > 0 && (
              <div className="text-xs text-[var(--muted)]">
                Liens lus :{" "}
                {draft.pages.map((p) => (
                  <span key={p.url} className="chip mr-1">
                    {p.error ? `✗ ${p.url} (${p.error})` : `✓ ${p.title || p.url}${p.truncated ? " (tronqué à 20 000 caractères)" : ""}`}
                  </span>
                ))}
              </div>
            )}
            <div>
              <div className="panel-title">Zones</div>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {draft.zones.map((z) => (
                  <div key={z.id} className="rounded-xl border border-[var(--border)] p-3">
                    <div className="font-medium">{z.name}</div>
                    <div className="text-xs text-[var(--muted)]">{z.description}</div>
                    <div className="mt-1 truncate text-[11px] text-[var(--faint)]">{z.keywords.join(", ")}</div>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <div className="panel-title">Premières connaissances ({keep.filter(Boolean).length}/{draft.items.length})</div>
              <div className="mt-2 space-y-1.5">
                {draft.items.map((it, i) => (
                  <label key={i} className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-[var(--border)] p-3 hover:border-[var(--border-strong)]">
                    <input type="checkbox" className="mt-1 accent-cyan-400" checked={keep[i]} onChange={() => setKeep((k) => k.map((v, j) => (j === i ? !v : v)))} />
                    <div className="min-w-0">
                      <div className="flex flex-wrap gap-1.5 text-[11px]">
                        <span className="chip !py-0" style={{ color: KIND_COLOR[it.kind] }}>
                          {KIND_LABEL[it.kind]}
                        </span>
                        <span className="chip !py-0">{draft.zones.find((z) => z.id === it.zone)?.name ?? it.zone}</span>
                      </div>
                      <div className="mt-1 text-[13.5px] font-medium">{it.title}</div>
                      <div className="mt-0.5 line-clamp-2 text-xs text-[var(--muted)]">{it.body}</div>
                    </div>
                  </label>
                ))}
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button className="btn" onClick={() => setDraft(null)}>
                Recommencer la synthèse
              </button>
              <button className="btn btn-primary" onClick={apply} disabled={busy === "apply"}>
                {busy === "apply" ? "Création…" : "Valider et allumer le cerveau"}
              </button>
            </div>
          </div>
        )}
        {err && <p className="text-sm text-red-300">{err}</p>}
        <div ref={endRef} />
      </main>
    </div>
  )
}
