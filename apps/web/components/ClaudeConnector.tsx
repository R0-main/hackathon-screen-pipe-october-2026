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

  /** Copies the address, then opens Claude's connectors page (Claude cannot be prefilled from a link). */
  async function copyAndOpen(url: string) {
    await copy("open", url)
    if (!window.open(CLAUDE_CONNECTORS_URL, "_blank", "noopener")) window.location.href = CLAUDE_CONNECTORS_URL
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-ink/20 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="connector-title"
        className="panel scroll-thin max-h-[calc(100dvh-2rem)] w-full max-w-2xl overflow-y-auto p-5"
        onClick={(e) => e.stopPropagation()}
      >
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
          team. A connector added on claude.ai also shows up in the desktop app. Claude Code already has them through the install.
        </p>

        {err && <ErrorText className="mt-3">{err}</ErrorText>}
        {!data && !err && <p className="mt-4 text-[13px] text-trace">Preparing the address…</p>}
        {data && (
          <>
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
                <button type="button" className="btn btn-sm shrink-0" onClick={() => copy("url", data.url)}>
                  {copied === "url" ? "Copied" : "Copy"}
                </button>
              </div>
              <p className="mt-2 text-[12px] leading-relaxed text-trace">
                {isSelf ? "It reads and writes the brain as you, with your zones" : `It reads and writes the brain as ${first}, with their zones`}: keep
                it private. It stays the same until the token is regenerated, which revokes it.
              </p>
            </div>

            <ol className="mt-5 space-y-3">
              <Step n={1} title="Copy the address and open Claude's connectors">
                <button type="button" className="btn btn-primary btn-sm" onClick={() => void copyAndOpen(data.url)}>
                  {copied === "open" ? "Copied, opening Claude…" : "Copy and open Claude"}
                </button>
                <p className="mt-1.5 text-[12px] text-trace">
                  Or go to{" "}
                  <a className="underline underline-offset-2" href={CLAUDE_CONNECTORS_URL} target="_blank" rel="noopener noreferrer">
                    claude.ai/customize/connectors
                  </a>
                  ; in the desktop app, Customize then Connectors.
                </p>
              </Step>
              <Step n={2} title="Click “Add custom connector”" picture={<PictureConnectors />} />
              <Step
                n={3}
                title="Name it, paste the address, click “Add”"
                picture={<PictureAddDialog name={data.connector_name} />}
              >
                <p className="text-[12px] text-trace">
                  Name: <span className="font-medium text-ink">{data.connector_name}</span>. No sign-in or OAuth: leave the rest as is.
                </p>
              </Step>
              <Step n={4} title="In a new chat, turn it on and ask for the brain" picture={<PictureChat name={data.connector_name} />}>
                <p className="text-[12px] text-trace">“+” button, then Connectors, then turn on {data.connector_name}. Then ask: “Show me the brain”.</p>
              </Step>
            </ol>
            <p className="mt-4 text-[12px] leading-relaxed text-trace">
              Illustrations simplified from Claude's screens, which may vary a little. On the Free plan, Claude allows one custom connector; on
              a Team or Enterprise plan, only an Owner can add one.
            </p>
          </>
        )}
      </div>
    </div>
  )
}

const CLAUDE_CONNECTORS_URL = "https://claude.ai/customize/connectors"

function Step({ n, title, picture, children }: { n: number; title: string; picture?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <li className="inset grid gap-3 p-3 sm:grid-cols-[minmax(0,1fr)_240px] sm:items-center">
      <div className="min-w-0">
        <p className="flex items-baseline gap-2 text-[13px] font-medium">
          <span className="mono text-trace">{n}</span>
          {title}
        </p>
        {children && <div className="mt-2 pl-[18px]">{children}</div>}
      </div>
      {picture && (
        <div className="overflow-hidden rounded-[6px] border border-line bg-surface" aria-hidden>
          {picture}
        </div>
      )}
    </li>
  )
}

/** What to click is ringed in phosphor; the rest of Claude's screen is sketched in gray. */
const HIT = "ring-2 ring-phosphor ring-offset-1"
const Bar = ({ w }: { w: string }) => <span className={`block h-1.5 rounded-full bg-line ${w}`} />

function PictureConnectors() {
  return (
    <div className="flex h-[118px] text-[10px]">
      <div className="w-[66px] space-y-1.5 border-r border-line bg-bone p-2">
        <Bar w="w-9" />
        <Bar w="w-7" />
        <span className="block rounded-[3px] bg-surface px-1 py-0.5 font-medium">Customize</span>
        <Bar w="w-8" />
      </div>
      <div className="min-w-0 flex-1 p-2.5">
        <span className="block font-medium">Connectors</span>
        <span className={`mt-1.5 inline-block whitespace-nowrap rounded-[4px] border border-ink bg-surface px-1.5 py-0.5 font-medium ${HIT}`}>Add custom connector</span>
        <div className="mt-2.5 space-y-2">
          {["w-16", "w-12"].map((w) => (
            <div key={w} className="flex items-center gap-1.5">
              <span className="size-3 rounded-[3px] bg-line" />
              <Bar w={w} />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function PictureAddDialog({ name }: { name: string }) {
  return (
    <div className="h-[118px] bg-bone p-2.5 text-[10px]">
      <div className="rounded-[5px] border border-line bg-surface p-2">
        <span className="font-medium">Add custom connector</span>
        <span className="mt-1.5 block truncate rounded-[3px] border border-line px-1.5 py-0.5">{name}</span>
        <span className={`mt-1 block truncate rounded-[3px] border border-ink px-1.5 py-0.5 mono ${HIT}`}>https://…/api/mcp/…</span>
        <div className="mt-1.5 flex justify-end gap-1">
          <span className="rounded-[3px] border border-line px-1.5 py-0.5 text-trace">Cancel</span>
          <span className={`rounded-[3px] bg-ink px-2 py-0.5 font-medium text-surface ${HIT}`}>Add</span>
        </div>
      </div>
    </div>
  )
}

function PictureChat({ name }: { name: string }) {
  return (
    <div className="relative h-[118px] bg-surface p-2.5 text-[10px]">
      <div className="absolute bottom-[38px] left-2.5 w-[170px] rounded-[5px] border border-line bg-surface p-1.5 shadow-sm">
        <span className="block px-1 py-0.5 text-trace">Connectors</span>
        <span className="flex items-center justify-between gap-2 rounded-[3px] px-1 py-0.5">
          <span className="truncate font-medium">{name}</span>
          <span className={`relative h-2.5 w-[18px] shrink-0 rounded-full bg-ink ${HIT}`}>
            <span className="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-surface" />
          </span>
        </span>
      </div>
      <div className="absolute inset-x-2.5 bottom-2.5 flex items-center gap-1.5 rounded-[6px] border border-line px-1.5 py-1">
        <span className={`grid size-4 place-items-center rounded-full border border-ink font-medium leading-none ${HIT}`}>+</span>
        <span className="truncate">Show me the brain</span>
      </div>
    </div>
  )
}
