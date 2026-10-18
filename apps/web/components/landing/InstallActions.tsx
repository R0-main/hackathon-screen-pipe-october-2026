"use client"

import Link from "next/link"
import { useRef } from "react"
import { PromptActions } from "../PromptActions"

/**
 * The install prompt from the home page. In demo mode, it is requested on the first click
 * (`POST /api/demo/install` creates a visitor account and its token), then kept for the next clicks.
 * Outside the demo, you create your company (/create) or sign in with the token your admin gave you.
 */
export function InstallActions({ demo, signup }: { demo: boolean; signup: boolean }) {
  const prompt = useRef<Promise<string> | null>(null)

  if (!demo) {
    return (
      <div className="panel px-5 py-5">
        <p className="text-[15px]">
          {signup
            ? "Create your company's brain: four questions, then your prompt. Your colleagues get theirs, with their personal token, when you invite them."
            : "Your prompt, with your personal token, is given to you by your brain's admin."}
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          {signup && (
            <Link href="/create" className="btn btn-primary btn-lg">
              Create my company
            </Link>
          )}
          <Link href="/login" className={`btn btn-lg ${signup ? "" : "btn-primary"}`}>
            Sign in
          </Link>
        </div>
      </div>
    )
  }

  // A single request per visit: a click on "Copy" then on "Open" use the same visitor account.
  const getPrompt = () => {
    prompt.current ??= fetch("/api/demo/install", { method: "POST" }).then(async (res) => {
      const body = (await res.json().catch(() => ({}))) as { prompt?: string; error?: string }
      if (!res.ok || !body.prompt) throw new Error(body.error ?? "The prompt could not be prepared.")
      return body.prompt
    })
    prompt.current.catch(() => (prompt.current = null))
    return prompt.current
  }

  return (
    <div className="panel px-5 py-5">
      <PromptActions getPrompt={getPrompt} terminal />
      <p className="mt-4 border-t border-line pt-4 text-[13px] leading-relaxed text-trace">
        Public demo: the prompt creates a visitor account on Encore&apos;s brain, with your own token. What your computer sends there afterwards is visible
        to the demo&apos;s other visitors. Everything is removed with <span className="mono text-ink">~/.company-brain/brain uninstall</span>.
        {signup && (
          <>
            {" "}
            For your team, <Link href="/create" className="landing-link text-ink">create your own company&apos;s brain instead</Link>.
          </>
        )}
      </p>
    </div>
  )
}
