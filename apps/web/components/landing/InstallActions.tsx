"use client"

import Link from "next/link"
import { useRef, useState } from "react"
import { CheckIcon, ErrorText } from "../ui"

type Status = { kind: "idle" } | { kind: "busy" } | { kind: "copied" } | { kind: "opened"; app: "desktop" | "terminal" } | { kind: "error"; message: string }

/**
 * Copier le prompt d'installation, ou l'ouvrir directement dans Claude Code. En mode démo, le prompt est demandé au
 * premier clic (`POST /api/demo/install` crée un compte visiteur et son jeton), puis gardé pour les clics suivants.
 * Liens Claude Code : `claude://code/new?q=` (app de bureau) et `claude-cli://open?q=` (terminal). Le prompt arrive
 * pré-rempli, rien ne part sans que la personne appuie sur Entrée.
 */
export function InstallActions({ demo }: { demo: boolean }) {
  const prompt = useRef<Promise<string> | null>(null)
  const [status, setStatus] = useState<Status>({ kind: "idle" })

  if (!demo) {
    return (
      <div className="panel px-5 py-5">
        <p className="text-[15px]">Votre prompt, avec votre jeton personnel, vous est remis par l'admin de votre cerveau.</p>
        <Link href="/login" className="btn btn-primary btn-lg mt-4">
          Se connecter
        </Link>
      </div>
    )
  }

  // Une seule requête par visite : un clic sur « Copier » puis sur « Ouvrir » utilisent le même compte visiteur.
  const getPrompt = () => {
    prompt.current ??= fetch("/api/demo/install", { method: "POST" }).then(async (res) => {
      const body = (await res.json().catch(() => ({}))) as { prompt?: string; error?: string }
      if (!res.ok || !body.prompt) throw new Error(body.error ?? "Le prompt n'a pas pu être préparé.")
      return body.prompt
    })
    prompt.current.catch(() => (prompt.current = null))
    return prompt.current
  }

  // Safari n'autorise la copie qu'au moment du clic : on lui passe la promesse du texte, résolue plus tard.
  const copy = async () => {
    const text = getPrompt()
    if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
      await navigator.clipboard.write([new ClipboardItem({ "text/plain": text.then((t) => new Blob([t], { type: "text/plain" })) })])
    } else {
      await navigator.clipboard.writeText(await text)
    }
  }

  const onCopy = async () => {
    setStatus({ kind: "busy" })
    try {
      await copy()
      setStatus({ kind: "copied" })
    } catch (e) {
      setStatus({ kind: "error", message: e instanceof Error ? e.message : "Copie impossible." })
    }
  }

  // Ouvrir copie aussi le prompt : si Claude Code n'est pas installé, rien ne s'ouvre mais le prompt est prêt à coller.
  const onOpen = async (app: "desktop" | "terminal") => {
    setStatus({ kind: "busy" })
    try {
      const copied = copy().catch(() => undefined)
      const q = encodeURIComponent(await getPrompt())
      window.location.href = app === "desktop" ? `claude://code/new?q=${q}` : `claude-cli://open?q=${q}`
      await copied
      setStatus({ kind: "opened", app })
    } catch (e) {
      setStatus({ kind: "error", message: e instanceof Error ? e.message : "Ouverture impossible." })
    }
  }

  const busy = status.kind === "busy"
  return (
    <div className="panel px-5 py-5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-3">
        <button type="button" className="btn btn-primary btn-lg" onClick={() => onOpen("desktop")} disabled={busy}>
          Ouvrir dans Claude Code
        </button>
        <button type="button" className="btn btn-lg" onClick={onCopy} disabled={busy}>
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

      <p className="mt-4 border-t border-line pt-4 text-[13px] leading-relaxed text-trace">
        Démo publique : le prompt vous crée un compte visiteur sur le cerveau de Fournil, avec votre propre jeton. Ce que votre poste y envoie ensuite est visible
        des autres visiteurs de la démo. Tout se retire avec <span className="mono text-ink">brain.mjs uninstall</span>.
      </p>
    </div>
  )
}
