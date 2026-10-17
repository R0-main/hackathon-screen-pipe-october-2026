import { Dot, zoneColor } from "../ui"
import { LANDING_ZONES } from "./landing-data"

/*
  "The raw data stays on the computer", shown with real captures from the Fournil demo: what Screenpipe records
  on the computer, the three steps of the local filter, and the few knowledge items that go up to the brain.

  The markup describes the final state (readable without JavaScript and under prefers-reduced-motion): personal
  captures dropped, secret redacted, knowledge arrived. The scroll story replays it on scroll (motion/setup.ts,
  data-pf-* attributes).
*/

type Capture = { app: string; text: string; kind: "work" | "personal" | "secret" }

const CAPTURES: Capture[] = [
  { app: "Claude Code", text: "How do we deploy Fournil to production?", kind: "work" },
  { app: "WhatsApp", text: "Weekend photos", kind: "personal" },
  { app: "Terminal", text: "export STRIPE_KEY=", kind: "secret" },
  { app: "Codex", text: "Reconcile yesterday's Qonto statements", kind: "work" },
  { app: "Personal bank", text: "October account statement", kind: "personal" },
  { app: "Slack", text: "#dev: the SMS queue goes to prod", kind: "work" },
]

const STEPS = ["Work apps only", "Secrets redacted", "Distilled on the computer"]

const KNOWLEDGE = [
  { zone: "dev", kind: "Procedure", title: "Deploy Fournil to production" },
  { zone: "finance", kind: "Procedure", title: "Reconcile Qonto and Pennylane every morning" },
  { zone: "dev", kind: "Decision", title: "Preorder SMS go through a queue" },
]

const zone = (id: string) => LANDING_ZONES.find((z) => z.id === id)!

export function PrivacyFlow() {
  return (
    <figure data-privacy className="privacy-flow" aria-label="On the computer, Screenpipe records everything; the local filter drops what is personal, redacts secrets and distills; only three knowledge items go up to the brain.">
      {/* The computer: everything Screenpipe captures, which never leaves. */}
      <div data-pf-workstation className="panel overflow-hidden">
        <div className="border-b border-line px-4 py-3">
          <span className="panel-title block">Hugo&apos;s computer</span>
          <span data-pf-weight className="mt-0.5 block text-[12px] tabular-nums text-trace">19 GB in two weeks</span>
        </div>
        <ul className="divide-y divide-line">
          {CAPTURES.map((c) => (
            <li key={c.app} data-pf-row data-kind={c.kind} className="privacy-row relative px-4 py-2">
              <span data-pf-dim={c.kind === "personal" ? "" : undefined} className="flex items-center justify-between gap-3 text-[12px] font-medium">
                {c.app}
                {c.kind === "work" && (
                  <span data-pf-pass className="inline-flex shrink-0 items-center gap-1 text-[11px] font-normal text-trace">
                    <span className="size-[6px] rounded-full bg-ink" aria-hidden />
                    kept
                  </span>
                )}
              </span>
              <span data-pf-dim={c.kind === "personal" ? "" : undefined} className="mt-0.5 block text-[12px] leading-snug text-trace">
                {c.kind === "secret" ? (
                  <span className="mono">
                    {c.text}
                    <span className="relative inline-block whitespace-nowrap">
                      <span className="text-ink">sk_live_51Hf8Q</span>
                      <span data-pf-mask className="privacy-mask" aria-hidden />
                      <span className="sr-only">(secret redacted)</span>
                    </span>
                  </span>
                ) : (
                  c.text
                )}
              </span>
              {c.kind === "personal" && <span data-pf-strike className="privacy-strike" aria-hidden />}
            </li>
          ))}
        </ul>
        <p className="border-t border-line px-4 py-2.5 text-[12px] text-trace">and 18,400 other captures, which stay here</p>
      </div>

      {/* The local filter: a rail of three steps, on the computer. */}
      <ol data-pf-filter className="privacy-rail" aria-label="Local filter">
        <span data-pf-rail className="privacy-rail-line" aria-hidden />
        {STEPS.map((s) => (
          <li key={s} data-pf-step className="relative flex items-start gap-2.5">
            <span className="privacy-node" aria-hidden>
              <span data-pf-node />
            </span>
            <span className="text-[12px] leading-snug">{s}</span>
          </li>
        ))}
      </ol>

      {/* The brain: what goes up, and nothing else. */}
      <div data-pf-brain className="panel overflow-hidden">
        <div className="border-b border-line px-4 py-3">
          <span className="panel-title block">The brain</span>
          <span data-pf-weight className="mt-0.5 block text-[12px] tabular-nums text-trace">a few KB</span>
        </div>
        <ul className="divide-y divide-line">
          {KNOWLEDGE.map((k) => (
            <li key={k.title} data-pf-chip className="px-4 py-2.5">
              <span className="flex items-center justify-between gap-3 text-[12px] text-trace">
                <span className="inline-flex items-center gap-1.5">
                  <Dot color={zoneColor(zone(k.zone).color, zone(k.zone).position)} />
                  {zone(k.zone).name}
                </span>
                <span>{k.kind}</span>
              </span>
              <span className="mt-0.5 block text-[13px] leading-snug">{k.title}</span>
            </li>
          ))}
        </ul>
      </div>
    </figure>
  )
}
