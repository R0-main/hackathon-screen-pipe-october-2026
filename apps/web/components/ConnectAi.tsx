"use client"

import { useEffect, useRef, useState, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { api, errorMessage } from "./format"
import { CloseIcon, ErrorText } from "./ui"

type Connector = { name: string; connector_name: string; server_name: string; url: string }

type AppId = "claude" | "chatgpt" | "cursor" | "vscode" | "claude-code" | "codex"

/** The AI apps the brain plugs into. `views`: they render the MCP Apps (show_brain…) in the conversation. */
const APPS: { id: AppId; label: string; views: boolean }[] = [
  { id: "claude", label: "Claude", views: true },
  { id: "chatgpt", label: "ChatGPT", views: true },
  { id: "cursor", label: "Cursor", views: false },
  { id: "vscode", label: "VS Code", views: true },
  { id: "claude-code", label: "Claude Code", views: false },
  { id: "codex", label: "Codex", views: false },
]

const CLAUDE_CONNECTORS_URL = "https://claude.ai/customize/connectors"
const CHATGPT_SETTINGS_URL = "https://chatgpt.com/#settings/Connectors"

/**
 * "Connect an AI": the address of the company's MCP server, ready for Claude, ChatGPT, Cursor, VS Code, Claude Code
 * or Codex, where the brain's tools (and, in the apps that render them, its views) are then available. One's own, or
 * a member's for an admin, shown again at will.
 */
export function ConnectAiButton({ userId, isSelf, className = "btn btn-sm" }: { userId: string; isSelf: boolean; className?: string }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)}>
        Connect an AI
      </button>
      {/* On the page itself: an ancestor that scrolls (the org chart's panel) or is transformed would hold it and its scroll. */}
      {open && createPortal(<ConnectorModal userId={userId} isSelf={isSelf} onClose={() => setOpen(false)} />, document.body)}
    </>
  )
}

function ConnectorModal({ userId, isSelf, onClose }: { userId: string; isSelf: boolean; onClose: () => void }) {
  const [data, setData] = useState<Connector | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [shown, setShown] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  const [app, setApp] = useState<AppId>("claude")
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

  async function copy(what: string, text: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(what)
      setTimeout(() => setCopied(null), 2000)
      return true
    } catch {
      setShown(true)
      setErr("Automatic copy is not possible here: select the text and copy it with Ctrl+C (⌘C on a Mac).")
      return false
    }
  }

  /** Copies the address, then opens the app's page (none can be prefilled from a link). */
  async function copyAndOpen(what: string, url: string, target: string) {
    await copy(what, url)
    if (!window.open(target, "_blank", "noopener")) window.location.href = target
  }

  const first = data?.name.split(" ")[0]
  // The key is the end of the address: masked everywhere until "Show".
  const mask = (s: string) => (shown || !data ? s : s.split(data.url).join(data.url.replace(/[^/]+$/, "•".repeat(24))))
  const current = APPS.find((a) => a.id === app)!

  return (
    <div className="fixed inset-0 z-50 grid items-start justify-items-center overscroll-contain bg-ink/20 p-4 sm:pt-[6vh]" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="connector-title"
        className="panel scroll-thin max-h-[calc(100dvh-2rem)] w-full max-w-2xl sm:max-h-[calc(100dvh-6vh-1rem)] overflow-y-auto overscroll-contain p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <h2 id="connector-title" className="panel-title">
            {isSelf || !data ? "Connect the brain to an AI" : `Connect ${first}'s brain to an AI`}
          </h2>
          <button ref={closeRef} type="button" className="btn btn-icon shrink-0" onClick={onClose} aria-label="Close">
            <CloseIcon />
          </button>
        </div>
        <p className="mt-1.5 text-[13px] leading-relaxed text-trace">
          The brain's tools (search, zones, company status, remember…) work in each of these apps. In those marked “views”, the live brain,
          the automations and the team also open right in the conversation.
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
                  value={mask(data.url)}
                  onFocus={(e) => shown && e.currentTarget.select()}
                  aria-label="Server address"
                />
                <button type="button" className="btn btn-sm shrink-0" onClick={() => setShown((s) => !s)}>
                  {shown ? "Hide" : "Show"}
                </button>
                <button type="button" className="btn btn-sm shrink-0" onClick={() => void copy("url", data.url)}>
                  {copied === "url" ? "Copied" : "Copy"}
                </button>
              </div>
              <p className="mt-2 text-[12px] leading-relaxed text-trace">
                {isSelf ? "It reads and writes the brain as you, with your zones" : `It reads and writes the brain as ${first}, with their zones`}: keep
                it private. It stays the same until the token is regenerated, which revokes it.
              </p>
            </div>

            <div className="mt-5 flex flex-wrap gap-1.5" role="tablist" aria-label="AI app">
              {APPS.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  role="tab"
                  aria-selected={a.id === app}
                  className={`chip ${a.id === app ? "chip-on" : ""}`}
                  onClick={() => setApp(a.id)}
                >
                  {a.label}
                  {a.views && <span className={a.id === app ? "opacity-70" : "text-trace"}>· views</span>}
                </button>
              ))}
            </div>

            <div className="mt-3" role="tabpanel" aria-label={current.label}>
              {app === "claude" && (
                <ol className="space-y-3">
                  <Step n={1} title="Copy the address and open Claude's connectors">
                    <button type="button" className="btn btn-primary btn-sm" onClick={() => void copyAndOpen("open", data.url, CLAUDE_CONNECTORS_URL)}>
                      {copied === "open" ? "Copied, opening Claude…" : "Copy and open Claude"}
                    </button>
                    <p className="mt-1.5 text-[12px] text-trace">
                      Or <ExternalLink href={CLAUDE_CONNECTORS_URL}>claude.ai/customize/connectors</ExternalLink>; in the desktop app, Customize then
                      Connectors. A connector added on claude.ai also shows up in the desktop app.
                    </p>
                  </Step>
                  <Step n={2} title="Click “Add custom connector”" picture={<PictureConnectors />} />
                  <Step n={3} title="Name it, paste the address, click “Add”" picture={<PictureAddDialog name={data.connector_name} />}>
                    <p className="text-[12px] text-trace">
                      Name: <span className="font-medium text-ink">{data.connector_name}</span>. No sign-in or OAuth: leave the rest as is.
                    </p>
                  </Step>
                  <Step n={4} title="In a new chat, turn it on and ask for the brain" picture={<PictureChat name={data.connector_name} />}>
                    <p className="text-[12px] text-trace">“+” button, then Connectors, then turn on {data.connector_name}. Then ask: “Show me the brain”.</p>
                  </Step>
                  <Note>
                    Illustrations simplified from Claude's screens, which may vary a little. On the Free plan, Claude allows one custom connector; on
                    a Team or Enterprise plan, only an Owner can add one.
                  </Note>
                </ol>
              )}

              {app === "chatgpt" && (
                <ol className="space-y-3">
                  <Step n={1} title="Copy the address and open ChatGPT's settings">
                    <button type="button" className="btn btn-primary btn-sm" onClick={() => void copyAndOpen("open", data.url, CHATGPT_SETTINGS_URL)}>
                      {copied === "open" ? "Copied, opening ChatGPT…" : "Copy and open ChatGPT"}
                    </button>
                  </Step>
                  <Step n={2} title="Turn on Developer mode">
                    <p className="text-[12px] text-trace">
                      Settings, then Apps & Connectors (or Security), then Advanced settings: Developer mode. ChatGPT moves this toggle from time to
                      time; on a Business or Enterprise workspace, an admin may have to allow custom apps first.
                    </p>
                  </Step>
                  <Step n={3} title="Create the app: name, address, “No authentication”">
                    <p className="text-[12px] text-trace">
                      Create (or “+”), name it <span className="font-medium text-ink">{data.connector_name}</span>, paste the address as the MCP server
                      URL, choose No authentication, confirm that you trust it, then Create.
                    </p>
                  </Step>
                  <Step n={4} title="In a new chat, add it and ask for the brain">
                    <p className="text-[12px] text-trace">“+” button, then the app ({data.connector_name}). Then ask: “Show me the brain”.</p>
                  </Step>
                  <Note>Developer mode depends on the ChatGPT plan (paid plans).</Note>
                </ol>
              )}

              {app === "cursor" && (
                <ol className="space-y-3">
                  <Step n={1} title="Add it to Cursor in one click">
                    <a className="btn btn-primary btn-sm" href={cursorInstallLink(data)}>
                      Add to Cursor
                    </a>
                    <p className="mt-1.5 text-[12px] text-trace">Cursor opens and asks to confirm the install.</p>
                  </Step>
                  <Step n={2} title="Or by hand, in ~/.cursor/mcp.json">
                    <Code id="cursor" text={JSON.stringify({ mcpServers: { [data.server_name]: { url: data.url } } }, null, 2)} />
                  </Step>
                </ol>
              )}

              {app === "vscode" && (
                <ol className="space-y-3">
                  <Step n={1} title="Add it to VS Code in one click">
                    <a className="btn btn-primary btn-sm" href={vscodeInstallLink(data)}>
                      Add to VS Code
                    </a>
                    <p className="mt-1.5 text-[12px] text-trace">VS Code opens and asks to confirm; the tools are then in Copilot's agent mode.</p>
                  </Step>
                  <Step n={2} title="Or by hand, in .vscode/mcp.json">
                    <Code id="vscode" text={JSON.stringify({ servers: { [data.server_name]: { type: "http", url: data.url } } }, null, 2)} />
                  </Step>
                </ol>
              )}

              {app === "claude-code" && (
                <ol className="space-y-3">
                  <Step n={1} title="Run this command in a terminal">
                    <Code id="claude-code" text={`claude mcp add --transport http --scope user ${data.server_name} ${data.url}`} />
                  </Step>
                  <Note>
                    A computer set up with the install prompt already has it, with its own token. This command is for another computer, or to plug
                    the brain in without installing anything.
                  </Note>
                </ol>
              )}

              {app === "codex" && (
                <ol className="space-y-3">
                  <Step n={1} title="Run this command in a terminal">
                    <Code id="codex" text={`codex mcp add ${data.server_name} --url ${data.url}`} />
                  </Step>
                  <Note>Check it with codex mcp list. A computer set up with the install prompt already has it.</Note>
                </ol>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )

  function Code({ id, text }: { id: string; text: string }) {
    return (
      <div className="relative">
        <pre className="scroll-thin mono inset overflow-x-auto whitespace-pre p-3 pr-20 text-[11.5px] leading-relaxed">{mask(text)}</pre>
        <button type="button" className="btn btn-sm absolute right-2 top-2" onClick={() => void copy(id, text)}>
          {copied === id ? "Copied" : "Copy"}
        </button>
      </div>
    )
  }
}

/** cursor://…/mcp/install?name=…&config=<base64 of the mcp.json entry> (Cursor's install links). */
function cursorInstallLink(c: Connector): string {
  const config = btoa(JSON.stringify({ url: c.url }))
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=${encodeURIComponent(c.server_name)}&config=${encodeURIComponent(config)}`
}

/** vscode:mcp/install?<the --add-mcp JSON, URL-encoded> (VS Code's install links). */
function vscodeInstallLink(c: Connector): string {
  return `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name: c.server_name, type: "http", url: c.url }))}`
}

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a className="underline underline-offset-2" href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  )
}

function Note({ children }: { children: ReactNode }) {
  return <li className="list-none text-[12px] leading-relaxed text-trace">{children}</li>
}

function Step({ n, title, picture, children }: { n: number; title: string; picture?: ReactNode; children?: ReactNode }) {
  return (
    <li className={`inset grid gap-3 p-3 ${picture ? "sm:grid-cols-[minmax(0,1fr)_240px] sm:items-center" : ""}`}>
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
