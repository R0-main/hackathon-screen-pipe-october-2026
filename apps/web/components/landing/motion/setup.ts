import { gsap } from "gsap"
import { ScrollTrigger } from "gsap/ScrollTrigger"
import { SplitText } from "gsap/SplitText"
import { DrawSVGPlugin } from "gsap/DrawSVGPlugin"
import { ScrambleTextPlugin } from "gsap/ScrambleTextPlugin"
import type { MotionVariant } from "./variants"

gsap.registerPlugin(ScrollTrigger, SplitText, DrawSVGPlugin, ScrambleTextPlugin)

/*
  Motion de la page d'accueil, hors scène du cerveau (pilotée dans Landing et ScrollBrain).
  Le balisage porte des attributs que chaque version lit à sa façon :
  - data-hero="nav|title|sub|cta|note"  premier écran ;
  - data-reveal="title|text|panel"       titres, paragraphes et panneaux des sections ;
  - data-rows, data-type                 lignes de « Où en est Fournil » et prompt de Jean-Marc ;
  - data-privacy (+ data-raw, data-filter, data-link, data-kept, data-hub, data-label) le schéma vie privée ;
  - data-rule, data-facts                trait encre et trois engagements ;
  - data-after, data-thread, data-bead   fil de billes (version Récit) ;
  - data-parallax, data-magnetic         cerveau et boutons (version Cinétique).
  Tout est créé dans le contexte useGSAP de Landing : animations, SplitText et ScrollTrigger sont annulés au
  démontage. Seuls les écouteurs du pointeur sont rendus par la fonction de nettoyage.
  Appelé uniquement quand le mouvement est autorisé (pas sous prefers-reduced-motion).
*/

const all = <T extends Element = HTMLElement>(root: ParentNode, sel: string) => Array.from(root.querySelectorAll<T>(sel))
const once = (trigger: Element, start = "top 85%") => ({ trigger, start, once: true })
const num = (el: Element, attr: string) => Number(el.getAttribute(attr) ?? 0)

/** Centre du filtre local dans le schéma vie privée (viewBox 640 × 220). */
const FILTER = { x: 330, y: 110 }

export function setupLandingMotion(variant: MotionVariant, root: HTMLElement): () => void {
  if (variant === "epure") epure(root)
  if (variant === "recit") recit(root)
  if (variant === "cinetique") return cinetique(root)
  return () => {}
}

/* ---------- Premier écran ---------- */

type HeroStyle = "lines" | "words" | "kinetic"

function heroIn(root: HTMLElement, style: HeroStyle) {
  const title = root.querySelector<HTMLElement>('[data-hero="title"]')
  if (title) {
    gsap.set(title, { autoAlpha: 1 })
    SplitText.create(title, {
      type: style === "lines" ? "lines" : "words,lines",
      mask: style === "words" ? undefined : style === "lines" ? "lines" : "words",
      autoSplit: true,
      onSplit: (self) => {
        if (style === "lines") return gsap.from(self.lines, { yPercent: 110, duration: 1.15, ease: "expo.out", stagger: 0.1, delay: 0.15 })
        if (style === "words") return gsap.from(self.words, { autoAlpha: 0, y: "0.22em", duration: 0.7, ease: "power3.out", stagger: 0.055, delay: 0.15 })
        return gsap.from(self.words, { yPercent: 120, rotate: 7, transformOrigin: "0% 100%", duration: 1.2, ease: "expo.out", stagger: 0.045, delay: 0.1 })
      },
    })
  }
  const step = style === "words" ? 0.75 : 0.5
  const fade = (sel: string, delay: number, y = 16) => {
    const el = root.querySelector(`[data-hero="${sel}"]`)
    if (el) gsap.fromTo(el, { autoAlpha: 0, y }, { autoAlpha: 1, y: 0, duration: 0.9, ease: "power3.out", delay })
  }
  fade("nav", 0.05, 0)
  fade("sub", step)
  fade("cta", step + 0.12)
  fade("note", step + 0.26, 0)
}

/* ---------- Version 1 : Épure ---------- */

/** Révélations sobres, jouées une seule fois à l'entrée dans l'écran. */
function epure(root: HTMLElement) {
  heroIn(root, "lines")

  for (const el of all(root, '[data-reveal="title"]')) {
    SplitText.create(el, {
      type: "lines",
      mask: "lines",
      autoSplit: true,
      onSplit: (self) => gsap.from(self.lines, { yPercent: 105, duration: 1.05, ease: "expo.out", stagger: 0.09, scrollTrigger: once(el) }),
    })
  }
  for (const el of all(root, '[data-reveal="text"]')) {
    gsap.from(el, { autoAlpha: 0, y: 20, duration: 0.9, ease: "power3.out", delay: 0.15, scrollTrigger: once(el, "top 90%") })
  }
  for (const panel of all(root, '[data-reveal="panel"]')) {
    const tl = gsap.timeline({ scrollTrigger: once(panel, "top 82%") })
    tl.from(panel, { autoAlpha: 0, y: 28, duration: 0.9, ease: "power3.out" })
    const rows = all(panel, "[data-rows] > li")
    if (rows.length) tl.from(rows, { autoAlpha: 0, y: 10, duration: 0.6, ease: "power3.out", stagger: 0.07 }, 0.25)
    const typed = panel.querySelector("[data-type]")
    if (typed) tl.from(typed, { autoAlpha: 0, duration: 0.8, ease: "power2.out" }, "-=0.2")
  }

  const svg = root.querySelector("[data-privacy]")
  if (svg) {
    const tl = gsap.timeline({ scrollTrigger: once(svg, "top 80%") })
    tl.from(all(svg, "[data-raw]"), { opacity: 0, duration: 0.5, ease: "power2.out", stagger: { amount: 0.6, from: "random" } })
      .from(all(svg, "[data-filter]"), { opacity: 0, duration: 0.5, ease: "power2.out" }, "-=0.3")
      .from(all(svg, "[data-link]"), { drawSVG: "0%", duration: 0.7, ease: "power3.out", stagger: 0.06 }, "-=0.1")
      .from(all(svg, "[data-kept], [data-hub]"), { opacity: 0, scale: 0.6, transformOrigin: "50% 50%", duration: 0.5, ease: "power3.out", stagger: 0.06 }, "-=0.5")
      .from(all(svg, "[data-label]"), { opacity: 0, duration: 0.6, ease: "power2.out" }, "-=0.3")
  }

  rules(root, false)
  const facts = root.querySelector("[data-facts]")
  if (facts) gsap.from(facts.children, { autoAlpha: 0, y: 16, duration: 0.8, ease: "power3.out", stagger: 0.1, scrollTrigger: once(facts, "top 88%") })
}

/* ---------- Version 2 : Récit ---------- */

/** Tout suit le scroll : on lit la page comme on lit le cerveau, et chaque geste se rejoue en remontant. */
function recit(root: HTMLElement) {
  heroIn(root, "words")

  // Le fil : un trait encre qui descend le long des sections, une bille qui se remplit à chaque étape.
  const after = root.querySelector("[data-after]")
  const thread = root.querySelector("[data-thread]")
  if (after && thread) {
    gsap.fromTo(thread, { scaleY: 0 }, { scaleY: 1, ease: "none", transformOrigin: "50% 0%", scrollTrigger: { trigger: after, start: "top 65%", end: "bottom bottom", scrub: true } })
  }
  for (const bead of all(root, "[data-bead]")) {
    const fill = bead.querySelector("[data-bead-fill]")
    if (fill) gsap.fromTo(fill, { scale: 0 }, { scale: 1, duration: 0.45, ease: "power3.out", scrollTrigger: { trigger: bead, start: "top 65%", toggleActions: "play none none reverse" } })
  }

  // Titres : les mots passent de pâle à encre au rythme du scroll.
  for (const el of all(root, '[data-reveal="title"]')) {
    SplitText.create(el, {
      type: "words",
      autoSplit: true,
      onSplit: (self) =>
        gsap.fromTo(self.words, { opacity: 0.12 }, { opacity: 1, ease: "none", stagger: 0.12, scrollTrigger: { trigger: el, start: "top 88%", end: "top 42%", scrub: true } }),
    })
  }
  for (const el of all(root, '[data-reveal="text"]')) {
    gsap.from(el, { autoAlpha: 0, y: 24, ease: "none", scrollTrigger: { trigger: el, start: "top 95%", end: "top 70%", scrub: true } })
  }

  // Le panneau se remplit ligne par ligne, puis le prompt de Jean-Marc s'écrit caractère par caractère.
  for (const panel of all(root, '[data-reveal="panel"]')) {
    const tl = gsap.timeline({ defaults: { ease: "none" }, scrollTrigger: { trigger: panel, start: "top 85%", end: "bottom 60%", scrub: true } })
    tl.from(panel, { autoAlpha: 0, y: 40, duration: 0.2 })
    const rows = all(panel, "[data-rows] > li")
    if (rows.length) tl.from(rows, { autoAlpha: 0, x: -16, duration: 0.12, stagger: 0.08 })
    const typed = panel.querySelector<HTMLElement>("[data-type]")
    if (typed) {
      const chars = SplitText.create(typed, { type: "chars" }).chars
      tl.from(chars, { opacity: 0, duration: 0.01, stagger: 0.4 / chars.length })
    }
  }

  // Le brut reste sur le poste ; seules cinq connaissances en partent, passent le filtre et rejoignent le cerveau.
  const svg = root.querySelector("[data-privacy]")
  if (svg) {
    const raw = all(svg, "[data-raw]")
    const kept = all(svg, "[data-kept]")
    const tl = gsap.timeline({ defaults: { ease: "none" }, scrollTrigger: { trigger: svg, start: "top 80%", end: "bottom 30%", scrub: true } })
    tl.from(all(svg, "[data-label]"), { opacity: 0, duration: 0.1, stagger: 0.1 }, 0)
    tl.from(raw, { opacity: 0, duration: 0.15, stagger: { amount: 0.15, from: "center" } }, 0)
    tl.from(all(svg, "[data-filter]"), { opacity: 0, duration: 0.1 }, 0.15)
    kept.forEach((el, i) => {
      // Chaque connaissance naît d'une bille brute, traverse le filtre puis se pose côté cerveau.
      const src = raw[Math.round(((i + 0.5) / kept.length) * (raw.length - 1))]
      const kx = num(el, "cx")
      const ky = num(el, "cy")
      gsap.set(el, { x: num(src, "cx") - kx, y: num(src, "cy") - ky, opacity: 0, scale: 0.5, transformOrigin: "50% 50%" })
      tl.to(
        el,
        {
          keyframes: [
            { opacity: 1, scale: 0.7, duration: 0.04 },
            { x: FILTER.x - kx, y: FILTER.y - ky, duration: 0.18, ease: "power1.inOut" },
            { x: 0, y: 0, scale: 1, duration: 0.18, ease: "power2.out" },
          ],
        },
        0.3 + i * 0.05,
      )
    })
    tl.to(raw, { opacity: 0.55, duration: 0.3 }, 0.35)
    tl.from(all(svg, "[data-hub]"), { opacity: 0, scale: 0.6, transformOrigin: "50% 50%", duration: 0.1 }, 0.62)
    tl.from(all(svg, "[data-link]"), { drawSVG: "0%", duration: 0.2, stagger: 0.03 }, 0.72)
  }

  rules(root, true)
  const facts = root.querySelector("[data-facts]")
  if (facts) gsap.from(facts.children, { autoAlpha: 0, y: 20, ease: "none", stagger: 0.2, scrollTrigger: { trigger: facts, start: "top 95%", end: "top 65%", scrub: true } })
}

/* ---------- Version 3 : Cinétique ---------- */

/** Plus expressive : titres croisés, inclinaison à la vitesse du scroll, boutons magnétiques, cerveau en parallaxe. */
function cinetique(root: HTMLElement): () => void {
  heroIn(root, "kinetic")
  const cleanups: (() => void)[] = []
  const fine = window.matchMedia("(hover: hover) and (pointer: fine)").matches

  // Le cerveau suit légèrement le pointeur : la scène paraît avoir de la profondeur.
  const parallax = root.querySelector("[data-parallax]")
  if (parallax && fine) {
    const toX = gsap.quickTo(parallax, "x", { duration: 1.4, ease: "power3.out" })
    const toY = gsap.quickTo(parallax, "y", { duration: 1.4, ease: "power3.out" })
    const move = (e: PointerEvent) => {
      toX((e.clientX / window.innerWidth - 0.5) * 36)
      toY((e.clientY / window.innerHeight - 0.5) * 24)
    }
    window.addEventListener("pointermove", move, { passive: true })
    cleanups.push(() => window.removeEventListener("pointermove", move))
  }

  // Boutons magnétiques : ils glissent vers le pointeur, puis reviennent en place.
  if (fine) {
    for (const el of all(root, "[data-magnetic]")) {
      const toX = gsap.quickTo(el, "x", { duration: 0.45, ease: "power3.out" })
      const toY = gsap.quickTo(el, "y", { duration: 0.45, ease: "power3.out" })
      const move = (e: PointerEvent) => {
        const r = el.getBoundingClientRect()
        toX((e.clientX - (r.left + r.width / 2)) * 0.3)
        toY((e.clientY - (r.top + r.height / 2)) * 0.4)
      }
      const leave = () => gsap.to(el, { x: 0, y: 0, duration: 0.8, ease: "elastic.out(1, 0.45)", overwrite: true })
      el.addEventListener("pointermove", move)
      el.addEventListener("pointerleave", leave)
      cleanups.push(() => {
        el.removeEventListener("pointermove", move)
        el.removeEventListener("pointerleave", leave)
      })
    }
  }

  // Titres : chaque ligne arrive d'un côté opposé, au rythme du scroll.
  const titles = all(root, '[data-reveal="title"]')
  for (const el of titles) {
    SplitText.create(el, {
      type: "lines",
      autoSplit: true,
      onSplit: (self) =>
        gsap.from(self.lines, {
          x: (i: number) => (i % 2 ? -1 : 1) * window.innerWidth * 0.1,
          autoAlpha: 0,
          ease: "power2.out",
          stagger: 0.08,
          scrollTrigger: { trigger: el, start: "top 96%", end: "top 55%", scrub: 0.8, invalidateOnRefresh: true },
        }),
    })
  }
  // Inclinaison des titres selon la vitesse du scroll, qui retombe à zéro à l'arrêt.
  if (titles.length) {
    const setters = titles.map((t) => gsap.quickTo(t, "skewY", { duration: 0.6, ease: "power3.out" }))
    const settle = gsap.delayedCall(0.15, () => setters.forEach((s) => s(0))).pause()
    ScrollTrigger.create({
      onUpdate: (self) => {
        const v = gsap.utils.clamp(-4, 4, self.getVelocity() / -450)
        setters.forEach((s) => s(v))
        settle.restart(true)
      },
    })
  }
  for (const el of all(root, '[data-reveal="text"]')) {
    gsap.from(el, { autoAlpha: 0, y: 40, duration: 1, ease: "expo.out", scrollTrigger: once(el, "top 90%") })
  }

  // Panneaux : ils s'ouvrent depuis leur centre, puis le prompt se décode.
  for (const panel of all(root, '[data-reveal="panel"]')) {
    gsap.fromTo(
      panel,
      { clipPath: "inset(16% 12% 16% 12% round 8px)", scale: 0.94 },
      { clipPath: "inset(0% 0% 0% 0% round 8px)", scale: 1, ease: "none", scrollTrigger: { trigger: panel, start: "top 98%", end: "top 45%", scrub: 0.6 } },
    )
    const rows = all(panel, "[data-rows] > li")
    if (rows.length) gsap.from(rows, { autoAlpha: 0, x: 48, duration: 0.9, ease: "expo.out", stagger: 0.08, scrollTrigger: once(panel, "top 70%") })
    const typed = panel.querySelector<HTMLElement>("[data-type]")
    if (typed) {
      const text = typed.textContent ?? ""
      typed.setAttribute("aria-label", text)
      gsap.set(typed, { textContent: text.replace(/\S/g, "·") })
      gsap.to(typed, { duration: 1.8, scrambleText: { text, chars: "lowerCase", speed: 0.5, revealDelay: 0.2 }, ease: "none", scrollTrigger: once(typed, "top 85%") })
    }
  }

  // Le brut tourbillonne et s'engouffre dans le filtre ; les connaissances ressortent d'un coup.
  const svg = root.querySelector("[data-privacy]")
  if (svg) {
    const group = svg.querySelector("[data-raw-group]")
    const tl = gsap.timeline({ defaults: { ease: "none" }, scrollTrigger: { trigger: svg, start: "top 85%", end: "center 35%", scrub: 0.6 } })
    if (group) tl.to(group, { rotation: -120, svgOrigin: "120 110", duration: 0.6 }, 0)
    tl.to(all(svg, "[data-raw]"), { opacity: 0.15, duration: 0.6, stagger: { amount: 0.3, from: "random" } }, 0)
    tl.from(all(svg, "[data-filter]"), { opacity: 0, scaleY: 0.2, transformOrigin: "50% 50%", duration: 0.2 }, 0.1)
    const out = gsap.timeline({ scrollTrigger: once(svg, "top 45%") })
    out.from(all(svg, "[data-kept], [data-hub]"), { opacity: 0, scale: 0.3, transformOrigin: "50% 50%", duration: 0.7, ease: "back.out(2.2)", stagger: 0.06 })
    out.from(all(svg, "[data-link]"), { drawSVG: "0%", duration: 0.6, ease: "expo.out", stagger: 0.05 }, 0.15)
  }

  rules(root, true)
  const facts = root.querySelector("[data-facts]")
  if (facts) gsap.from(facts.children, { autoAlpha: 0, x: 60, duration: 1, ease: "expo.out", stagger: 0.12, scrollTrigger: once(facts, "top 88%") })

  // Dernier écran : le titre grandit jusqu'à sa taille en approchant.
  const close = root.querySelector('[data-close] [data-reveal="title"]')
  if (close) gsap.from(close, { scale: 0.82, transformOrigin: "0% 100%", ease: "none", scrollTrigger: { trigger: close, start: "top 100%", end: "top 45%", scrub: 0.6 } })

  return () => cleanups.forEach((fn) => fn())
}

/* ---------- Partagé ---------- */

/** Trait encre au-dessus des engagements : il se trace de gauche à droite. */
function rules(root: HTMLElement, scrub: boolean) {
  for (const el of all(root, "[data-rule]")) {
    if (scrub) gsap.fromTo(el, { scaleX: 0 }, { scaleX: 1, ease: "none", transformOrigin: "0% 50%", scrollTrigger: { trigger: el, start: "top 95%", end: "top 55%", scrub: true } })
    else gsap.fromTo(el, { scaleX: 0 }, { scaleX: 1, duration: 1.3, ease: "expo.out", transformOrigin: "0% 50%", scrollTrigger: once(el, "top 90%") })
  }
}
