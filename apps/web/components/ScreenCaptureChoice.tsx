"use client"

// With or without screen capture, for an install prompt: Screenpipe, or the Claude Code and Codex sessions only (the
// capture can be added later on the computer with `brain screenpipe on`). The prompt itself switches on this page
// (withoutScreenCapture): the server is not asked again, the token being only in the prompt.

import { BRAIN_CLI, withoutScreenCapture } from "@/lib/install-prompt"

/** The prompt for the choice made. */
export function promptFor(prompt: string, screen: boolean): string {
  return screen ? prompt : withoutScreenCapture(prompt)
}

export function ScreenCaptureChoice({ screen, onChange, who = "your" }: { screen: boolean; onChange: (screen: boolean) => void; who?: string }) {
  const options = [
    { value: true, label: "With screen capture", hint: `Screenpipe on ${who} computer: the brain also learns from the other apps, meetings included. On a Mac, two permissions to allow.` },
    { value: false, label: "Without", hint: `Claude Code and Codex sessions only: nothing to allow. Screen capture can be added later with ${BRAIN_CLI} screenpipe on.` },
  ]
  return (
    <div>
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Screen capture">
        {options.map((o) => (
          <button key={String(o.value)} type="button" role="radio" aria-checked={screen === o.value} className={`chip h-7 text-[13px] ${screen === o.value ? "chip-on" : ""}`} onClick={() => onChange(o.value)}>
            {o.label}
          </button>
        ))}
      </div>
      <p className="mt-2 text-[12px] leading-relaxed text-trace">{options.find((o) => o.value === screen)!.hint}</p>
    </div>
  )
}
