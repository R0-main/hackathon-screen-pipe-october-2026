"use client"

// The company's Claude key: set in Settings (Claude tab), summarized where a feature needs it (automatic zones).

import Link from "next/link"
import { useState } from "react"
import type { ClaudeKeyInfo } from "@/lib/claude-key"
import { api, errorMessage } from "./format"
import { RelTime } from "./RelTime"
import { CheckIcon, ErrorText } from "./ui"

/** The company's Claude key (Settings → Claude): tried against Anthropic, kept encrypted, never shown again. */
export function ClaudeKeySetup({ info, onInfo, readOnly = false }: { info: ClaudeKeyInfo; onInfo: (i: ClaudeKeyInfo) => void; readOnly?: boolean }) {
  const [key, setKey] = useState("")
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState<"save" | "remove" | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [ok, setOk] = useState<string | null>(null)
  const showForm = !readOnly && (info.source !== "org" || editing)

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setBusy("save")
    setErr(null)
    setOk(null)
    try {
      onInfo(await api<ClaudeKeyInfo>("/api/admin/claude", { method: "PUT", json: { key: key.trim() } }))
      setKey("")
      setEditing(false)
      setOk("Key checked with Anthropic and saved.")
    } catch (e) {
      setErr(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  async function remove() {
    if (!confirm("Remove the company's Claude key? Summaries become simplified, and the server no longer writes keywords or creates zones with it.")) return
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
            The company&apos;s Claude key: <span className="font-mono">sk-ant-…{info.last4}</span>
            {info.updated_at && (
              <span className="text-trace">
                {" "}
                · saved <RelTime iso={info.updated_at} />
              </span>
            )}
          </>
        ) : info.source === "server" ? (
          "Claude key: the deployment's. Add the company's own so that its calls are billed to it."
        ) : (
          "No Claude key for the company yet."
        )}
      </p>
      {!readOnly && info.source === "org" && !editing && (
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn btn-sm" onClick={() => setEditing(true)} disabled={busy !== null}>
            Replace the key
          </button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={remove} disabled={busy !== null}>
            {busy === "remove" ? "Removing…" : "Remove"}
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
              aria-label="Claude API key"
              placeholder="sk-ant-api03-…"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              maxLength={300}
              required
            />
            <button type="submit" className="btn btn-primary" disabled={busy !== null || !key.trim()}>
              {busy === "save" ? "Checking…" : "Save"}
            </button>
            {editing && (
              <button type="button" className="btn btn-ghost" onClick={() => setEditing(false)} disabled={busy !== null}>
                Cancel
              </button>
            )}
          </div>
          <p className="text-[12px] text-trace">
            An API key from the Anthropic Console (console.anthropic.com, API Keys section). It is tried before being saved, kept encrypted,
            and never shown again.
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

/** Where a feature uses the key: which one, and the link to Settings where it is managed. */
export function ClaudeKeySummary({ info }: { info: ClaudeKeyInfo }) {
  return (
    <p className="text-[13px]">
      {info.source === "org" ? (
        <>
          The server uses the company&apos;s Claude key <span className="font-mono">sk-ant-…{info.last4}</span>.{" "}
        </>
      ) : info.source === "server" ? (
        "The server uses the deployment's Claude key. "
      ) : (
        "The server needs the company's Claude key: none is saved yet. "
      )}
      <Link href="/settings?tab=claude" className="underline underline-offset-2 hover:text-ink">
        Manage it in Settings →
      </Link>
    </p>
  )
}
