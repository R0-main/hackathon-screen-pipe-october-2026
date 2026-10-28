"use client"

import { useState } from "react"
import { BRAIN_CLI, BRAIN_CLI_WINDOWS, terminalCommands } from "@/lib/install-prompt"
import { ClaudeLogo, CodexLogo, NodeLogo } from "./brand-logos"
import { CheckIcon, ErrorText } from "./ui"

type App = "terminal" | "desktop" | "vscode"
type Status = { kind: "idle" } | { kind: "busy" } | { kind: "copied" } | { kind: "codex" } | { kind: "opened"; app: App } | { kind: "error"; message: string }

/** Beyond this, a `claude-cli://` link is refused (https://code.claude.com/docs/en/deep-links): the prompt is pasted by hand. */
const MAX_LINK_PROMPT = 5000

/**
 * Claude Code links; the prompt arrives pre-filled, nothing is sent until the person presses Enter.
 * - `desktop` (claude://code/new): the desktop app, Code tab. It is the main button. It can open a session
 *   in the cloud and no documented parameter picks the environment, hence the reminder to choose "Local": our
 *   prompts need the computer itself (installing the client, reading the session history).
 * - `terminal` (claude-cli://): always on this computer, as a discreet link under the buttons.
 * - `vscode`: the Claude Code extension, on this computer too.
 */
export function claudeCodeUrl(app: App, prompt: string): string {
  const q = encodeURIComponent(prompt)
  if (app === "desktop") return `claude://code/new?q=${q}`
  if (app === "vscode") return `vscode://anthropic.claude-code/open?prompt=${q}`
  return `claude-cli://open?q=${q}`
}

/** Copies a text that may arrive later. Safari only allows copying at click time: it is given the promise. */
export async function copyText(text: Promise<string> | string): Promise<void> {
  const pending = Promise.resolve(text)
  if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
    await navigator.clipboard.write([new ClipboardItem({ "text/plain": pending.then((t) => new Blob([t], { type: "text/plain" })) })])
  } else {
    await navigator.clipboard.writeText(await pending)
  }
}

const OPENED: Record<App, string> = {
  terminal: "A terminal opens with claude and the prompt: read it, then press Enter. Nothing opened? The prompt is also copied: paste it into a terminal running claude (the link only works after a first claude session).",
  vscode: "The prompt is waiting in Claude Code for VS Code: read it, then press Enter. Nothing opened? It is also copied.",
  desktop: "The prompt is waiting in the Claude app, Code tab. Check that the environment is \"Local\" (not a cloud environment), then press Enter. It is also copied.",
}

/**
 * Copy a prompt, or open it directly in Claude Code on this computer. `getPrompt` may create the prompt on the first
 * click (demo visitor account, upload code): it is called on every action, it is up to it to keep its result.
 *
 * `sends`: the prompt sends data from the computer to a website (onboarding by an agent). In auto mode, Claude Code
 * blocks it for safety, which is intended: we explain how to allow it knowingly.
 * `terminal`: an install prompt, whose command can also be pasted by hand into a terminal (`TerminalCommand`).
 */
export function PromptActions({ getPrompt, size = "lg", sends = false, terminal = false }: { getPrompt: () => Promise<string>; size?: "lg" | "md"; sends?: boolean; terminal?: boolean }) {
  const [status, setStatus] = useState<Status>({ kind: "idle" })
  const btn = size === "lg" ? "btn-lg" : ""

  // Codex has no documented link that pre-fills a prompt: it is copied and the command to run is shown.
  const onCopy = async (forCodex = false) => {
    setStatus({ kind: "busy" })
    try {
      await copyText(getPrompt())
      setStatus({ kind: forCodex ? "codex" : "copied" })
    } catch (e) {
      setStatus({ kind: "error", message: e instanceof Error ? e.message : "Could not copy." })
    }
  }

  // Opening also copies the prompt: if the link leads nowhere, the prompt is ready to paste.
  const onOpen = async (app: App) => {
    setStatus({ kind: "busy" })
    try {
      const prompt = getPrompt()
      const copied = copyText(prompt).catch(() => undefined)
      const text = await prompt
      if (text.length > MAX_LINK_PROMPT) {
        await copied
        setStatus({ kind: "copied" })
        return
      }
      window.location.href = claudeCodeUrl(app, text)
      await copied
      setStatus({ kind: "opened", app })
    } catch (e) {
      setStatus({ kind: "error", message: e instanceof Error ? e.message : "Could not open." })
    }
  }

  const busy = status.kind === "busy"
  const logo = size === "lg" ? 20 : 18
  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-3">
        <button type="button" className={`btn ${btn}`} onClick={() => onOpen("desktop")} disabled={busy} title="Opens the Claude app, Code tab">
          <ClaudeLogo size={logo} />
          Open in Claude Code
        </button>
        <button type="button" className={`btn ${btn}`} onClick={() => onCopy(true)} disabled={busy} title="Copies the prompt and shows the codex command to run">
          <CodexLogo size={logo} />
          Use with Codex
        </button>
        <button type="button" className={`btn btn-ghost ${btn}`} onClick={() => onCopy()} disabled={busy}>
          Copy the prompt
        </button>
      </div>
      <p className="mt-3 text-[13px] leading-relaxed text-trace">
        Claude Code opens in the Claude app, Code tab: choose the &quot;Local&quot; environment, on this computer. With Codex, the prompt is copied and the
        command to run is shown.
      </p>
      <p className="mt-1.5 text-[12px] text-trace">
        Prefer the terminal?{" "}
        <button type="button" className="underline underline-offset-2 hover:text-ink" onClick={() => onOpen("terminal")} disabled={busy}>
          Click here to open it in the terminal
        </button>{" "}
        or{" "}
        <button type="button" className="underline underline-offset-2 hover:text-ink" onClick={() => onOpen("vscode")} disabled={busy}>
          in VS Code
        </button>
        .
      </p>
      {terminal && <TerminalCommand getPrompt={getPrompt} />}

      {sends && (
        <p className="mt-2 text-[13px] leading-relaxed text-trace">
          Upload blocked? In auto mode, Claude Code refuses for safety to send data to a website. Switch to the default mode (Shift+Tab) and
          accept the upload command when it proposes it: it only sends to this brain, and Claude Code keeps asking for everything else. Codex
          asks to leave its sandbox for that command: accept.
        </p>
      )}

      <div className="mt-4 min-h-[22px] text-[14px]" aria-live="polite">
        {status.kind === "busy" && <p className="text-trace">Preparing your prompt…</p>}
        {status.kind === "copied" && (
          <p className="flex items-center gap-1.5">
            <CheckIcon /> Prompt copied. Paste it into Claude Code or Codex, on this computer (not in a cloud session).
          </p>
        )}
        {status.kind === "codex" && (
          <div className="flex items-start gap-1.5">
            <CheckIcon className="mt-[3px] shrink-0" />
            <div>
              <p>Prompt copied. In a terminal, on this computer, run codex and paste it. On a Mac, in one line:</p>
              <p className="mono inset mt-1.5 inline-block select-all px-2 py-1 text-[13px]">codex &quot;$(pbpaste)&quot;</p>
            </div>
          </div>
        )}
        {status.kind === "opened" && (
          <p className="flex items-start gap-1.5">
            <CheckIcon className="mt-[3px] shrink-0" />
            <span>{OPENED[status.app]}</span>
          </p>
        )}
        {status.kind === "error" && <ErrorText>{status.message}</ErrorText>}
      </div>
    </div>
  )
}

type Os = "posix" | "windows"

/**
 * Without an agent, in small under the buttons: the prompt's command for each system, to paste yourself into a
 * terminal (`terminalCommands`). The same install, Node.js included when it is missing; the agent stays the main way.
 */
function TerminalCommand({ getPrompt }: { getPrompt: () => Promise<string> }) {
  const [copied, setCopied] = useState<Os | null>(null)
  const [failed, setFailed] = useState<string | null>(null)

  const copy = async (os: Os) => {
    setCopied(null)
    setFailed(null)
    const prompt = getPrompt()
    try {
      await copyText(prompt.then((p) => terminalCommands(p)?.[os] ?? Promise.reject(new Error("no command in this prompt"))))
      setCopied(os)
    } catch {
      // The prompt could not be prepared (demo visitor account): its reason. Otherwise, the clipboard refused.
      const reason = await prompt.then(
        () => null,
        (e: unknown) => (e instanceof Error ? e.message : null),
      )
      setFailed(reason ?? "Automatic copy is not possible here: copy the command for your system from the prompt.")
    }
  }

  const link = "underline underline-offset-2 hover:text-ink"
  return (
    <div className="mt-1.5 text-[12px] leading-relaxed text-trace">
      <p>
        No agent? Copy the command for{" "}
        <button type="button" className={link} onClick={() => copy("posix")} aria-label="Copy the command for macOS and Linux">
          macOS, Linux
        </button>{" "}
        or{" "}
        <button type="button" className={link} onClick={() => copy("windows")} aria-label="Copy the command for Windows (PowerShell)">
          Windows
        </button>{" "}
        and paste it into a terminal. It installs{" "}
        <a href="https://nodejs.org/en/download" target="_blank" rel="noreferrer" className={`inline-flex items-center gap-1 align-bottom ${link}`}>
          <NodeLogo size={12} />
          Node.js
        </a>{" "}
        if it is missing.
      </p>
      <div aria-live="polite">
        {copied && (
          <p className="mt-1 flex items-start gap-1.5 text-ink">
            <CheckIcon size={14} className="mt-[2px] shrink-0" />
            <span>
              Command copied: paste it into {copied === "windows" ? "PowerShell" : "a terminal"} on this computer. It installs everything, then opens the brain; no
              history is sent. Stuck? Run <span className="mono">{copied === "windows" ? BRAIN_CLI_WINDOWS : BRAIN_CLI} doctor</span>.
            </span>
          </p>
        )}
        {failed && <ErrorText className="mt-1 text-[12px]">{failed}</ErrorText>}
      </div>
    </div>
  )
}
