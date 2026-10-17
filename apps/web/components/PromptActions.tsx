"use client"

import { useState } from "react"
import { ClaudeLogo, CodexLogo } from "./brand-logos"
import { CheckIcon, ErrorText } from "./ui"

type App = "terminal" | "desktop" | "vscode"
type Status = { kind: "idle" } | { kind: "busy" } | { kind: "copied" } | { kind: "codex" } | { kind: "opened"; app: App } | { kind: "error"; message: string }

/** Au-delà, un lien `claude-cli://` est refusé (https://code.claude.com/docs/en/deep-links) : on colle le prompt à la main. */
const MAX_LINK_PROMPT = 5000

/**
 * Liens Claude Code ; le prompt arrive pré-rempli, rien ne part sans que la personne appuie sur Entrée.
 * - `terminal` (claude-cli://) : toujours sur ce poste. C'est le lien principal, nos prompts ont besoin du poste
 *   (installer le client, lire l'historique des sessions).
 * - `vscode` : l'extension Claude Code, sur ce poste aussi.
 * - `desktop` (claude://code/new) : l'app de bureau, qui peut ouvrir une session dans le cloud ; aucun paramètre
 *   documenté ne choisit l'environnement, d'où le rappel de choisir « Local ».
 */
export function claudeCodeUrl(app: App, prompt: string): string {
  const q = encodeURIComponent(prompt)
  if (app === "desktop") return `claude://code/new?q=${q}`
  if (app === "vscode") return `vscode://anthropic.claude-code/open?prompt=${q}`
  return `claude-cli://open?q=${q}`
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

const OPENED: Record<App, string> = {
  terminal: "Un terminal s'ouvre avec claude et le prompt : relisez-le, puis appuyez sur Entrée. Rien ne s'est ouvert ? Le prompt est aussi copié : collez-le dans un terminal où tourne claude (le lien ne marche qu'après une première session claude).",
  vscode: "Le prompt attend dans Claude Code pour VS Code : relisez-le, puis appuyez sur Entrée. Rien ne s'est ouvert ? Il est aussi copié.",
  desktop: "Le prompt attend dans l'app Claude, onglet Code. Vérifiez que l'environnement est « Local » (pas un environnement cloud), puis appuyez sur Entrée. Il est aussi copié.",
}

/**
 * Copier un prompt, ou l'ouvrir directement dans Claude Code sur ce poste. `getPrompt` peut créer le prompt au premier
 * clic (compte visiteur de la démo, code d'envoi) : il est appelé à chaque action, à lui de garder son résultat.
 */
/**
 * `sends` : le prompt envoie des données du poste à un site (onboarding par un agent). En mode auto, Claude Code le
 * bloque par sécurité, ce qui est voulu : on explique comment l'autoriser en connaissance de cause.
 */
export function PromptActions({ getPrompt, size = "lg", sends = false }: { getPrompt: () => Promise<string>; size?: "lg" | "md"; sends?: boolean }) {
  const [status, setStatus] = useState<Status>({ kind: "idle" })
  const btn = size === "lg" ? "btn-lg" : ""

  // Codex n'a pas de lien documenté qui pré-remplit un prompt : on le copie et on donne la commande à lancer.
  const onCopy = async (forCodex = false) => {
    setStatus({ kind: "busy" })
    try {
      await copyText(getPrompt())
      setStatus({ kind: forCodex ? "codex" : "copied" })
    } catch (e) {
      setStatus({ kind: "error", message: e instanceof Error ? e.message : "Copie impossible." })
    }
  }

  // Ouvrir copie aussi le prompt : si le lien ne mène nulle part, le prompt est prêt à coller.
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
      setStatus({ kind: "error", message: e instanceof Error ? e.message : "Ouverture impossible." })
    }
  }

  const busy = status.kind === "busy"
  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-3">
        <button
          type="button"
          className={`btn logo-btn ${btn}`}
          onClick={() => onOpen("terminal")}
          disabled={busy}
          aria-label="Ouvrir dans Claude Code"
          title="Ouvrir dans Claude Code, sur ce poste"
        >
          <ClaudeLogo size={size === "lg" ? 24 : 20} />
        </button>
        <button type="button" className={`btn logo-btn ${btn}`} onClick={() => onCopy(true)} disabled={busy} aria-label="Utiliser avec Codex" title="Utiliser avec Codex">
          <CodexLogo size={size === "lg" ? 24 : 20} />
        </button>
        <button type="button" className={`btn btn-ghost ${btn}`} onClick={() => onCopy()} disabled={busy}>
          Copier le prompt
        </button>
      </div>
      <p className="mt-3 text-[13px] leading-relaxed text-trace">
        Claude Code s&apos;ouvre dans un terminal, sur ce poste : il y a tout votre contexte. Codex : le prompt est copié. Claude Code peut aussi s&apos;ouvrir dans{" "}
        <button type="button" className="landing-link text-ink" onClick={() => onOpen("vscode")} disabled={busy}>
          VS Code
        </button>{" "}
        ou{" "}
        <button type="button" className="landing-link text-ink" onClick={() => onOpen("desktop")} disabled={busy}>
          l&apos;app Claude de bureau
        </button>{" "}
        (choisissez alors l&apos;environnement « Local »).
      </p>

      {sends && (
        <p className="mt-2 text-[13px] leading-relaxed text-trace">
          L&apos;envoi est bloqué ? En mode auto, Claude Code refuse par sécurité d&apos;envoyer des données à un site. Passez en mode par défaut (Maj+Tab) et
          acceptez la commande d&apos;envoi quand il la propose, ou lancez <span className="mono text-ink">claude --dangerously-skip-permissions</span> pour cette
          session (plus aucune confirmation : à réserver à ce prompt). Codex, lui, demande à sortir de son bac à sable : acceptez.
        </p>
      )}

      <div className="mt-4 min-h-[22px] text-[14px]" aria-live="polite">
        {status.kind === "busy" && <p className="text-trace">Préparation de votre prompt…</p>}
        {status.kind === "copied" && (
          <p className="flex items-center gap-1.5">
            <CheckIcon /> Prompt copié. Collez-le dans Claude Code, sur ce poste (pas dans une session cloud).
          </p>
        )}
        {status.kind === "codex" && (
          <div className="flex items-start gap-1.5">
            <CheckIcon className="mt-[3px] shrink-0" />
            <div>
              <p>Prompt copié. Dans un terminal, sur ce poste, lancez codex et collez-le. Sur Mac, en une ligne :</p>
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
