"use client"

import { useEffect, useState } from "react"
import type { ClaudeKeyInfo } from "@/lib/claude-key"
import type { NewZonesRun } from "@/lib/new-zones"
import { api, errorMessage } from "./format"
import { RelTime } from "./RelTime"
import { CheckIcon, ErrorText } from "./ui"

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
 * Zones automatiques : la clé API Claude de l'entreprise (c'est elle qui paie les appels du serveur) et le passage
 * quotidien qui crée les zones qui manquent. `onZonesChanged` relit la liste des zones après un passage.
 */
export function AutoZones({ onZonesChanged }: { onZonesChanged: () => void }) {
  const [info, setInfo] = useState<ClaudeKeyInfo | null>(null)
  const [runs, setRuns] = useState<NewZonesRun[]>([])
  const [key, setKey] = useState("")
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState<"save" | "remove" | "run" | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [ok, setOk] = useState<string | null>(null)

  useEffect(() => {
    Promise.all([api<ClaudeKeyInfo>("/api/admin/claude"), api<{ runs: NewZonesRun[] }>("/api/admin/zones/auto")])
      .then(([i, r]) => {
        setInfo(i)
        setRuns(r.runs)
      })
      .catch((e) => setErr(errorMessage(e)))
  }, [])

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setBusy("save")
    setErr(null)
    setOk(null)
    try {
      setInfo(await api<ClaudeKeyInfo>("/api/admin/claude", { method: "PUT", json: { key: key.trim() } }))
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
    if (!confirm("Retirer la clé Claude de l'entreprise ? Plus aucune zone ne sera créée automatiquement.")) return
    setBusy("remove")
    setErr(null)
    setOk(null)
    try {
      setInfo(await api<ClaudeKeyInfo>("/api/admin/claude", { method: "DELETE" }))
    } catch (e) {
      setErr(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  async function runNow() {
    setBusy("run")
    setErr(null)
    setOk(null)
    try {
      const run = await api<NewZonesRun>("/api/admin/zones/auto", { method: "POST" })
      setRuns((prev) => [run, ...prev])
      if (run.status === "created") onZonesChanged()
    } catch (e) {
      setErr(`Passage impossible : ${errorMessage(e)}`)
    } finally {
      setBusy(null)
    }
  }

  const hasClaude = Boolean(info?.source)
  const showForm = info !== null && (info.source !== "org" || editing)

  return (
    <section className="panel space-y-3 p-4 sm:p-5" aria-busy={busy !== null}>
      <h2 className="panel-title">Zones automatiques</h2>
      <p className="text-[13px] text-trace">
        Chaque jour à 10 h, Claude relit les connaissances des 30 derniers jours et crée la zone d&apos;un domaine qui revient sans avoir la sienne. Ses
        connaissances y sont rangées, et ceux qui les lisaient la lisent aussi.
      </p>

      <div className="space-y-2">
        <p className="text-[13px]">
          {info === null
            ? "Clé Claude : chargement…"
            : info.source === "org"
              ? (
                  <>
                    Clé Claude de l&apos;entreprise : <span className="font-mono">sk-ant-…{info.last4}</span>
                    {info.updated_at && (
                      <span className="text-trace">
                        {" "}
                        · enregistrée <RelTime iso={info.updated_at} />
                      </span>
                    )}
                  </>
                )
              : info.source === "server"
                ? "Clé Claude : celle du serveur. Ajoutez la vôtre pour que les appels soient facturés à votre entreprise."
                : "Aucune clé Claude : aucune zone n'est créée automatiquement."}
        </p>
        {info?.source === "org" && !editing && (
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
          <form onSubmit={save} className="space-y-2">
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
              Une clé API de la Console Anthropic (console.anthropic.com, rubrique API Keys). Elle est essayée avant d&apos;être enregistrée, conservée
              chiffrée, et n&apos;est plus jamais affichée.
            </p>
          </form>
        )}
      </div>

      {err && <ErrorText>{err}</ErrorText>}
      {ok && (
        <p role="status" className="inline-flex items-center gap-1.5 text-[13px]">
          <CheckIcon size={14} /> {ok}
        </p>
      )}

      <div className="space-y-2 border-t border-line pt-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-[13px] font-medium">Derniers passages</h3>
          <button type="button" className="btn btn-sm" onClick={runNow} disabled={busy !== null || !hasClaude} title={hasClaude ? undefined : "Ajoutez d'abord une clé Claude."}>
            {busy === "run" ? "Claude relit le cerveau…" : "Lancer maintenant"}
          </button>
        </div>
        {runs.length === 0 ? (
          <p className="text-[13px] text-trace">Aucun passage pour l&apos;instant.</p>
        ) : (
          <ul className="space-y-1.5">
            {runs.slice(0, 6).map((r) => (
              <li key={r.at} className="flex gap-3 text-[13px]">
                <RelTime iso={r.at} className="w-28 shrink-0 text-trace" />
                <span className="min-w-0">{outcome(r)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}
