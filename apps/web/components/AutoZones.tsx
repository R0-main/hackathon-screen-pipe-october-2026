"use client"

import { useEffect, useRef, useState } from "react"
import type { ClaudeKeyInfo } from "@/lib/claude-key"
import type { NewZonesRun } from "@/lib/new-zones"
import { api, errorMessage } from "./format"
import { ClaudeKeySummary } from "./ClaudeKey"
import { RelTime } from "./RelTime"
import { CheckIcon, ErrorText } from "./ui"

type Mode = "subscription" | "api"

const SKIPPED: Record<string, string> = {
  no_claude: "no Claude key",
  too_few_items: "not enough recent knowledge",
  max_zones: "12 zones, the cap is reached",
  claude_error: "Claude did not answer, retrying tomorrow",
}

function outcome(r: NewZonesRun): string {
  if (r.status === "created") return `Created: ${r.zones.map((z) => `${z.name} (${z.items} item${z.items === 1 ? "" : "s"})`).join(", ")}`
  if (r.status === "unchanged") return "Nothing to create"
  return `Nothing done: ${SKIPPED[r.reason] ?? r.reason}`
}

/**
 * The company's GitHub Actions workflow: its Claude Code, with its subscription token (`claude setup-token`), does
 * the analysis every day at 10am (Paris time) in ITS CI; the brain only receives the proposals.
 */
export function ciWorkflow(baseUrl: string): string {
  return `name: Brain — new zones
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
      - name: 10am in Paris (GitHub only counts in UTC)
        id: hour
        run: |
          if [ "$GITHUB_EVENT_NAME" = "workflow_dispatch" ] || [ "$(TZ=Europe/Paris date +%H)" = "10" ]; then echo "go=1" >> "$GITHUB_OUTPUT"; fi
      - if: steps.hour.outputs.go == '1'
        uses: actions/setup-node@v4
        with:
          node-version: 22
      - if: steps.hour.outputs.go == '1'
        name: Claude Code and the brain client
        run: |
          npm install -g @anthropic-ai/claude-code
          curl -fsSL ${baseUrl}/brain.mjs -o "$RUNNER_TEMP/brain.mjs"
      - if: steps.hour.outputs.go == '1'
        name: New zones
        env:
          BRAIN_TOKEN: \${{ secrets.BRAIN_TOKEN }}
          CLAUDE_CODE_OAUTH_TOKEN: \${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
        run: |
          node "$RUNNER_TEMP/brain.mjs" init --home "$RUNNER_TEMP/brain" --url ${baseUrl} --token "$BRAIN_TOKEN"
          node "$RUNNER_TEMP/brain.mjs" refresh-zones --home "$RUNNER_TEMP/brain"
`
}

/**
 * Automatic zones: who does the daily analysis (the company's Claude Code with its subscription, in CI, or
 * the server with the company's API key), and the run history. `onZonesChanged` re-reads the zone list.
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
        // A key already saved: show that mode; otherwise the Claude Code subscription, without an API key.
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
      setErr(`Could not run: ${errorMessage(e)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="panel space-y-4 p-4 sm:p-5">
      <div className="space-y-1">
        <h2 className="panel-title">Automatic zones</h2>
        <p className="text-[13px] text-trace">
          Every day at 10am, Claude re-reads the knowledge from the last 30 days and creates a zone for an area that keeps coming up without one of its own. Its
          knowledge is filed there, and whoever read it can read the new zone too.
        </p>
      </div>

      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Who does the analysis">
        <button type="button" className={`chip ${mode === "subscription" ? "chip-on" : ""}`} aria-pressed={mode === "subscription"} onClick={() => setMode("subscription")}>
          Claude subscription (Claude Code)
        </button>
        <button type="button" className={`chip ${mode === "api" ? "chip-on" : ""}`} aria-pressed={mode === "api"} onClick={() => setMode("api")}>
          Claude API key
        </button>
      </div>

      {mode === "subscription" && <SubscriptionSetup baseUrl={baseUrl} />}
      {mode === "api" && info && <ClaudeKeySummary info={info} />}

      {err && <ErrorText>{err}</ErrorText>}

      <div className="space-y-2 border-t border-line pt-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-[13px] font-medium">Latest runs</h3>
          {mode === "api" && (
            <button type="button" className="btn btn-sm" onClick={runNow} disabled={busy || !info?.source} title={info?.source ? undefined : "Add a Claude key first."}>
              {busy ? "Claude is re-reading the brain…" : "Run now"}
            </button>
          )}
        </div>
        {mode === null && !err ? (
          <p className="text-[13px] text-trace">Loading…</p>
        ) : runs.length === 0 ? (
          <p className="text-[13px] text-trace">No run yet.</p>
        ) : (
          <ul className="space-y-1.5">
            {runs.slice(0, 6).map((r) => (
              <li key={r.at} className="flex gap-3 text-[13px]">
                <RelTime iso={r.at} className="w-28 shrink-0 text-trace" />
                <span className="min-w-0">
                  {outcome(r)}
                  <span className="text-trace">{r.via === "claude-code" ? " · Claude Code" : " · server"}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}

/** Subscription mode: the steps for the company's CI, and the workflow to copy. */
function SubscriptionSetup({ baseUrl }: { baseUrl: string }) {
  const [copied, setCopied] = useState(false)
  const [copyErr, setCopyErr] = useState<string | null>(null)
  const preRef = useRef<HTMLPreElement>(null)
  const yaml = baseUrl ? ciWorkflow(baseUrl) : ""

  async function copy() {
    setCopyErr(null)
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable")
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
      setCopyErr("Automatic copy is not possible here: the file is selected, copy it with Ctrl+C (⌘C on a Mac).")
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-[13px]">
        The analysis runs in your own GitHub CI, with the company&apos;s Claude Code and your subscription: no API key, no computer left on, and the
        Claude token never leaves your CI. The brain only receives the proposed zones.
      </p>
      <ol className="list-decimal space-y-1.5 pl-5 text-[13px]">
        <li>
          On your computer, run <code className="mono">claude setup-token</code> and copy the token shown (valid for a year).
        </li>
        <li>
          In one of the company&apos;s GitHub repos, <span className="text-trace">Settings → Secrets and variables → Actions</span>, create two secrets:{" "}
          <code className="mono">CLAUDE_CODE_OAUTH_TOKEN</code> (that token) and <code className="mono">BRAIN_TOKEN</code> (your brain token, the{" "}
          <code className="mono">token</code> field of <code className="mono">~/.company-brain/config.json</code>).
        </li>
        <li>
          Add this file as <code className="mono">.github/workflows/brain-zones.yml</code>. For a first try:{" "}
          <span className="text-trace">Actions → Brain — new zones → Run workflow</span>.
        </li>
      </ol>
      <pre ref={preRef} className="scroll-thin mono inset max-h-[320px] overflow-auto p-3 text-[12px] leading-relaxed">
        {yaml || "Loading…"}
      </pre>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn btn-sm" onClick={copy} disabled={!yaml}>
          {copied ? (
            <>
              <CheckIcon size={14} /> Copied
            </>
          ) : (
            "Copy the workflow"
          )}
        </button>
        <span className="text-[12px] text-trace">
          Or by hand on your computer: <code className="mono">~/.company-brain/brain refresh-zones</code>
        </span>
      </div>
      {copyErr && <ErrorText className="text-[12px]">{copyErr}</ErrorText>}
    </div>
  )
}
