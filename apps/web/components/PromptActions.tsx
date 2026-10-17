"use client"

import { useState } from "react"
import { CheckIcon, ErrorText } from "./ui"

type Status = { kind: "idle" } | { kind: "busy" } | { kind: "copied" } | { kind: "opened"; app: "desktop" | "terminal" } | { kind: "error"; message: string }

/** Liens Claude Code : le prompt arrive pré-rempli, rien ne part sans que la personne appuie sur Entrée. */
export function claudeCodeUrl(app: "desktop" | "terminal", prompt: string): string {
  const q = encodeURIComponent(prompt)
  return app === "desktop" ? `claude://code/new?q=${q}` : `claude-cli://open?q=${q}`
}

/** Copie un texte qui peut arriver plus tard. Safari n'autorise la copie qu'au moment du clic : on lui passe la promesse. */
export async function copyText(text: Promise<string> | string): Promise<void> {
  const pending = Promise.resolve(text)
  if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
    await navigator.clipboard.write([new ClipboardItem({ "text/plain": pending.then((t) => new Blob([t], { type: "text/plain" })) })])
  } else {
    await navigator.clipboard.writeText(await pending)
  }
}

/**
 * Copier un prompt d'installation, ou l'ouvrir directement dans Claude Code (app de bureau, ou terminal en lien
 * secondaire). `getPrompt` peut créer le prompt au premier clic (compte visiteur de la démo) : il est appelé à chaque
 * action, à lui de garder son résultat.
 */
export function PromptActions({ getPrompt, size = "lg" }: { getPrompt: () => Promise<string>; size?: "lg" | "md" }) {
  const [status, setStatus] = useState<Status>({ kind: "idle" })
  const btn = size === "lg" ? "btn-lg" : ""

  const onCopy = async () => {
    setStatus({ kind: "busy" })
    try {
      await copyText(getPrompt())
      setStatus({ kind: "copied" })
    } catch (e) {
      setStatus({ kind: "error", message: e instanceof Error ? e.message : "Copie impossible." })
    }
  }

  // Ouvrir copie aussi le prompt : si Claude Code n'est pas installé, rien ne s'ouvre mais le prompt est prêt à coller.
  const onOpen = async (app: "desktop" | "terminal") => {
    setStatus({ kind: "busy" })
    try {
      const prompt = getPrompt()
      const copied = copyText(prompt).catch(() => undefined)
      window.location.href = claudeCodeUrl(app, await prompt)
      await copied
      setStatus({ kind: "opened", app })
    } catch (e) {
      setStatus({ kind: "error", message: e instanceof Error ? e.message : "Ouverture impossible." })
    }
  }

  const busy = status.kind === "busy"
  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-3">
        <button type="button" className={`btn btn-primary ${btn}`} onClick={() => onOpen("desktop")} disabled={busy}>
          Ouvrir dans Claude Code
        </button>
        <button type="button" className={`btn ${btn}`} onClick={onCopy} disabled={busy}>
          Copier le prompt
        </button>
      </div>
      <p className="mt-3 text-[14px] text-trace">
        Vous utilisez Claude Code en ligne de commande ?{" "}
        <button type="button" className="landing-link text-ink" onClick={() => onOpen("terminal")} disabled={busy}>
          L'ouvrir dans le terminal
        </button>
      </p>

      <div className="mt-4 min-h-[22px] text-[14px]" aria-live="polite">
        {status.kind === "busy" && <p className="text-trace">Préparation de votre prompt…</p>}
        {status.kind === "copied" && (
          <p className="flex items-center gap-1.5">
            <CheckIcon /> Prompt copié. Collez-le dans Claude Code.
          </p>
        )}
        {status.kind === "opened" && (
          <p className="flex items-start gap-1.5">
            <CheckIcon className="mt-[3px] shrink-0" />
            <span>
              Le prompt attend dans Claude Code : relisez-le, puis appuyez sur Entrée. Rien ne s'est ouvert ? Il est aussi copié, collez-le
              {status.app === "desktop" ? " dans l'app Claude, onglet Code." : " dans un terminal où tourne claude."}
            </span>
          </p>
        )}
        {status.kind === "error" && <ErrorText>{status.message}</ErrorText>}
      </div>
    </div>
  )
}
