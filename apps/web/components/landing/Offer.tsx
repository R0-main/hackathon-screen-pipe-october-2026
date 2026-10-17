"use client"

import Link from "next/link"
import { useState } from "react"
import { CheckIcon } from "../ui"

/*
  Two ways to get your brain: on your own servers (the code is open) or on our cloud, then the
  pricing. Front end only: prices are indicative and payment is wired nowhere. The cloud buttons
  lead to company creation (or to the demo when creation is closed).
*/

const REPO = "https://github.com/R0-main/hackathon-screen-pipe-october-2026"
const GUIDE = `${REPO}#deploy-the-shared-brain-vercel--neon-free-tiers`

const COMMANDS = [
  `git clone ${REPO} nos-brainer`,
  "cd nos-brainer && npm ci && npm run build",
  "export DATABASE_URL=postgres://… BRAIN_PUBLIC_URL=https://brain.example.com",
  "npm run db:migrate && npm start",
]

type Cta = { href: string; label: string }

function Features({ items }: { items: string[] }) {
  return (
    <ul className="space-y-2.5">
      {items.map((f) => (
        <li key={f} className="flex gap-2.5 text-[14px] leading-snug">
          <CheckIcon className="mt-[1px] shrink-0" />
          <span>{f}</span>
        </li>
      ))}
    </ul>
  )
}

/** Your place or ours: the same brain, two ways to host it. */
export function Hosting({ onAnchor }: { onAnchor?: (e: React.MouseEvent<HTMLAnchorElement>) => void }) {
  return (
    <section data-hold="1" className="landing-section relative border-t border-line" aria-labelledby="hosting">
      <span data-bead className="landing-bead" aria-hidden>
        <span data-bead-fill />
      </span>
      <div className="landing-wrap">
        <div className="grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:items-end lg:gap-20">
          <h2 id="hosting" data-reveal="title" className="landing-h2 max-w-[11em]">
            Your place, or ours.
          </h2>
          <div data-reveal="text" className="max-w-[34em]">
            <p className="text-[16px] leading-relaxed sm:text-[17px]">
              It is the same brain either way. The code is open: install it on your own infrastructure, or let us host it in Europe and stop thinking about the server.
            </p>
            <p className="mt-3 text-[15px] leading-relaxed text-trace">Wherever it runs, the raw data stays on the computers, and Claude Code or Codex go through each person&apos;s own subscription.</p>
          </div>
        </div>

        <ul data-reveal="cards" className="mt-12 grid gap-4 lg:mt-16 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
          <li className="panel flex flex-col px-5 py-6 sm:px-6">
            <p className="panel-title">On your servers</p>
            <p className="mt-1 text-[13px] text-trace">Free, no limit on seats.</p>
            <pre className="inset mono mt-4 overflow-x-auto px-3.5 py-3 text-[12px] leading-relaxed" aria-label="Install the brain on your server">
              {COMMANDS.join("\n")}
            </pre>
            <div className="mt-5">
              <Features items={["Any Postgres: Neon, Supabase or your own.", "Knowledge never leaves your network.", "Computers connect to your own address."]} />
            </div>
            <a href={GUIDE} target="_blank" rel="noreferrer" className="landing-link mt-auto pt-6 text-[14px]">
              Read the install guide
            </a>
          </li>
          <li className="panel flex flex-col px-5 py-6 sm:px-6">
            <p className="panel-title">On our cloud</p>
            <p className="mt-1 text-[13px] text-trace">From €8 per seat per month.</p>
            <div className="mt-5">
              <Features
                items={[
                  "Hosted in Europe, in Frankfurt.",
                  "Backups, updates and certificates handled for you.",
                  "Your brain is ready after four questions.",
                  "One prompt to paste per computer, nothing to install on a server.",
                ]}
              />
            </div>
            <a href="#pricing" onClick={onAnchor} className="landing-link mt-auto pt-6 text-[14px]">
              See pricing
            </a>
          </li>
        </ul>
      </div>
    </section>
  )
}

type Billing = "month" | "year"

type Plan = {
  name: string
  where: string
  price: (b: Billing) => string
  unit: (b: Billing) => string
  features: string[]
  cta: Cta & { external?: boolean }
  primary?: boolean
}

/** The plans. `cloud`: where the cloud buttons lead (company creation or demo). */
export function Pricing({ cloud }: { cloud: string }) {
  const [billing, setBilling] = useState<Billing>("year")
  const plans: Plan[] = [
    {
      name: "Self-hosted",
      where: "On your servers",
      price: () => "€0",
      unit: () => "forever",
      features: ["Unlimited seats", "The whole brain: zones, agents, automations, connectors", "Your Postgres, your infrastructure", "Community help on GitHub"],
      cta: { href: GUIDE, label: "Read the guide", external: true },
    },
    {
      name: "Team",
      where: "On our cloud",
      price: (b) => (b === "year" ? "€8" : "€10"),
      unit: (b) => (b === "year" ? "per seat per month, billed yearly" : "per seat per month"),
      features: ["Up to 50 seats", "Hosted in Europe", "Nightly backups", "Email support within one business day"],
      cta: { href: cloud, label: "Create my company" },
      primary: true,
    },
    {
      name: "Enterprise",
      where: "On our cloud or yours",
      price: () => "Custom",
      unit: () => "from 50 seats",
      features: ["Unlimited seats", "SSO and access log", "Region and retention of your choice", "Help with rollout and with informing employee representatives"],
      cta: { href: cloud, label: "Start a pilot" },
    },
  ]

  return (
    <section id="pricing" data-hold="1" className="landing-section relative border-t border-line" aria-labelledby="pricing-title">
      <span data-bead className="landing-bead" aria-hidden>
        <span data-bead-fill />
      </span>
      <div className="landing-wrap">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h2 id="pricing-title" data-reveal="title" className="landing-h2 max-w-[12em]">
              One price per seat, no surprises.
            </h2>
            <p data-reveal="text" className="mt-5 max-w-[32em] text-[16px] leading-relaxed sm:text-[17px]">
              You only pay for the computers connected to the brain. Knowledge, zones and agents are not counted.
            </p>
          </div>
          <div data-reveal="text" className="inline-flex self-start rounded-[6px] border border-line-strong bg-surface p-0.5 lg:self-auto" role="group" aria-label="Billing">
            {(
              [
                ["month", "Monthly"],
                ["year", "Yearly, −20%"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={billing === value}
                onClick={() => setBilling(value)}
                className={`h-8 rounded-[4px] px-3 text-[13px] font-medium transition-colors duration-150 ease-out ${billing === value ? "bg-ink text-surface" : "text-trace hover:text-ink"}`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <ul data-reveal="cards" className="mt-12 grid gap-4 lg:mt-16 lg:grid-cols-3">
          {plans.map((p) => (
            <li key={p.name} className={`panel flex flex-col px-5 py-6 sm:px-6 ${p.primary ? "!border-ink" : ""}`}>
              <div className="flex items-center justify-between gap-3">
                <p className="panel-title">{p.name}</p>
                {p.primary && <span className="chip">The simplest</span>}
              </div>
              <p className="mt-1 text-[13px] text-trace">{p.where}</p>
              <p className="mt-6 text-[40px] font-medium leading-none tracking-[-0.03em] tabular-nums" aria-live="polite">
                {p.price(billing)}
              </p>
              <p className="mt-2 min-h-[2.6em] text-[13px] leading-snug text-trace">{p.unit(billing)}</p>
              <div className="mt-5 border-t border-line pt-5">
                <Features items={p.features} />
              </div>
              <div className="mt-auto pt-8">
                {p.cta.external ? (
                  <a href={p.cta.href} target="_blank" rel="noreferrer" className="btn btn-lg w-full">
                    {p.cta.label}
                  </a>
                ) : (
                  <Link href={p.cta.href} className={`btn btn-lg w-full ${p.primary ? "btn-primary" : ""}`}>
                    {p.cta.label}
                  </Link>
                )}
              </div>
            </li>
          ))}
        </ul>

        <p data-reveal="text" className="mt-6 text-[13px] text-trace">
          Indicative prices, excluding tax. Payment is not open yet.
        </p>
      </div>
    </section>
  )
}
