"use client"

import { useEffect, useRef, useState } from "react"
import type { ClaudeKeyInfo } from "@/lib/claude-key"
import type { NewZonesRun } from "@/lib/new-zones"
import { api, errorMessage } from "./format"
import { RelTime } from "./RelTime"
import { CheckIcon, ErrorText } from "./ui"

type Mode = "subscription" | "api"

const SKIPPED: Record<string, string> = {
  no_claude: "pas de clé Claude",
  too_few_items: "pas assez de connaissances récentes",
  max_zones: "12 zones, le plafond est atteint",
  claude_error: "Claude n'a pas répondu, nouvel essai demain",
}

function outcome(r: NewZonesRun): string {
  if (r.status === "created") return `Créée${r.zones.length > 1 ? "s" : ""} : ${r.zones.map((z) => `${z.name} (${z.items} connaissance${z.items > 1 ? "s" : ""})`).join(", ")}`
  if (r.status === "unchanged") return "Rien à créer"
  return `Rien fait : ${SKIPPED[r.reason] ?? r.reason}`
}

/**
 * Workflow GitHub Actions de l'entreprise : son Claude Code, avec son jeton d'abonnement (`claude setup-token`), fait
 * l'analyse chaque jour à 10 h (heure de Paris) dans SA CI ; le cerveau ne reçoit que les propositions.
 */
export function ciWorkflow(baseUrl: string): string {
  return `name: Cerveau — nouvelles zones
on:
  schedule:
    - cron: "0 8 * * *"
    - cron: "0 9 * * *"
  workflow_dispatch:
jobs:
  zones:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - name: 10 h à Paris (GitHub ne compte qu'en UTC)
        id: hour
        run: |
          if [ "$GITHUB_EVENT_NAME" = "workflow_dispatch" ] || [ "$(TZ=Europe/Paris date +%H)" = "10" ]; then echo "go=1" >> "$GITHUB_OUTPUT"; fi
      - if: steps.hour.outputs.go == '1'
        uses: actions/setup-node@v4
        with:
          node-version: 22
      - if: steps.hour.outputs.go == '1'
        name: Claude Code et le client du cerveau
        run: |
          npm install -g @anthropic-ai/claude-code
          curl -fsSL ${baseUrl}/brain.mjs -o "$RUNNER_TEMP/brain.mjs"
      - if: steps.hour.outputs.go == '1'
        name: Nouvelles zones
        env:
          BRAIN_TOKEN: \${{ secrets.BRAIN_TOKEN }}
          CLAUDE_CODE_OAUTH_TOKEN: \${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
        run: |
          node "$RUNNER_TEMP/brain.mjs" init --home "$RUNNER_TEMP/brain" --url ${baseUrl} --token "$BRAIN_TOKEN"
          node "$RUNNER_TEMP/brain.mjs" refresh-zones --home "$RUNNER_TEMP/brain"
`
}

/**
 * Zones automatiques : qui fait l'analyse quotidienne (le Claude Code de l'entreprise avec son abonnement, en CI, ou
 * le serveur avec la clé API de l'entreprise), et l'historique des passages. `onZonesChanged` relit la liste des zones.
 */
export function AutoZones({ onZonesChanged }: { onZonesChanged: () => void }) {
  const [info, setInfo] = useState<ClaudeKeyInfo | null>(null)
  const [runs, setRuns] = useState<NewZonesRun[]>([])
  const [baseUrl, setBaseUrl] = useState("")
  const [mode, setMode] = useState<Mode | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    Promise.all([api<ClaudeKeyInfo>("/api/admin/claude"), api<{ runs: NewZonesRun[]; base_url: string }>("/api/admin/zones/auto")])
      .then(([i, r]) => {
        setInfo(i)
        setRuns(r.runs)
        setBaseUrl(r.base_url)
        // Une clé déjà enregistrée : on montre ce mode ; sinon l'abonnement Claude Code, sans clé API.
        setMode((m) => m ?? (i.source === "org" ? "api" : "subscription"))
      })
      .catch((e) => setErr(errorMessage(e)))
  }, [])

  async function runNow() {
    setBusy(true)
    setErr(null)
    try {
      const run = await api<NewZonesRun>("/api/admin/zones/auto", { method: "POST" })
      setRuns((prev) => [run, ...prev])
      if (run.status === "created") onZonesChanged()
    } catch (e) {
      setErr(`Passage impossible : ${errorMessage(e)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="panel space-y-4 p-4 sm:p-5">
      <div className="space-y-1">
        <h2 className="panel-title">Zones automatiques</h2>
        <p className="text-[13px] text-trace">
          Chaque jour à 10 h, Claude relit les connaissances des 30 derniers jours et crée la zone d&apos;un domaine qui revient sans avoir la sienne. Ses
          connaissances y sont rangées, et ceux qui les lisaient la lisent aussi.
        </p>
      </div>

      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Qui fait l'analyse">
        <button type="button" className={`chip ${mode === "subscription" ? "chip-on" : ""}`} aria-pressed={mode === "subscription"} onClick={() => setMode("subscription")}>
          Abonnement Claude (Claude Code)
        </button>
        <button type="button" className={`chip ${mode === "api" ? "chip-on" : ""}`} aria-pressed={mode === "api"} onClick={() => setMode("api")}>
          Clé API Claude
        </button>
      </div>

      {mode === "subscription" && <SubscriptionSetup baseUrl={baseUrl} />}
      {mode === "api" && info && <ApiKeySetup info={info} onInfo={setInfo} />}

      {err && <ErrorText>{err}</ErrorText>}

      <div className="space-y-2 border-t border-line pt-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-[13px] font-medium">Derniers passages</h3>
          {mode === "api" && (
            <button type="button" className="btn btn-sm" onClick={runNow} disabled={busy || !info?.source} title={info?.source ? undefined : "Ajoutez d'abord une clé Claude."}>
              {busy ? "Claude relit le cerveau…" : "Lancer maintenant"}
            </button>
          )}
        </div>
        {mode === null && !err ? (
          <p className="text-[13px] text-trace">Chargement…</p>
        ) : runs.length === 0 ? (
          <p className="text-[13px] text-trace">Aucun passage pour l&apos;instant.</p>
        ) : (
          <ul className="space-y-1.5">
            {runs.slice(0, 6).map((r) => (
              <li key={r.at} className="flex gap-3 text-[13px]">
                <RelTime iso={r.at} className="w-28 shrink-0 text-trace" />
                <span className="min-w-0">
                  {outcome(r)}
                  <span className="text-trace">{r.via === "claude-code" ? " · Claude Code" : " · serveur"}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}

/** Mode abonnement : la marche à suivre pour la CI de l'entreprise, et le workflow à copier. */
function SubscriptionSetup({ baseUrl }: { baseUrl: string }) {
  const [copied, setCopied] = useState(false)
  const [copyErr, setCopyErr] = useState<string | null>(null)
  const preRef = useRef<HTMLPreElement>(null)
  const yaml = baseUrl ? ciWorkflow(baseUrl) : ""

  async function copy() {
    setCopyErr(null)
    try {
      if (!navigator.clipboard?.writeText) throw new Error("presse-papiers indisponible")
      await navigator.clipboard.writeText(yaml)
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
      setCopyErr("Copie automatique impossible ici : le fichier est sélectionné, copiez-le avec Ctrl+C (⌘C sur Mac).")
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-[13px]">
        L&apos;analyse tourne dans votre propre CI GitHub, avec le Claude Code de l&apos;entreprise et votre abonnement : aucune clé API, aucun PC allumé, et le
        jeton Claude ne quitte jamais votre CI. Le cerveau ne reçoit que les zones proposées.
      </p>
      <ol className="list-decimal space-y-1.5 pl-5 text-[13px]">
        <li>
          Sur votre poste, lancez <code className="mono">claude setup-token</code> et copiez le jeton affiché (valable un an).
        </li>
        <li>
          Dans un repo GitHub de l&apos;entreprise, <span className="text-trace">Settings → Secrets and variables → Actions</span>, créez deux secrets :{" "}
          <code className="mono">CLAUDE_CODE_OAUTH_TOKEN</code> (ce jeton) et <code className="mono">BRAIN_TOKEN</code> (votre jeton du cerveau, champ{" "}
          <code className="mono">token</code> de <code className="mono">~/.company-brain/config.json</code>).
        </li>
        <li>
          Ajoutez ce fichier sous <code className="mono">.github/workflows/cerveau-zones.yml</code>. Pour un premier essai :{" "}
          <span className="text-trace">Actions → Cerveau — nouvelles zones → Run workflow</span>.
        </li>
      </ol>
      <pre ref={preRef} className="scroll-thin mono inset max-h-[320px] overflow-auto p-3 text-[12px] leading-relaxed">
        {yaml || "Chargement…"}
      </pre>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn btn-sm" onClick={copy} disabled={!yaml}>
          {copied ? (
            <>
              <CheckIcon size={14} /> Copié
            </>
          ) : (
            "Copier le workflow"
          )}
        </button>
        <span className="text-[12px] text-trace">
          Ou à la main sur votre poste : <code className="mono">~/.company-brain/brain refresh-zones</code>
        </span>
      </div>
      {copyErr && <ErrorText className="text-[12px]">{copyErr}</ErrorText>}
    </div>
  )
}

/** Mode clé API : le serveur fait l'analyse avec la clé de l'entreprise (vérifiée, chiffrée, jamais réaffichée). */
function ApiKeySetup({ info, onInfo }: { info: ClaudeKeyInfo; onInfo: (i: ClaudeKeyInfo) => void }) {
  const [key, setKey] = useState("")
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState<"save" | "remove" | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [ok, setOk] = useState<string | null>(null)
  const showForm = info.source !== "org" || editing

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setBusy("save")
    setErr(null)
    setOk(null)
    try {
      onInfo(await api<ClaudeKeyInfo>("/api/admin/claude", { method: "PUT", json: { key: key.trim() } }))
      setKey("")
      setEditing(false)
      setOk("Clé vérifiée auprès d'Anthropic et enregistrée.")
    } catch (e) {
      setErr(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  async function remove() {
    if (!confirm("Retirer la clé Claude de l'entreprise ? Le serveur ne créera plus de zones avec elle.")) return
    setBusy("remove")
    setErr(null)
    setOk(null)
    try {
      onInfo(await api<ClaudeKeyInfo>("/api/admin/claude", { method: "DELETE" }))
    } catch (e) {
      setErr(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="space-y-2">
      <p className="text-[13px]">
        {info.source === "org" ? (
          <>
            Clé Claude de l&apos;entreprise : <span className="font-mono">sk-ant-…{info.last4}</span>
            {info.updated_at && (
              <span className="text-trace">
                {" "}
                · enregistrée <RelTime iso={info.updated_at} />
              </span>
            )}
          </>
        ) : info.source === "server" ? (
          "Clé Claude : celle du serveur. Ajoutez la vôtre pour que les appels soient facturés à votre entreprise."
        ) : (
          "Le serveur fait l'analyse avec la clé API de l'entreprise : aucune n'est enregistrée pour l'instant."
        )}
      </p>
      {info.source === "org" && !editing && (
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn btn-sm" onClick={() => setEditing(true)} disabled={busy !== null}>
            Remplacer la clé
          </button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={remove} disabled={busy !== null}>
            {busy === "remove" ? "Retrait…" : "Retirer"}
          </button>
        </div>
      )}
      {showForm && (
        <form onSubmit={save} className="space-y-2" aria-busy={busy !== null}>
          <div className="flex flex-wrap gap-2">
            <input
              className="input min-w-0 flex-1 font-mono"
              type="password"
              autoComplete="off"
              spellCheck={false}
              aria-label="Clé API Claude"
              placeholder="sk-ant-api03-…"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              maxLength={300}
              required
            />
            <button type="submit" className="btn btn-primary" disabled={busy !== null || !key.trim()}>
              {busy === "save" ? "Vérification…" : "Enregistrer"}
            </button>
            {editing && (
              <button type="button" className="btn btn-ghost" onClick={() => setEditing(false)} disabled={busy !== null}>
                Annuler
              </button>
            )}
          </div>
          <p className="text-[12px] text-trace">
            Une clé API de la Console Anthropic (console.anthropic.com, rubrique API Keys). Elle est essayée avant d&apos;être enregistrée, conservée chiffrée,
            et n&apos;est plus jamais affichée.
          </p>
        </form>
      )}
      {err && <ErrorText>{err}</ErrorText>}
      {ok && (
        <p role="status" className="inline-flex items-center gap-1.5 text-[13px]">
          <CheckIcon size={14} /> {ok}
        </p>
      )}
    </div>
  )
}
