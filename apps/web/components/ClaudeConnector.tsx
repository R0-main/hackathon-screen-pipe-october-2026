"use client"

import { useEffect, useRef, useState } from "react"
import { api, errorMessage } from "./format"
import { CloseIcon, ErrorText } from "./ui"

type Connector = { name: string; connector_name: string; url: string }

/**
 * "Connect to Claude": the address of the company's MCP server to add in Claude (Settings → Connectors), where
 * show_brain, show_automations and show_team open their view. One's own, or a member's for an admin, shown again at will.
 */
export function ClaudeConnectButton({ userId, isSelf, className = "btn btn-sm" }: { userId: string; isSelf: boolean; className?: string }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)}>
        Connect to Claude
      </button>
      {open && <ConnectorModal userId={userId} isSelf={isSelf} onClose={() => setOpen(false)} />}
    </>
  )
}

function ConnectorModal({ userId, isSelf, onClose }: { userId: string; isSelf: boolean; onClose: () => void }) {
  const [data, setData] = useState<Connector | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [shown, setShown] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    api<Connector>(`/api/connector?user=${encodeURIComponent(userId)}`)
      .then(setData)
      .catch((e) => setErr(`Could not get the address: ${errorMessage(e)}`))
  }, [userId])

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    closeRef.current?.focus()
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose()
    window.addEventListener("keydown", onKey)
    return () => {
      window.removeEventListener("keydown", onKey)
      previous?.focus?.()
    }
  }, [onClose])

  async function copy(what: string, text: string) {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(what)
      setTimeout(() => setCopied(null), 2000)
    } catch {
      setShown(true)
      setErr("Automatic copy is not possible here: select the address and copy it with Ctrl+C (⌘C on a Mac).")
    }
  }

  const first = data?.name.split(" ")[0]
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-ink/20 p-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-labelledby="connector-title" className="panel w-full max-w-xl p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3">
          <h2 id="connector-title" className="panel-title">
            {isSelf || !data ? "Connect the brain to Claude" : `Connect ${first}'s brain to Claude`}
          </h2>
          <button ref={closeRef} type="button" className="btn btn-icon shrink-0" onClick={onClose} aria-label="Close">
            <CloseIcon />
          </button>
        </div>
        <p className="mt-1.5 text-[13px] leading-relaxed text-trace">
          In Claude (web or desktop app), the brain's tools open their view in the conversation: the live brain, the automations, the
          team. Claude Code already has them through the install.
        </p>

        {err && <ErrorText className="mt-3">{err}</ErrorText>}
        {!data && !err && <p className="mt-4 text-[13px] text-trace">Preparing the address…</p>}
        {data && (
          <>
            <ol className="mt-4 list-decimal space-y-1.5 pl-5 text-[13px] leading-relaxed">
              <li>In Claude, open Settings, then Connectors, then Add custom connector.</li>
              <li>
                Name it <span className="font-medium">{data.connector_name}</span> and paste the address below. No sign-in is needed.
              </li>
              <li>In a new conversation, turn the connector on, then ask: “Show me the brain”.</li>
            </ol>
            <div className="mt-4">
              <span className="mb-1.5 block text-[13px] font-medium">Server address</span>
              <div className="flex gap-1.5">
                <input
                  className="input mono min-w-0 flex-1 text-[12px]"
                  readOnly
                  value={shown ? data.url : data.url.replace(/[^/]+$/, "•".repeat(24))}
                  onFocus={(e) => shown && e.currentTarget.select()}
                  aria-label="Server address"
                />
                <button type="button" className="btn btn-sm shrink-0" onClick={() => setShown((s) => !s)}>
                  {shown ? "Hide" : "Show"}
                </button>
                <button type="button" className="btn btn-primary btn-sm shrink-0" onClick={() => copy("url", data.url)}>
                  {copied === "url" ? "Copied" : "Copy"}
                </button>
              </div>
            </div>
            <p className="mt-3 text-[12px] leading-relaxed text-trace">
              {isSelf ? "This address reads and writes the brain as you, with your zones" : `This address reads and writes the brain as ${first}, with their zones`}
              : keep it private. It stays the same until the token is regenerated, which revokes it.
            </p>
          </>
        )}
      </div>
    </div>
  )
}
