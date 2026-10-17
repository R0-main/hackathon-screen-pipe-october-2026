"use client"

import Link from "next/link"
import { useEffect, useRef, useState } from "react"
import { gsap } from "gsap"
import { ScrollTrigger } from "gsap/ScrollTrigger"
import { useGSAP } from "@gsap/react"
import Lenis from "lenis"
import { BrainIcon, ZoneTag, zoneColor } from "../ui"
import { InstallActions } from "./InstallActions"
import { MotionSwitcher } from "./MotionSwitcher"
import { PrivacyFlow } from "./PrivacyFlow"
import { ScrollBrain } from "./ScrollBrain"
import { LANDING_AGENTS, LANDING_SYNAPSES, LANDING_TOTAL, LANDING_ZONES } from "./landing-data"
import { setupLandingMotion } from "./motion/setup"
import type { MotionVariant } from "./motion/variants"

gsap.registerPlugin(useGSAP, ScrollTrigger)

/**
 * Longueur de la scène épinglée, en hauteurs d'écran. Les versions comparées la rallongent : chaque chapitre
 * reste plus longtemps à l'écran et les transitions sont plus douces.
 */
const PIN_SCREENS = 4
const PIN_SCREENS_PACED = 7

/** Entrée et sortie de chaque chapitre, en fraction de la scène. */
const CHAPTERS = [
  { in: 0.11, out: 0.35 },
  { in: 0.39, out: 0.555 },
  { in: 0.6, out: 0.86 },
]

type Mode = "flow" | "scroll" | "still"

const zone = (id: string) => LANDING_ZONES.find((z) => z.id === id)!

/**
 * Page d'accueil publique. Le cerveau occupe le premier écran ; au scroll, la scène est épinglée :
 * il passe en plein écran et tourne pendant trois chapitres, puis la page reprend son cours.
 * Sans JavaScript ou sous `prefers-reduced-motion`, les chapitres se lisent à la suite, cerveau immobile.
 */
export function Landing({ demo, signedIn = false, variant = "actuelle" }: { demo: boolean; signedIn?: boolean; variant?: MotionVariant }) {
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
          end: `+=${(variant === "actuelle" ? PIN_SCREENS : PIN_SCREENS_PACED) * 100}%`,
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

      // Le reste de la page, selon la version comparée. Créé après la scène épinglée, pour l'ordre des déclencheurs.
      const scene = tl.scrollTrigger
      const stops = CHAPTERS.map((c) => (c.in + 0.045 + c.out) / 2)
      const offMotion = rootRef.current && scene ? setupLandingMotion(variant, rootRef.current, { lenis, scene, stops }) : () => {}

      return () => {
        offMotion()
        gsap.ticker.remove(tick)
        lenis.destroy()
        lenisRef.current = null
        triggerRef.current = null
      }
    },
    { dependencies: [mode, variant], scope: stageRef, revertOnUpdate: true },
  )

  // « Voir comment ça marche » : au début du premier chapitre, en douceur quand la scène est épinglée.
  const toChapters = (e: React.MouseEvent<HTMLAnchorElement>) => {
    const st = triggerRef.current
    const lenis = lenisRef.current
    if (!st || !lenis) return
    e.preventDefault()
    lenis.scrollTo(st.start + (st.end - st.start) * 0.2, { duration: 1.6 })
  }

  // Déjà connecté : droit au dashboard. Sinon la démo (mode démo) ou la connexion par jeton.
  const cta = signedIn ? { href: "/dashboard", label: "Ouvrir le dashboard" } : demo ? { href: "/demo", label: "Ouvrir la démo" } : { href: "/login", label: "Se connecter" }
  const primary = cta.label

  return (
    <main ref={rootRef} className="landing" data-motion={variant}>
      <section ref={stageRef} className={`landing-stage ${mode === "scroll" ? "is-scroll" : ""}`} aria-labelledby="landing-title">
        <div className="landing-screen">
          <div data-parallax className="absolute inset-0">
            <ScrollBrain zones={LANDING_ZONES} synapses={LANDING_SYNAPSES} agents={LANDING_AGENTS} progress={progress} still={mode !== "scroll"} />
          </div>

          <header className="absolute inset-x-0 top-0 z-10">
            <nav data-hero="nav" className="landing-wrap flex items-center justify-between py-4" aria-label="Principal">
              <Link href="/" className="flex items-center gap-2.5 rounded-[6px]">
                <BrainIcon size={26} />
                <span className="text-[15px] font-medium">NOS Brainer</span>
              </Link>
              <div className="flex items-center gap-2">
                {demo && !signedIn && (
                  <Link href="/login" className="btn btn-ghost hidden sm:inline-flex">
                    Se connecter
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
                Tout ce que votre équipe apprend avec l'IA, dans un seul cerveau.
              </h1>
              <p data-hero="sub" className="mt-5 max-w-[34em] text-[16px] leading-relaxed sm:text-[18px]">
                Chaque employé travaille déjà avec Claude Code ou Codex. Screenpipe capte ces sessions sur son poste, et le cerveau en garde l'essentiel pour tous les agents de l'entreprise.
              </p>
              <div data-hero="cta" className="mt-7 flex flex-wrap items-center gap-x-6 gap-y-3">
                <Link href={cta.href} data-magnetic className="btn btn-primary btn-lg">
                  {primary}
                </Link>
                <a href="#chapitres" onClick={toChapters} className="landing-link text-[15px]">
                  Voir comment ça marche
                </a>
              </div>
              <p data-hero="note" className="mt-8 text-[13px] text-trace">
                Le cerveau de Fournil, l'entreprise fictive de la démo.
              </p>
            </div>
          </div>

          <div className="landing-bar" aria-hidden>
            <div ref={barRef} className="landing-bar-fill" />
          </div>
        </div>

        <div id="chapitres" className="landing-chapters">
          <Chapter refFn={(el) => (chapterRefs.current[0] = el)} title="Il se remplit pendant que vous travaillez.">
            <p>
              Screenpipe capte les sessions Claude Code et Codex de chaque poste. brain-sync en retient les décisions, les procédures et les faits. Seul ce distillé monte au cerveau.
            </p>
            <p className="mt-5 text-[15px] text-trace">
              <span ref={counterRef} className="text-[15px] font-medium tabular-nums text-ink">
                {mode === "scroll" ? 0 : LANDING_TOTAL}
              </span>{" "}
              connaissances en dix jours chez Fournil.
            </p>
          </Chapter>

          <Chapter refFn={(el) => (chapterRefs.current[1] = el)} title="Une zone par métier, des accès par personne.">
            <p>
              L'admin choisit qui voit quoi. Jean-Marc, à la compta, n'a pas besoin du code : ni lui ni ses agents n'ont accès à la zone Dev.
            </p>
            <ul className="mt-5 flex flex-wrap gap-x-4 gap-y-1.5 text-[14px]" aria-label="Zones du cerveau de Fournil">
              {LANDING_ZONES.map((z) => (
                <li key={z.id}>
                  <ZoneTag name={z.name} color={zoneColor(z.color, z.position)} />
                </li>
              ))}
            </ul>
          </Chapter>

          <Chapter refFn={(el) => (chapterRefs.current[2] = el)} title="Les agents viennent y chercher du contexte.">
            <p>
              Quand Claude Code doit savoir comment on déploie, ou Codex comment on rapproche la banque, il interroge le cerveau par le MCP company-brain. La zone touchée s'allume en direct sur le dashboard.
            </p>
          </Chapter>
        </div>
      </section>

      <div data-after className="relative">
        <span data-thread className="landing-thread" aria-hidden />
        <Dashboard />
        <Install demo={demo} />
        <Privacy />
        <Close cta={cta} demo={demo} />
      </div>
      <MotionSwitcher current={variant} />
    </main>
  )
}

/** Bille du fil qui relie les sections (version Récit) ; masquée dans les autres versions. */
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

/** Ce que voit la dirigeante : un extrait du dashboard de la démo, dans ses propres composants. */
function Dashboard() {
  const status = [
    { zone: "direction", text: "Objectif T4 : 120 boulangeries clientes et 25\u00a0k€ de MRR." },
    { zone: "produit", text: "Priorité du trimestre : le module de précommandes en ligne." },
    { zone: "sales", text: "La Mie Dorée (12 boutiques) est prête à signer si l'export comptable arrive en novembre." },
    { zone: "compta", text: "TVA de septembre à déclarer avant le 19\u00a0octobre." },
  ]
  return (
    <section className="landing-section relative" aria-labelledby="dirigeant">
      <Bead />
      <div className="landing-wrap grid gap-12 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-20">
        <div className="lg:pt-6">
          <h2 id="dirigeant" data-reveal="title" className="landing-h2 max-w-[13em]">
            Claire, la CEO, voit où en est la boîte.
          </h2>
          <p data-reveal="text" className="mt-5 max-w-[32em] text-[16px] leading-relaxed sm:text-[17px]">
            Le résumé part de ce que l'équipe a vraiment fait : objectifs, tâches en cours et qui a fait quoi. Et quand quelqu'un lance le même prompt chaque matin, le cerveau propose de le faire à sa place.
          </p>
        </div>

        <figure data-reveal="panel" className="panel overflow-hidden">
          <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
            <span className="panel-title">Où en est Fournil</span>
            <span className="text-[12px] text-trace">Cette semaine</span>
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
            <p className="text-[13px] text-trace">Automatisation proposée</p>
            <div className="inset mt-2 px-3.5 py-3">
              <p className="text-[14px]">Jean-Marc lance ce prompt tous les jours vers 9{"\u00a0"}h :</p>
              <p data-type className="mono mt-1.5 text-[13px] leading-relaxed">Rapproche les relevés Qonto d'hier avec les factures Pennylane et liste les écarts</p>
            </div>
          </div>
          <figcaption className="border-t border-line px-5 py-3 text-[12px] text-trace">Extrait du dashboard de la démo. Fournil est une entreprise fictive.</figcaption>
        </figure>
      </div>
    </section>
  )
}

function Install({ demo }: { demo: boolean }) {
  return (
    <section className="landing-section relative border-t border-line" aria-labelledby="installer">
      <Bead />
      <div className="landing-wrap">
        <h2 id="installer" data-reveal="title" className="landing-display max-w-[12em]">
          Un message à coller dans Claude Code.
        </h2>
        <div className="mt-12 grid gap-10 lg:mt-16 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-20">
          <div data-reveal="text" className="max-w-[32em] text-[16px] leading-relaxed sm:text-[17px]">
            <p>
              Le prompt contient votre jeton personnel. Claude Code lance une seule commande : elle installe Screenpipe, branche le MCP et les hooks, puis ouvre le
              cerveau déjà connecté.
            </p>
            <p className="mt-4">Aucun historique n'est envoyé : le cerveau apprend à partir de l'installation. Ensuite, il n'y a plus rien à faire.</p>
          </div>
          <div data-reveal="panel">
            <InstallActions demo={demo} />
          </div>
        </div>
      </div>
    </section>
  )
}

/** Le brut reste sur le poste : le parcours des captures, du poste au cerveau (PrivacyFlow). */
function Privacy() {
  const facts = [
    { term: "Liste blanche d'applications", def: "brain-sync ne lit que les applications de travail autorisées." },
    { term: "Secrets et données perso masqués", def: "Avant l'envoi sur le poste, puis une seconde fois côté serveur." },
    { term: "Droit de regard", def: "Chacun voit ce qu'il a apporté au cerveau et peut le supprimer." },
  ]
  return (
    <section className="landing-section relative border-t border-line" aria-labelledby="vie-privee">
      <Bead />
      <div className="landing-wrap">
        <div className="grid gap-12 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-20">
          <div>
            <h2 id="vie-privee" data-reveal="title" className="landing-h2 max-w-[11em]">
              Le brut reste sur le poste.
            </h2>
            <p data-reveal="text" className="mt-5 max-w-[32em] text-[16px] leading-relaxed sm:text-[17px]">
              Screenpipe enregistre environ 19{"\u00a0"}Go en deux semaines sur un poste. Rien de cela ne quitte le PC : seules les connaissances distillées montent au cerveau.
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

function Close({ cta, demo }: { cta: { href: string; label: string }; demo: boolean }) {
  return (
    <section data-close className="landing-section relative !pb-10 border-t border-line" aria-labelledby="fin">
      <Bead />
      <div className="landing-wrap">
        <h2 id="fin" data-reveal="title" className="landing-display max-w-[10em]">
          Ouvrez le cerveau de Fournil.
        </h2>
        <p data-reveal="text" className="mt-5 max-w-[32em] text-[16px] leading-relaxed sm:text-[17px]">
          {demo ? "Connexion en un clic avec l'un des six comptes de la démo, de la CEO à la compta." : "Connectez-vous avec le jeton que votre admin vous a remis."}
        </p>
        <div className="mt-8">
          <Link href={cta.href} data-magnetic className="btn btn-primary btn-lg">
            {cta.label}
          </Link>
        </div>
      </div>
      <footer className="landing-wrap mt-[clamp(96px,12vw,160px)] flex flex-col gap-2 border-t border-line pt-6 text-[13px] text-trace sm:flex-row sm:justify-between">
        <span>NOS Brainer</span>
        <span>Fait à 42 Paris pendant le hackathon Screenpipe, octobre 2026.</span>
      </footer>
    </section>
  )
}
