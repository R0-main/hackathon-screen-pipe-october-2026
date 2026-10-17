import { gsap } from "gsap"
import { ScrollTrigger } from "gsap/ScrollTrigger"
import { SplitText } from "gsap/SplitText"
import { DrawSVGPlugin } from "gsap/DrawSVGPlugin"
import { ScrambleTextPlugin } from "gsap/ScrambleTextPlugin"
import type Lenis from "lenis"
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

  Rythme commun aux trois versions : chaque section occupe un écran (CSS) et s'arrête alignée sur lui pendant une
  partie du scroll ; quand on lâche le scroll près d'un chapitre de la scène ou d'une section, la page s'y cale.
  Les animations jouées une fois (Épure, Cinétique) partent quand leur section arrive vraiment à l'écran, dans
  l'ordre de lecture : on les voit, au lieu qu'elles se jouent pendant que l'élément entre par le bas.

  Tout est créé dans le contexte useGSAP de Landing : animations, SplitText et ScrollTrigger sont annulés au
  démontage. Les écouteurs (pointeur, Lenis) sont rendus par la fonction de nettoyage.
  Appelé uniquement quand le mouvement est autorisé (pas sous prefers-reduced-motion).
*/

type Ctx = {
  lenis: Lenis
  /** Déclencheur de la scène épinglée du cerveau. */
  scene: ScrollTrigger
  /** Milieu de chaque chapitre de la scène, en fraction de sa progression. */
  stops: number[]
}

type Holds = Map<Element, ScrollTrigger>

const all = <T extends Element = HTMLElement>(root: ParentNode, sel: string) => Array.from(root.querySelectorAll<T>(sel))
const num = (el: Element, attr: string) => Number(el.getAttribute(attr) ?? 0)
const section = (el: Element) => el.closest(".landing-section") ?? undefined

/** Déclencheur d'un élément dans une section. `pinnedContainer` : les positions tiennent compte de l'arrêt. */
const at = (trigger: Element, vars: ScrollTrigger.Vars = {}): ScrollTrigger.Vars => ({ trigger, pinnedContainer: section(trigger), ...vars })

/** Centre du filtre local dans le schéma vie privée (viewBox 640 × 220). */
const FILTER = { x: 330, y: 110 }
/** Durée de l'arrêt de chaque section, en fraction de la hauteur d'écran. */
const HOLD = 0.6
/** Une section joue ses entrées quand son haut atteint ce point de l'écran : elle est déjà largement visible. */
const ARRIVE = "top 45%"

/**
 * Masques de ligne avec de la marge : sans elle, le masque coupe les jambages (g, p, q, y) et les accents des
 * grands titres, dont l'interligne est inférieur à 1.
 */
const roomy = (self: SplitText) => gsap.set(self.masks, { paddingTop: "0.08em", marginTop: "-0.08em", paddingBottom: "0.2em", marginBottom: "-0.2em" })

export function setupLandingMotion(variant: MotionVariant, root: HTMLElement, ctx: Ctx): () => void {
  if (variant === "actuelle") return () => {}
  // Les arrêts d'abord : les déclencheurs créés ensuite à l'intérieur des sections en tiennent compte.
  const holds = holdSections(root)
  const cleanups = [settle(root, ctx, holds)]
  if (variant === "epure") epure(root)
  if (variant === "recit") recit(root, holds)
  if (variant === "cinetique") cleanups.push(cinetique(root))
  return () => cleanups.forEach((fn) => fn())
}

/* ---------- Rythme : arrêts et calage ---------- */

/**
 * Chaque section (sauf la dernière) s'arrête alignée sur l'écran pendant `HOLD` hauteur d'écran de scroll.
 * Si son contenu dépasse l'écran (petit écran), elle s'arrête quand on voit son bas.
 */
function holdSections(root: HTMLElement): Holds {
  const holds: Holds = new Map()
  for (const el of all(root, ".landing-section:not([data-close])")) {
    holds.set(
      el,
      ScrollTrigger.create({
        trigger: el,
        start: () => (el.offsetHeight > window.innerHeight + 2 ? "bottom bottom" : "top top"),
        end: () => `+=${Math.round(window.innerHeight * HOLD)}`,
        pin: true,
        anticipatePin: 1,
        invalidateOnRefresh: true,
      }),
    )
  }
  return holds
}

/**
 * Quand on lâche le scroll près d'un chapitre de la scène ou d'une section, la page glisse jusqu'à lui : la
 * section se retrouve exactement alignée sur l'écran. Déjà dans un arrêt ou loin de tout, rien ne bouge.
 */
function settle(root: HTMLElement, { lenis, scene, stops }: Ctx, holds: Holds): () => void {
  const targets = () => {
    const range = scene.end - scene.start
    const vh = window.innerHeight
    const max = ScrollTrigger.maxScroll(window)
    const close = root.querySelector<HTMLElement>("[data-close]")
    return [
      ...stops.map((s) => ({ from: scene.start + s * range, to: scene.start + s * range, reach: range * 0.07 })),
      ...[...holds.values()].map((h) => ({ from: h.start, to: h.end, reach: vh * 0.4 })),
      ...(close ? [{ from: Math.min(max, close.getBoundingClientRect().top + window.scrollY), to: max, reach: vh * 0.4 }] : []),
    ]
  }
  let timer = 0
  const check = () => {
    if (lenis.isScrolling) return schedule()
    const y = lenis.scroll
    let best: number | null = null
    for (const t of targets()) {
      const goal = Math.min(t.to, Math.max(t.from, y))
      const d = Math.abs(goal - y)
      if (d > 2 && d < t.reach && (best === null || d < Math.abs(best - y))) best = goal
    }
    if (best !== null) lenis.scrollTo(best, { duration: 0.9, easing: (t) => 1 - (1 - t) ** 3 })
  }
  const schedule = () => {
    window.clearTimeout(timer)
    timer = window.setTimeout(check, 180)
  }
  lenis.on("scroll", schedule)
  return () => {
    window.clearTimeout(timer)
    lenis.off("scroll", schedule)
  }
}

/**
 * Entrées d'une section, jouées ensemble quand elle arrive à l'écran ; chacune a son délai, dans l'ordre de
 * lecture. `add` reçoit une fonction qui rejoue l'animation (au moment où la section arrive).
 */
function sequencer() {
  const queues = new Map<Element, (() => void)[]>()
  return {
    add(el: Element, play: () => void) {
      const sec = section(el)
      if (!sec) return play()
      queues.set(sec, [...(queues.get(sec) ?? []), play])
    },
    arm() {
      for (const [sec, plays] of queues) ScrollTrigger.create({ trigger: sec, start: ARRIVE, once: true, onEnter: () => plays.forEach((p) => p()) })
    },
  }
}

/** Animation en attente : visible dans son état de départ, jouée (avec son délai) quand la section arrive. */
const later = (vars: gsap.TweenVars) => ({ ...vars, paused: true })

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
        roomy(self)
        if (style === "lines") return gsap.from(self.lines, { yPercent: 125, duration: 1.15, ease: "expo.out", stagger: 0.1, delay: 0.15 })
        if (style === "words") return gsap.from(self.words, { autoAlpha: 0, y: "0.22em", duration: 0.7, ease: "power3.out", stagger: 0.055, delay: 0.15 })
        return gsap.from(self.words, { yPercent: 130, rotate: 7, transformOrigin: "0% 100%", duration: 1.2, ease: "expo.out", stagger: 0.045, delay: 0.1 })
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

/** Révélations sobres, jouées une fois quand la section arrive : titre, texte, panneau, détails. */
function epure(root: HTMLElement) {
  heroIn(root, "lines")
  const seq = sequencer()

  for (const el of all(root, '[data-reveal="title"]')) {
    let tween: gsap.core.Tween | null = null
    SplitText.create(el, {
      type: "lines",
      mask: "lines",
      autoSplit: true,
      onSplit: (self) => {
        roomy(self)
        tween = gsap.from(self.lines, later({ yPercent: 125, duration: 1.1, ease: "expo.out", stagger: 0.1 }))
        return tween
      },
    })
    seq.add(el, () => tween?.play())
  }
  for (const el of all(root, '[data-reveal="text"]')) {
    const tw = gsap.from(el, later({ autoAlpha: 0, y: 20, duration: 0.9, ease: "power3.out", delay: 0.3 }))
    seq.add(el, () => tw.restart(true))
  }
  for (const panel of all(root, '[data-reveal="panel"]')) {
    const tl = gsap.timeline({ paused: true, delay: 0.45 })
    tl.from(panel, { autoAlpha: 0, y: 28, duration: 0.9, ease: "power3.out" })
    const rows = all(panel, "[data-rows] > li")
    if (rows.length) tl.from(rows, { autoAlpha: 0, y: 10, duration: 0.6, ease: "power3.out", stagger: 0.1 }, 0.3)
    const typed = panel.querySelector("[data-type]")
    if (typed) tl.from(typed, { autoAlpha: 0, duration: 0.8, ease: "power2.out" }, "-=0.1")
    seq.add(panel, () => tl.restart(true))
  }

  const svg = root.querySelector("[data-privacy]")
  if (svg) {
    const tl = gsap.timeline({ paused: true, delay: 0.45 })
    tl.from(all(svg, "[data-raw]"), { opacity: 0, duration: 0.5, ease: "power2.out", stagger: { amount: 0.6, from: "random" } })
      .from(all(svg, "[data-filter]"), { opacity: 0, duration: 0.5, ease: "power2.out" }, "-=0.3")
      .from(all(svg, "[data-link]"), { drawSVG: "0%", duration: 0.7, ease: "power3.out", stagger: 0.06 }, "-=0.1")
      .from(all(svg, "[data-kept], [data-hub]"), { opacity: 0, scale: 0.6, transformOrigin: "50% 50%", duration: 0.5, ease: "power3.out", stagger: 0.06 }, "-=0.5")
      .from(all(svg, "[data-label]"), { opacity: 0, duration: 0.6, ease: "power2.out" }, "-=0.3")
    seq.add(svg, () => tl.restart(true))
  }

  for (const el of all(root, "[data-rule]")) {
    const tw = gsap.fromTo(el, { scaleX: 0 }, later({ scaleX: 1, duration: 1.3, ease: "expo.out", transformOrigin: "0% 50%", delay: 1.2 }))
    seq.add(el, () => tw.restart(true))
  }
  const facts = root.querySelector("[data-facts]")
  if (facts) {
    const tw = gsap.from(facts.children, later({ autoAlpha: 0, y: 16, duration: 0.8, ease: "power3.out", stagger: 0.12, delay: 1.4 }))
    seq.add(facts, () => tw.restart(true))
  }
  seq.arm()
}

/* ---------- Version 2 : Récit ---------- */

/**
 * Tout suit le scroll : on lit la page comme on lit le cerveau, et chaque geste se rejoue en remontant.
 * Le panneau et le schéma vie privée se jouent surtout pendant l'arrêt de leur section : la page tient,
 * l'histoire avance sous les yeux.
 */
function recit(root: HTMLElement, holds: Holds) {
  heroIn(root, "words")

  // Le fil : un trait encre qui descend le long des sections, une bille qui se remplit à chaque étape.
  const after = root.querySelector("[data-after]")
  const thread = root.querySelector("[data-thread]")
  if (after && thread) {
    gsap.fromTo(thread, { scaleY: 0 }, { scaleY: 1, ease: "none", transformOrigin: "50% 0%", scrollTrigger: { trigger: after, start: "top 60%", end: "bottom bottom", scrub: true } })
  }
  for (const bead of all(root, "[data-bead]")) {
    const fill = bead.querySelector("[data-bead-fill]")
    if (fill) gsap.fromTo(fill, { scale: 0 }, { scale: 1, duration: 0.45, ease: "power3.out", scrollTrigger: at(bead, { start: "top 55%", toggleActions: "play none none reverse" }) })
  }

  // Titres : les mots passent de pâle à encre au rythme du scroll, en finissant quand la section est en place.
  for (const el of all(root, '[data-reveal="title"]')) {
    SplitText.create(el, {
      type: "words",
      autoSplit: true,
      onSplit: (self) => gsap.fromTo(self.words, { opacity: 0.12 }, { opacity: 1, ease: "none", stagger: 0.12, scrollTrigger: at(el, { start: "top 85%", end: "top 30%", scrub: true }) }),
    })
  }
  for (const el of all(root, '[data-reveal="text"]')) {
    gsap.from(el, { autoAlpha: 0, y: 24, ease: "none", scrollTrigger: at(el, { start: "top 90%", end: "top 55%", scrub: true }) })
  }

  /** De l'arrivée de la section à l'écran jusqu'à la fin de son arrêt. */
  const throughHold = (el: Element): ScrollTrigger.Vars => {
    const sec = section(el)
    const hold = sec && holds.get(sec)
    return hold && sec ? { trigger: sec, start: "top 40%", end: () => hold.end, scrub: true, invalidateOnRefresh: true } : at(el, { start: "top 80%", end: "bottom 40%", scrub: true })
  }

  // Le panneau se remplit ligne par ligne, puis le prompt de Jean-Marc s'écrit caractère par caractère.
  for (const panel of all(root, '[data-reveal="panel"]')) {
    const tl = gsap.timeline({ defaults: { ease: "none" }, scrollTrigger: throughHold(panel) })
    tl.from(panel, { autoAlpha: 0, y: 40, duration: 0.2 })
    const rows = all(panel, "[data-rows] > li")
    if (rows.length) tl.from(rows, { autoAlpha: 0, x: -16, duration: 0.12, stagger: 0.08 })
    const typed = panel.querySelector<HTMLElement>("[data-type]")
    if (typed) {
      const chars = SplitText.create(typed, { type: "chars" }).chars
      tl.from(chars, { opacity: 0, duration: 0.01, stagger: 0.4 / chars.length })
    }
    tl.to({}, { duration: 0.15 })
  }

  // Le brut reste sur le poste ; seules cinq connaissances en partent, passent le filtre et rejoignent le cerveau.
  const svg = root.querySelector("[data-privacy]")
  if (svg) {
    const raw = all(svg, "[data-raw]")
    const kept = all(svg, "[data-kept]")
    const tl = gsap.timeline({ defaults: { ease: "none" }, scrollTrigger: throughHold(svg) })
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
    // Le trait encre et les engagements, à la suite, toujours pendant l'arrêt.
    for (const rule of all(root, "[data-rule]")) tl.fromTo(rule, { scaleX: 0 }, { scaleX: 1, transformOrigin: "0% 50%", duration: 0.2 }, 0.8)
    const facts = root.querySelector("[data-facts]")
    if (facts) tl.from(facts.children, { autoAlpha: 0, y: 20, duration: 0.12, stagger: 0.06 }, 0.9)
    tl.to({}, { duration: 0.1 })
  }
}

/* ---------- Version 3 : Cinétique ---------- */

/** Plus expressive : titres croisés, inclinaison à la vitesse du scroll, boutons magnétiques, cerveau en parallaxe. */
function cinetique(root: HTMLElement): () => void {
  heroIn(root, "kinetic")
  const seq = sequencer()
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

  // Titres : chaque ligne arrive d'un côté opposé, au rythme du scroll, et finit en place avec la section.
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
          scrollTrigger: at(el, { start: "top 92%", end: "top 35%", scrub: 0.8, invalidateOnRefresh: true }),
        }),
    })
  }
  // Inclinaison des titres selon la vitesse du scroll, qui retombe à zéro à l'arrêt.
  if (titles.length) {
    const setters = titles.map((t) => gsap.quickTo(t, "skewY", { duration: 0.6, ease: "power3.out" }))
    const calm = gsap.delayedCall(0.15, () => setters.forEach((s) => s(0))).pause()
    ScrollTrigger.create({
      onUpdate: (self) => {
        const v = gsap.utils.clamp(-4, 4, self.getVelocity() / -450)
        setters.forEach((s) => s(v))
        calm.restart(true)
      },
    })
  }
  for (const el of all(root, '[data-reveal="text"]')) {
    const tw = gsap.from(el, later({ autoAlpha: 0, y: 40, duration: 1, ease: "expo.out", delay: 0.2 }))
    seq.add(el, () => tw.restart(true))
  }

  // Panneaux : ils s'ouvrent depuis leur centre au scroll, puis les lignes arrivent et le prompt se décode.
  for (const panel of all(root, '[data-reveal="panel"]')) {
    gsap.fromTo(
      panel,
      { clipPath: "inset(16% 12% 16% 12% round 8px)", scale: 0.94 },
      { clipPath: "inset(0% 0% 0% 0% round 8px)", scale: 1, ease: "none", scrollTrigger: at(panel, { start: "top 95%", end: "top 40%", scrub: 0.6 }) },
    )
    const rows = all(panel, "[data-rows] > li")
    if (rows.length) {
      const tw = gsap.from(rows, later({ autoAlpha: 0, x: 48, duration: 0.9, ease: "expo.out", stagger: 0.1, delay: 0.4 }))
      seq.add(panel, () => tw.restart(true))
    }
    const typed = panel.querySelector<HTMLElement>("[data-type]")
    if (typed) {
      const text = typed.textContent ?? ""
      typed.setAttribute("aria-label", text)
      gsap.set(typed, { textContent: text.replace(/\S/g, "·") })
      const tw = gsap.to(typed, later({ duration: 1.8, scrambleText: { text, chars: "lowerCase", speed: 0.5, revealDelay: 0.2 }, ease: "none", delay: 1 }))
      seq.add(typed, () => tw.restart(true))
    }
  }

  // Le brut tourbillonne sur le poste au scroll ; à l'arrivée, les connaissances ressortent du filtre d'un coup.
  const svg = root.querySelector("[data-privacy]")
  if (svg) {
    const group = svg.querySelector("[data-raw-group]")
    const tl = gsap.timeline({ defaults: { ease: "none" }, scrollTrigger: at(svg, { start: "top 90%", end: "center 40%", scrub: 0.6 }) })
    if (group) tl.to(group, { rotation: -120, svgOrigin: "120 110", duration: 0.6 }, 0)
    tl.to(all(svg, "[data-raw]"), { opacity: 0.15, duration: 0.6, stagger: { amount: 0.3, from: "random" } }, 0)
    tl.from(all(svg, "[data-filter]"), { opacity: 0, scaleY: 0.2, transformOrigin: "50% 50%", duration: 0.2 }, 0.1)
    const out = gsap.timeline({ paused: true, delay: 0.5 })
    out.from(all(svg, "[data-kept], [data-hub]"), { opacity: 0, scale: 0.3, transformOrigin: "50% 50%", duration: 0.7, ease: "back.out(2.2)", stagger: 0.08 })
    out.from(all(svg, "[data-link]"), { drawSVG: "0%", duration: 0.6, ease: "expo.out", stagger: 0.06 }, 0.15)
    seq.add(svg, () => out.restart(true))
  }

  for (const el of all(root, "[data-rule]")) {
    const tw = gsap.fromTo(el, { scaleX: 0 }, later({ scaleX: 1, duration: 1.2, ease: "expo.out", transformOrigin: "0% 50%", delay: 1.1 }))
    seq.add(el, () => tw.restart(true))
  }
  const facts = root.querySelector("[data-facts]")
  if (facts) {
    const tw = gsap.from(facts.children, later({ autoAlpha: 0, x: 60, duration: 1, ease: "expo.out", stagger: 0.14, delay: 1.3 }))
    seq.add(facts, () => tw.restart(true))
  }

  // Dernier écran : le titre grandit jusqu'à sa taille en approchant.
  const close = root.querySelector('[data-close] [data-reveal="title"]')
  if (close) gsap.from(close, { scale: 0.82, transformOrigin: "0% 100%", ease: "none", scrollTrigger: { trigger: close, start: "top 100%", end: "top 45%", scrub: 0.6 } })

  seq.arm()
  return () => cleanups.forEach((fn) => fn())
}
