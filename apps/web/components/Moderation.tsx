"use client"

import { useEffect, useState } from "react"
import { MODERATION_REASON_LABELS } from "@brain/core"
import type { ModerationLogEntry, ModerationRun } from "@/lib/moderation"
import { api, errorMessage } from "./format"
import { RelTime } from "./RelTime"
import { ErrorText } from "./ui"

type State = { enabled: boolean; claude: "org" | "server" | null; runs: ModerationRun[]; log: ModerationLogEntry[]; }

const KINDS: Record<string, string> = { fact: "fact", decision: "decision", task: "task", procedure: "procedure", question: "question" }

const STATUS: Record<string, string> = {
  nothing: "nothing new",
  off: "moderator off",
  no_claude: "no Claude key on the server",
  claude_error: "Claude did not answer, reviewed at the next run",
}

function runLine(r: ModerationRun): string {
  if (r.status !== "done") return STATUS[r.status] ?? r.status
  return `${r.reviewed} reviewed, ${r.edited} edited, ${r.rejected} removed${r.remaining ? `, ${r.remaining} waiting` : ""}`
}

function decisionLine(e: ModerationLogEntry): string {
  const what = `${KINDS[e.kind] ?? e.kind} by ${e.author} (${e.zone})`
  if (e.decision === "edit") return `Edited: ${what}`
  return `Removed: ${what}, ${MODERATION_REASON_LABELS[e.category ?? "other"]}${e.reason ? ` — ${e.reason}` : ""}`
}

/** The brain's moderator: where it runs (an admin's computer), on/off switch, latest runs and decisions. */
export function Moderation() {
  const [state, setState] = useState<State | null>(null)
  const [busy, setBusy] = useState<"toggle" | "run" | null>(null)
  const [err, setErr] = useState<string | null>(null)

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
      setErr(`Could not run: ${errorMessage(e)}`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="panel space-y-4 p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h2 className="panel-title">Moderator</h2>
          <p className="text-[13px] text-trace">
            Every 15 min, Claude rereads what arrived in the brain: it keeps, edits (title, zone, type) or removes (personal content, secret,
            duplicate, too vague, suspicious instruction, judgment about a person), then redoes the &quot;where the company stands&quot; summary. Removed text is
            kept nowhere.
          </p>
        </div>
        {state && (
          <button type="button" className={`chip ${state.enabled ? "chip-on" : ""}`} aria-pressed={state.enabled} onClick={toggle} disabled={busy !== null}>
            {state.enabled ? "On" : "Off"}
          </button>
        )}
      </div>

      <p className="text-[13px]">
        It runs on an admin&apos;s computer, with their Claude Code (Sonnet, their subscription): at each sync (every 15 min), their computer rereads
        what arrived, then redoes the summary. The Claude token, asked for when the computer was installed, never leaves that computer. If it is missing:{" "}
        <code className="mono">~/.company-brain/brain connect-claude</code> in a terminal.
      </p>

      {err && <ErrorText>{err}</ErrorText>}

      <div className="space-y-2 border-t border-line pt-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-[13px] font-medium">Latest runs</h3>
          {state?.claude && (
            <button type="button" className="btn btn-sm" onClick={runNow} disabled={busy !== null || !state.enabled}>
              {busy === "run" ? "Claude is reviewing…" : "Run now (API key)"}
            </button>
          )}
        </div>
        {!state && !err ? (
          <p className="text-[13px] text-trace">Loading…</p>
        ) : !state || state.runs.length === 0 ? (
          <p className="text-[13px] text-trace">No run yet.</p>
        ) : (
          <ul className="space-y-1.5">
            {state.runs.slice(0, 6).map((r) => (
              <li key={r.at} className="flex gap-3 text-[13px]">
                <RelTime iso={r.at} className="w-28 shrink-0 text-trace" />
                <span className="min-w-0">
                  {runLine(r)}
                  <span className="text-trace">{r.via === "claude-code" ? " · Claude Code" : " · server"}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {state && state.log.length > 0 && (
        <div className="space-y-2 border-t border-line pt-3">
          <h3 className="text-[13px] font-medium">Latest decisions</h3>
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
