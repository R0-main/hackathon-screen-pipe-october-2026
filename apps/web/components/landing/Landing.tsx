"use client"

import Link from "next/link"
import { useEffect, useRef, useState } from "react"
import { gsap } from "gsap"
import { ScrollTrigger } from "gsap/ScrollTrigger"
import { useGSAP } from "@gsap/react"
import Lenis from "lenis"
import { MCP_CATALOG, catalogEntry } from "@brain/core"
import { McpLogo } from "../mcp-logos"
import { GithubIcon, LogoMark, ZoneTag, zoneColor } from "../ui"
import { InstallActions } from "./InstallActions"
import { Hosting, Pricing, REPO } from "./Offer"
import { PrivacyFlow } from "./PrivacyFlow"
import { ScrollBrain } from "./ScrollBrain"
import { LANDING_AGENTS, LANDING_SYNAPSES, LANDING_TOTAL, LANDING_ZONES } from "./landing-data"
import { setupLandingMotion } from "./motion/setup"

gsap.registerPlugin(useGSAP, ScrollTrigger)

/** Length of the pinned scene, in screen heights: each chapter has time to be read. */
const PIN_SCREENS = 7

/** Entry and exit of each chapter, as a fraction of the scene. */
const CHAPTERS = [
  { in: 0.11, out: 0.35 },
  { in: 0.39, out: 0.555 },
  { in: 0.6, out: 0.86 },
]

type Mode = "flow" | "scroll" | "still"

const zone = (id: string) => LANDING_ZONES.find((z) => z.id === id)!

/**
 * Public home page. The brain fills the first screen; on scroll, the scene is pinned:
 * it goes full screen and rotates through three chapters, then the page resumes.
 * Without JavaScript or under `prefers-reduced-motion`, the chapters read one after the other, brain still.
 */
export function Landing({ demo, signup, signedIn = false }: { demo: boolean; signup: boolean; signedIn?: boolean }) {
  const rootRef = useRef<HTMLElement>(null)
  const stageRef = useRef<HTMLElement>(null)
  const heroRef = useRef<HTMLDivElement>(null)
  const chapterRefs = useRef<(HTMLDivElement | null)[]>([])
  const barRef = useRef<HTMLDivElement>(null)
  const counterRef = useRef<HTMLSpanElement>(null)
  const progress = useRef(0)
  const lenisRef = useRef<Lenis | null>(null)
  const triggerRef = useRef<ScrollTrigger | null>(null)
  const [mode, setMode] = useState<Mode>("flow")

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)")
    const pick = () => setMode(mq.matches ? "still" : "scroll")
    pick()
    mq.addEventListener("change", pick)
    return () => mq.removeEventListener("change", pick)
  }, [])

  useGSAP(
    () => {
      if (mode !== "scroll" || !stageRef.current) return
      const lenis = new Lenis({ autoRaf: false, lerp: 0.11 })
      lenisRef.current = lenis
      lenis.on("scroll", ScrollTrigger.update)
      const tick = (time: number) => lenis.raf(time * 1000)
      gsap.ticker.add(tick)
      gsap.ticker.lagSmoothing(0)

      const tl = gsap.timeline({
        defaults: { ease: "none" },
        scrollTrigger: {
          trigger: stageRef.current,
          start: "top top",
          end: `+=${PIN_SCREENS * 100}%`,
          pin: true,
          scrub: true,
          onUpdate: (self) => {
            progress.current = self.progress
            if (counterRef.current) {
              counterRef.current.textContent = String(Math.round(LANDING_TOTAL * gsap.utils.clamp(0, 1, (self.progress - 0.12) / 0.22)))
            }
          },
        },
      })
      triggerRef.current = tl.scrollTrigger ?? null

      tl.to(heroRef.current, { autoAlpha: 0, y: -56, duration: 0.09 }, 0.015)
      chapterRefs.current.forEach((el, i) => {
        if (!el) return
        const c = CHAPTERS[i]
        tl.fromTo(el, { autoAlpha: 0, y: 40 }, { autoAlpha: 1, y: 0, duration: 0.045, ease: "power2.out" }, c.in)
        tl.to(el, { autoAlpha: 0, y: -40, duration: 0.035, ease: "power2.in" }, c.out)
      })
      tl.fromTo(barRef.current, { scaleX: 0 }, { scaleX: 1, duration: 1 }, 0)

      // The rest of the page (holds, snapping, sections on scroll). Created after the pinned scene, for the trigger order.
      const scene = tl.scrollTrigger
      const stops = CHAPTERS.map((c) => (c.in + 0.045 + c.out) / 2)
      const offMotion = rootRef.current && scene ? setupLandingMotion(rootRef.current, { lenis, scene, stops }) : () => {}

      return () => {
        offMotion()
        gsap.ticker.remove(tick)
        lenis.destroy()
        lenisRef.current = null
        triggerRef.current = null
      }
    },
    { dependencies: [mode], scope: stageRef, revertOnUpdate: true },
  )

  // "See how it works": to the start of the first chapter, smoothly when the scene is pinned.
  const toChapters = (e: React.MouseEvent<HTMLAnchorElement>) => {
    const st = triggerRef.current
    const lenis = lenisRef.current
    if (!st || !lenis) return
    e.preventDefault()
    lenis.scrollTo(st.start + (st.end - st.start) * 0.2, { duration: 1.6 })
  }

  // Link to a section of the page ("Pricing"): smoothly with Lenis, a normal jump otherwise.
  const toSection = (e: React.MouseEvent<HTMLAnchorElement>) => {
    const lenis = lenisRef.current
    const target = document.getElementById(e.currentTarget.hash.slice(1))
    if (!lenis || !target) return
    e.preventDefault()
    lenis.scrollTo(target, { duration: 2 })
  }

  // Already signed in: straight to the dashboard. Otherwise create your company, and next to it the demo (demo mode) or token sign-in.
  const visit = demo ? { href: "/demo", label: "Open the demo" } : { href: "/login", label: "Sign in" }
  const create = { href: "/create", label: "Create my company" }
  const cta = signedIn ? { href: "/dashboard", label: "Open the dashboard" } : signup ? create : visit
  const second = !signedIn && signup ? visit : null
  const primary = cta.label

  return (
    <main ref={rootRef} className="landing">
      <section ref={stageRef} className={`landing-stage ${mode === "scroll" ? "is-scroll" : ""}`} aria-labelledby="landing-title">
        <div className="landing-screen">
          <ScrollBrain zones={LANDING_ZONES} synapses={LANDING_SYNAPSES} agents={LANDING_AGENTS} progress={progress} still={mode !== "scroll"} />

          <header className="absolute inset-x-0 top-0 z-10">
            <nav data-hero="nav" className="landing-wrap flex items-center justify-between py-4" aria-label="Main">
              <Link href="/" className="flex items-center gap-2.5 rounded-[6px]">
                <LogoMark size={26} />
                <span className="text-[15px] font-medium">NOS Brainer</span>
              </Link>
              <div className="flex items-center gap-2">
                <a href="#pricing" onClick={toSection} className="btn btn-ghost hidden sm:inline-flex">
                  Pricing
                </a>
                {/* The code is open: self-host it from the repo. Icon only on a phone, where the bar is tight. */}
                <a href={REPO} target="_blank" rel="noreferrer" aria-label="GitHub, the open code to host it yourself" className="btn btn-ghost btn-icon sm:w-auto sm:px-3">
                  <GithubIcon />
                  <span className="hidden sm:inline">GitHub</span>
                </a>
                {demo && !signedIn && (
                  <Link href="/login" className="btn btn-ghost hidden sm:inline-flex">
                    Sign in
                  </Link>
                )}
                {second && demo && (
                  <Link href={second.href} className="btn btn-ghost hidden md:inline-flex">
                    {second.label}
                  </Link>
                )}
                <Link href={cta.href} className="btn btn-primary">
                  {primary}
                </Link>
              </div>
            </nav>
          </header>

          <div ref={heroRef} className="landing-hero">
            <div className="landing-wrap">
              <h1 id="landing-title" data-hero="title" className="landing-display max-w-[9.5em]">
                Everything your team learns with AI, in a single brain.
              </h1>
              <p data-hero="sub" className="mt-5 max-w-[34em] text-[16px] leading-relaxed sm:text-[18px]">
                Your team already works with AI: Claude Code in the terminal, ChatGPT in the browser, decisions made in meetings. Screenpipe sees all of it on each computer, and the brain keeps what matters for every agent in the company.
              </p>
              <div data-hero="cta" className="mt-7 flex flex-wrap items-center gap-x-6 gap-y-3">
                <Link href={cta.href} className="btn btn-primary btn-lg">
                  {primary}
                </Link>
                {second && (
                  <Link href={second.href} className="btn btn-lg">
                    {second.label}
                  </Link>
                )}
                <a href="#chapters" onClick={toChapters} className="landing-link text-[15px]">
                  See how it works
                </a>
              </div>
              <p data-hero="note" className="mt-8 text-[13px] text-trace">
                The brain of Encore, the demo's fictional company: refurbished smartphones with a 2-year warranty, graded by AI in a Lyon workshop and sold to individuals and to companies.
              </p>
            </div>
          </div>

          <div className="landing-bar" aria-hidden>
            <div ref={barRef} className="landing-bar-fill" />
          </div>
        </div>

        <div id="chapters" className="landing-chapters">
          <Chapter refFn={(el) => (chapterRefs.current[0] = el)} title="It fills up while you work.">
            <p>
              Screenpipe catches what no log keeps: the decisions of a meeting, an answer found with ChatGPT in the browser. brain-sync adds the Claude Code and Codex sessions, then keeps only the decisions, procedures and facts.
            </p>
            <p className="mt-5 text-[15px] text-trace">
              <span ref={counterRef} className="text-[15px] font-medium tabular-nums text-ink">
                {mode === "scroll" ? 0 : LANDING_TOTAL}
              </span>{" "}
              knowledge items in ten days at Encore.
            </p>
          </Chapter>

          <Chapter refFn={(el) => (chapterRefs.current[1] = el)} title="One zone per function, access per person.">
            <p>
              The admin chooses who sees what. Jean-Marc, in finance, doesn't need the code: neither he nor his agents have access to the Dev zone.
              In the middle, the core holds what everyone needs: what Encore does, its vision, who to ask.
            </p>
            <ul className="mt-5 flex flex-wrap gap-x-4 gap-y-1.5 text-[14px]" aria-label="Zones of Encore's brain">
              {LANDING_ZONES.map((z) => (
                <li key={z.id}>
                  <ZoneTag name={z.name} color={zoneColor(z.color, z.position)} />
                </li>
              ))}
            </ul>
          </Chapter>

          <Chapter refFn={(el) => (chapterRefs.current[2] = el)} title="Agents come to it for context.">
            <p>
              When Claude Code needs to know how we deploy, or Codex how we reconcile the bank, it queries the brain through the company-brain MCP. The zone it touches lights up live on the dashboard.
            </p>
          </Chapter>
        </div>
      </section>

      <div data-after className="relative">
        <span data-thread className="landing-thread" aria-hidden />
        <Dashboard />
        <Connectors />
        <Install demo={demo} signup={signup} />
        <Privacy />
        <Hosting onAnchor={toSection} />
        <Pricing cloud={signup ? create.href : visit.href} />
        <Close cta={cta} second={second} demo={demo} signup={signup && !signedIn} />
      </div>
    </main>
  )
}

/** Bead of the thread linking the sections: it fills when you reach the section. */
function Bead() {
  return (
    <span data-bead className="landing-bead" aria-hidden>
      <span data-bead-fill />
    </span>
  )
}

function Chapter({ title, children, refFn }: { title: string; children: React.ReactNode; refFn: (el: HTMLDivElement | null) => void }) {
  return (
    <div ref={refFn} className="landing-chapter">
      <h2 className="landing-h2">{title}</h2>
      <div className="mt-4 text-[16px] leading-relaxed sm:text-[17px]">{children}</div>
    </div>
  )
}

/** What the CEO sees: an excerpt of the demo dashboard, in its own components. */
function Dashboard() {
  const status = [
    { zone: "leadership", text: "Q4 goal: 7,500 phones sold in November and December, €1.2M of B2B signed." },
    { zone: "product", text: "Priority of the quarter: \"not as described\" returns under 3%, with AI grading." },
    { zone: "sales", text: "Groupe Vallière (800 phones) is ready to sign if the CSR report ships in November." },
    { zone: "finance", text: "September VAT to file before October 19." },
  ]
  return (
    <section className="landing-section relative" aria-labelledby="ceo">
      <Bead />
      <div className="landing-wrap grid gap-12 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-20">
        <div className="lg:pt-6">
          <h2 id="ceo" data-reveal="title" className="landing-h2 max-w-[13em]">
            Claire, the CEO, sees where the company stands.
          </h2>
          <p data-reveal="text" className="mt-5 max-w-[32em] text-[16px] leading-relaxed sm:text-[17px]">
            The summary starts from what the team actually did: goals, tasks in progress and who did what. And when someone repeats the same task, a prompt every morning or a copy-paste between two apps every Monday, the brain offers to automate it.
          </p>
        </div>

        <figure data-reveal="panel" className="panel overflow-hidden">
          <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
            <span className="panel-title">Where Encore stands</span>
            <span className="text-[12px] text-trace">This week</span>
          </div>
          <ul data-rows className="divide-y divide-line">
            {status.map((s) => (
              <li key={s.text} className="flex flex-col gap-1 px-5 py-3.5 sm:flex-row sm:gap-4">
                <ZoneTag name={zone(s.zone).name} color={zoneColor(zone(s.zone).color, zone(s.zone).position)} className="w-[92px] shrink-0 text-[13px] text-trace" />
                <span className="text-[14px]">{s.text}</span>
              </li>
            ))}
          </ul>
          <div className="border-t border-line px-5 py-4">
            <p className="text-[13px] text-trace">Suggested automations</p>
            <div className="inset mt-2 px-3.5 py-3">
              <p className="text-[14px]">Jean-Marc runs this prompt every day around 9am:</p>
              <p data-type className="mono mt-1.5 text-[13px] leading-relaxed">Reconcile yesterday&apos;s Qonto statements with the Pennylane invoices and list the variances</p>
            </div>
            <div data-later className="inset mt-2 px-3.5 py-3">
              <p className="text-[14px]">Detected by Screenpipe: every Monday, Sarah copies the trade-show leads into HubSpot by hand.</p>
            </div>
          </div>
          <figcaption className="border-t border-line px-5 py-3 text-[12px] text-trace">Excerpt of the demo dashboard. Encore is a fictional company.</figcaption>
        </figure>
      </div>
    </section>
  )
}

/** The company's tools, connected through their official MCP server: their content feeds the brain, agents use them. */
const SHOWN_TOOLS = ["notion", "linear", "github", "atlassian", "slack", "google-drive", "hubspot", "stripe", "figma", "sentry", "gitlab", "airtable", "asana", "intercom", "gmail", "vercel"]

function Connectors() {
  const tools = SHOWN_TOOLS.map((id) => catalogEntry(id)).filter((e) => e !== undefined)
  const steps = [
    { term: "Connect in one click", def: "Official MCP servers: you sign in on the tool's own page, tokens stay on the brain's server." },
    { term: "Its content feeds the brain", def: "Claude reads the tool, read-only, and keeps the decisions, procedures and facts, in the right zone." },
    { term: "Agents use it through the brain", def: "\"Find the Notion page on deploying\" from Claude Code: read-only by default, the admin decides." },
  ]
  return (
    <section className="landing-section relative border-t border-line" aria-labelledby="connectors">
      <Bead />
      <div className="landing-wrap grid gap-12 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-20">
        <div className="lg:pt-6">
          <h2 id="connectors" data-reveal="title" className="landing-h2 max-w-[12em]">
            Your tools feed it too.
          </h2>
          <p data-reveal="text" className="mt-5 max-w-[32em] text-[16px] leading-relaxed sm:text-[17px]">
            Notion, Linear, GitHub, Slack, Stripe… Connect them while you create the brain: Claude reads them alongside your conversations to draw the first zones and
            knowledge, then keeps importing what changes.
          </p>
        </div>

        <figure data-reveal="panel" className="panel overflow-hidden">
          <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
            <span className="panel-title">Connectors</span>
            <span className="text-[12px] text-trace">{MCP_CATALOG.length} official MCP servers</span>
          </div>
          {/* Rules on the tiles, not a coloured grid background: while the rows reveal, the empty cells stay white. */}
          <ul data-rows className="grid grid-cols-2 sm:grid-cols-4" aria-label="Some of the tools you can connect">
            {tools.map((e) => (
              <li
                key={e.id}
                className="flex min-w-0 items-center gap-2.5 border-b border-r border-line px-3.5 py-3 [&:nth-child(2n)]:border-r-0 sm:[&:nth-child(2n)]:border-r sm:[&:nth-child(4n)]:border-r-0"
              >
                <McpLogo logo={e.logo} name={e.name} color={e.color} size={30} />
                <span className="truncate text-[13px]">{e.name}</span>
              </li>
            ))}
          </ul>
          <figcaption className="px-5 py-3 text-[12px] text-trace">
            And {MCP_CATALOG.length - tools.length} more, or any remote MCP server.
          </figcaption>
        </figure>
      </div>
      <div className="landing-wrap">
        <dl data-reveal="cards" className="mt-16 grid border-t border-ink sm:grid-cols-3">
          {steps.map((f) => (
            <div key={f.term} className="border-b border-line py-5 sm:border-b-0 sm:pr-8 sm:pt-6">
              <dt className="text-[15px] font-medium">{f.term}</dt>
              <dd className="mt-1.5 text-[15px] leading-relaxed text-trace">{f.def}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  )
}

function Install({ demo, signup }: { demo: boolean; signup: boolean }) {
  return (
    <section className="landing-section relative border-t border-line" aria-labelledby="install">
      <Bead />
      <div className="landing-wrap">
        <h2 id="install" data-reveal="title" className="landing-display max-w-[12em]">
          One message to paste into Claude Code or Codex.
        </h2>
        <div className="mt-12 grid gap-10 lg:mt-16 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-20">
          <div data-reveal="text" className="max-w-[32em] text-[16px] leading-relaxed sm:text-[17px]">
            <p>
              The prompt contains your personal token. Claude Code or Codex runs a single command: it installs Screenpipe, connects the MCP and the hooks, then opens the
              brain already signed in.
            </p>
            <p className="mt-4">No history is sent: the brain learns from the install onward. After that, there is nothing left to do.</p>
          </div>
          <div data-reveal="panel">
            <InstallActions demo={demo} signup={signup} />
          </div>
        </div>
      </div>
    </section>
  )
}

/** The raw data stays on the computer: the path of the captures, from the computer to the brain (PrivacyFlow). */
function Privacy() {
  const facts = [
    { term: "App allowlist", def: "brain-sync only reads the allowed work applications." },
    { term: "Secrets and personal data redacted", def: "Before upload on the computer, then a second time on the server." },
    { term: "Right of review", def: "Everyone sees what they brought to the brain and can delete it." },
  ]
  return (
    <section data-hold="1.4" className="landing-section relative border-t border-line" aria-labelledby="privacy">
      <Bead />
      <div className="landing-wrap">
        <div className="grid gap-12 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-20">
          <div>
            <h2 id="privacy" data-reveal="title" className="landing-h2 max-w-[11em]">
              The raw data stays on the computer.
            </h2>
            <p data-reveal="text" className="mt-5 max-w-[32em] text-[16px] leading-relaxed sm:text-[17px]">
              Screenpipe records about 19{"\u00a0"}GB in two weeks on a computer. None of it leaves the machine: only the distilled knowledge goes up to the brain.
            </p>
          </div>
          <PrivacyFlow />
        </div>
        <div data-rule className="mt-16 h-px bg-ink" />
        <dl data-facts className="grid sm:grid-cols-3">
          {facts.map((f) => (
            <div key={f.term} className="border-b border-line py-5 sm:border-b-0 sm:pr-8 sm:pt-6">
              <dt className="text-[15px] font-medium">{f.term}</dt>
              <dd className="mt-1.5 text-[15px] leading-relaxed text-trace">{f.def}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  )
}

type Cta = { href: string; label: string }

function Close({ cta, second, demo, signup }: { cta: Cta; second: Cta | null; demo: boolean; signup: boolean }) {
  return (
    <section data-close className="landing-section relative !pb-10 border-t border-line" aria-labelledby="end">
      <Bead />
      <div className="landing-wrap">
        <h2 id="end" data-reveal="title" className="landing-display max-w-[10em]">
          {signup ? "Give your company a brain." : "Open Encore's brain."}
        </h2>
        <p data-reveal="text" className="mt-5 max-w-[32em] text-[16px] leading-relaxed sm:text-[17px]">
          {signup
            ? "Four questions to create your dashboard, a prompt to paste into Claude Code or Codex to connect your computer, then one prompt per colleague to invite them."
            : demo
              ? "One-click sign-in with one of the demo's six accounts, from the CEO to finance."
              : "Sign in with the token your admin gave you."}
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link href={cta.href} className="btn btn-primary btn-lg">
            {cta.label}
          </Link>
          {second && (
            <Link href={second.href} className="btn btn-lg">
              {second.label}
            </Link>
          )}
        </div>
      </div>
      <footer className="landing-wrap mt-[clamp(96px,12vw,160px)] flex flex-col gap-2 border-t border-line pt-6 text-[13px] text-trace sm:flex-row sm:justify-between">
        <span>NOS Brainer</span>
        <span>Made at 42 Paris during the Screenpipe hackathon, October 2026.</span>
      </footer>
    </section>
  )
}
