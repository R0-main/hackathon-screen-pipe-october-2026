"use client"

import { useEffect, useRef, useState } from "react"
import { MODERATION_REASON_LABELS } from "@brain/core"
import type { ModerationLogEntry, ModerationRun } from "@/lib/moderation"
import { api, errorMessage } from "./format"
import { RelTime } from "./RelTime"
import { ErrorText } from "./ui"

type State = { enabled: boolean; claude: "org" | "server" | null; runs: ModerationRun[]; log: ModerationLogEntry[]; base_url: string }

const KINDS: Record<string, string> = { fact: "fait", decision: "décision", task: "tâche", procedure: "procédure", question: "question" }

const STATUS: Record<string, string> = {
  nothing: "rien de nouveau",
  off: "modérateur coupé",
  no_claude: "pas de clé Claude côté serveur",
  claude_error: "Claude n'a pas répondu, relu au passage suivant",
}

function runLine(r: ModerationRun): string {
  if (r.status !== "done") return STATUS[r.status] ?? r.status
  return `${r.reviewed} relue${r.reviewed > 1 ? "s" : ""}, ${r.edited} corrigée${r.edited > 1 ? "s" : ""}, ${r.rejected} retirée${r.rejected > 1 ? "s" : ""}${r.remaining ? `, ${r.remaining} en attente` : ""}`
}

function decisionLine(e: ModerationLogEntry): string {
  const what = `${KINDS[e.kind] ?? e.kind} de ${e.author} (${e.zone})`
  if (e.decision === "edit") return `Corrigée : ${what}`
  return `Retirée : ${what}, ${MODERATION_REASON_LABELS[e.category ?? "autre"]}${e.reason ? ` — ${e.reason}` : ""}`
}

/**
 * Workflow GitHub Actions de l'entreprise : toutes les 15 min, son Claude Code (jeton d'abonnement du CEO) relit ce qui
 * est arrivé dans le cerveau, puis refait le résumé « où en est la boîte » s'il y avait du nouveau.
 */
export function moderationWorkflow(baseUrl: string): string {
  return `name: Cerveau — modérateur et résumé
on:
  schedule:
    - cron: "*/15 * * * *"
  workflow_dispatch:
concurrency:
  group: cerveau-moderateur
  cancel-in-progress: false
jobs:
  moderate:
    runs-on: ubuntu-latest
    timeout-minutes: 12
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Claude Code et le client du cerveau
        run: |
          npm install -g @anthropic-ai/claude-code
          curl -fsSL ${baseUrl}/brain.mjs -o "$RUNNER_TEMP/brain.mjs"
      - name: Modérateur, puis résumé
        env:
          BRAIN_TOKEN: \${{ secrets.BRAIN_TOKEN }}
          CLAUDE_CODE_OAUTH_TOKEN: \${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
        run: |
          node "$RUNNER_TEMP/brain.mjs" init --home "$RUNNER_TEMP/brain" --url ${baseUrl} --token "$BRAIN_TOKEN"
          node "$RUNNER_TEMP/brain.mjs" moderate --refresh-status --home "$RUNNER_TEMP/brain"
`
}

/** Modérateur du cerveau : qui le fait tourner (Claude Code du CEO en CI), interrupteur, derniers passages et décisions. */
export function Moderation() {
  const [state, setState] = useState<State | null>(null)
  const [busy, setBusy] = useState<"toggle" | "run" | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const preRef = useRef<HTMLPreElement>(null)

  const load = () =>
    api<State>("/api/admin/moderation")
      .then(setState)
      .catch((e) => setErr(errorMessage(e)))
  useEffect(() => {
    void load()
  }, [])

  async function toggle() {
    if (!state) return
    setBusy("toggle")
    setErr(null)
    try {
      const r = await api<{ enabled: boolean }>("/api/admin/moderation", { method: "PUT", json: { enabled: !state.enabled } })
      setState({ ...state, enabled: r.enabled })
    } catch (e) {
      setErr(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  async function runNow() {
    setBusy("run")
    setErr(null)
    try {
      await api<ModerationRun>("/api/admin/moderation", { method: "POST" })
      await load()
    } catch (e) {
      setErr(`Passage impossible : ${errorMessage(e)}`)
    } finally {
      setBusy(null)
    }
  }

  async function copy() {
    if (!state) return
    try {
      if (!navigator.clipboard?.writeText) throw new Error("presse-papiers indisponible")
      await navigator.clipboard.writeText(moderationWorkflow(state.base_url))
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      const sel = window.getSelection()
      if (preRef.current && sel) {
        const range = document.createRange()
        range.selectNodeContents(preRef.current)
        sel.removeAllRanges()
        sel.addRange(range)
      }
      setErr("Copie automatique impossible ici : le fichier est sélectionné, copiez-le avec Ctrl+C (⌘C sur Mac).")
    }
  }

  return (
    <section className="panel space-y-4 p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h2 className="panel-title">Modérateur</h2>
          <p className="text-[13px] text-trace">
            Toutes les 15 min, Claude relit ce qui est arrivé dans le cerveau : il garde, corrige (titre, zone, type) ou retire (contenu personnel, secret,
            doublon, trop vague, consigne suspecte, jugement sur une personne), puis refait le résumé « où en est la boîte ». Le texte retiré n&apos;est gardé
            nulle part.
          </p>
        </div>
        {state && (
          <button type="button" className={`chip ${state.enabled ? "chip-on" : ""}`} aria-pressed={state.enabled} onClick={toggle} disabled={busy !== null}>
            {state.enabled ? "Actif" : "Coupé"}
          </button>
        )}
      </div>

      {state && (
        <div className="space-y-3">
          <p className="text-[13px]">
            Il tourne dans votre CI GitHub, avec le Claude Code du CEO et son abonnement (Sonnet) : aucune clé API, aucun PC allumé, et le jeton Claude ne
            quitte jamais la CI.
          </p>
          <ol className="list-decimal space-y-1.5 pl-5 text-[13px]">
            <li>
              Sur le poste du CEO : <code className="mono">claude setup-token</code>, et copiez le jeton affiché.
            </li>
            <li>
              Dans un repo GitHub de l&apos;entreprise, deux secrets : <code className="mono">CLAUDE_CODE_OAUTH_TOKEN</code> (ce jeton) et{" "}
              <code className="mono">BRAIN_TOKEN</code> (le jeton du cerveau du CEO, champ <code className="mono">token</code> de{" "}
              <code className="mono">~/.company-brain/config.json</code>).
            </li>
            <li>
              Ce fichier sous <code className="mono">.github/workflows/cerveau-moderateur.yml</code> (GitHub peut décaler un passage de quelques minutes).
            </li>
          </ol>
          <div className="relative">
            <pre ref={preRef} className="scroll-thin mono inset max-h-[320px] overflow-auto p-3 text-[12px] leading-relaxed">
              {moderationWorkflow(state.base_url)}
            </pre>
            <button type="button" className="btn btn-sm absolute right-2 top-2" onClick={copy}>
              {copied ? "Copié" : "Copier"}
            </button>
          </div>
        </div>
      )}

      {err && <ErrorText>{err}</ErrorText>}

      <div className="space-y-2 border-t border-line pt-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-[13px] font-medium">Derniers passages</h3>
          {state?.claude && (
            <button type="button" className="btn btn-sm" onClick={runNow} disabled={busy !== null || !state.enabled}>
              {busy === "run" ? "Claude relit…" : "Lancer maintenant (clé API)"}
            </button>
          )}
        </div>
        {!state && !err ? (
          <p className="text-[13px] text-trace">Chargement…</p>
        ) : !state || state.runs.length === 0 ? (
          <p className="text-[13px] text-trace">Aucun passage pour l&apos;instant.</p>
        ) : (
          <ul className="space-y-1.5">
            {state.runs.slice(0, 6).map((r) => (
              <li key={r.at} className="flex gap-3 text-[13px]">
                <RelTime iso={r.at} className="w-28 shrink-0 text-trace" />
                <span className="min-w-0">
                  {runLine(r)}
                  <span className="text-trace">{r.via === "claude-code" ? " · Claude Code" : " · serveur"}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {state && state.log.length > 0 && (
        <div className="space-y-2 border-t border-line pt-3">
          <h3 className="text-[13px] font-medium">Dernières décisions</h3>
          <ul className="space-y-1.5">
            {state.log.slice(0, 12).map((e, n) => (
              <li key={`${e.at}-${n}`} className="flex gap-3 text-[13px]">
                <RelTime iso={e.at} className="w-28 shrink-0 text-trace" />
                <span className="min-w-0">{decisionLine(e)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
