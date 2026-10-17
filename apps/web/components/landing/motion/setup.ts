import { gsap } from "gsap"
import { ScrollTrigger } from "gsap/ScrollTrigger"
import { SplitText } from "gsap/SplitText"
import { ScrambleTextPlugin } from "gsap/ScrambleTextPlugin"
import type Lenis from "lenis"
import type { MotionVariant } from "./variants"

gsap.registerPlugin(ScrollTrigger, SplitText, ScrambleTextPlugin)

/*
  Motion de la page d'accueil, hors scène du cerveau (pilotée dans Landing et ScrollBrain).
  Le balisage porte des attributs que chaque version lit à sa façon :
  - data-hero="nav|title|sub|cta|note"  premier écran ;
  - data-reveal="title|text|panel"       titres, paragraphes et panneaux des sections ;
  - data-rows, data-type                 lignes de « Où en est Fournil » et prompt de Jean-Marc ;
  - data-privacy (+ data-pf-*)           le parcours des captures, du poste au cerveau (PrivacyFlow) ;
  - data-rule, data-facts                trait encre et trois engagements ;
  - data-after, data-thread, data-bead   fil de billes (version Récit) ;
  - data-parallax, data-magnetic         cerveau et boutons (version Cinétique).

  Rythme commun aux trois versions : chaque section occupe un écran (CSS) et s'arrête alignée sur lui pendant une
  partie du scroll ; quand on lâche le scroll tout près d'un chapitre ou d'une section, la page s'y cale.

  Toutes les animations des sections suivent le scroll (scrub) : elles avancent quand on descend, s'arrêtent
  quand on s'arrête et se rejouent à l'envers quand on remonte. On ne peut donc pas les rater. Seule l'entrée du
  premier écran se joue au chargement.

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
const section = (el: Element) => el.closest(".landing-section") ?? undefined

/** Déclencheur d'un élément dans une section. `pinnedContainer` : les positions tiennent compte de l'arrêt. */
const at = (trigger: Element, vars: ScrollTrigger.Vars = {}): ScrollTrigger.Vars => ({ trigger, pinnedContainer: section(trigger), ...vars })

/** Durée de l'arrêt de chaque section, en fraction de la hauteur d'écran. */
const HOLD = 0.6

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
  if (variant === "epure") epure(root, holds)
  if (variant === "recit") {
    recit(root, holds)
    cleanups.push(magnetic(root))
  }
  if (variant === "cinetique") cleanups.push(cinetique(root, holds))
  return () => cleanups.forEach((fn) => fn())
}

/* ---------- Rythme : arrêts et calage ---------- */

/** La section tient dans l'écran : elle s'arrête alignée dessus (sinon, quand on voit son bas). */
const fits = (el: HTMLElement) => el.offsetHeight <= window.innerHeight + 2

/**
 * Chaque section (sauf la dernière) s'arrête alignée sur l'écran pendant `HOLD` hauteur d'écran de scroll, ou
 * pendant la durée donnée par son attribut `data-hold` (une section qui a plus à montrer s'arrête plus longtemps).
 * Si son contenu dépasse l'écran (petit écran), elle s'arrête quand on voit son bas.
 */
function holdSections(root: HTMLElement): Holds {
  const holds: Holds = new Map()
  for (const el of all(root, ".landing-section:not([data-close])")) {
    const length = Number(el.dataset.hold) || HOLD
    holds.set(
      el,
      ScrollTrigger.create({
        trigger: el,
        start: () => (fits(el) ? "top top" : "bottom bottom"),
        end: () => `+=${Math.round(window.innerHeight * length)}`,
        pin: true,
        anticipatePin: 1,
        invalidateOnRefresh: true,
      }),
    )
  }
  return holds
}

/**
 * Quand on lâche le scroll tout près d'un chapitre de la scène ou d'une section, la page glisse jusqu'à lui : la
 * section se retrouve exactement alignée sur l'écran. La portée reste courte, pour que le calage ne fasse pas
 * avancer à notre place une animation liée au scroll. Déjà dans un arrêt ou loin de tout, rien ne bouge.
 */
function settle(root: HTMLElement, { lenis, scene, stops }: Ctx, holds: Holds): () => void {
  const targets = () => {
    const range = scene.end - scene.start
    const vh = window.innerHeight
    const max = ScrollTrigger.maxScroll(window)
    const close = root.querySelector<HTMLElement>("[data-close]")
    return [
      ...stops.map((s) => ({ from: scene.start + s * range, to: scene.start + s * range, reach: range * 0.05 })),
      ...[...holds.values()].map((h) => ({ from: h.start, to: h.end, reach: vh * 0.18 })),
      ...(close ? [{ from: Math.min(max, close.getBoundingClientRect().top + window.scrollY), to: max, reach: vh * 0.18 }] : []),
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
    if (best !== null) lenis.scrollTo(best, { duration: 0.7, easing: (t) => 1 - (1 - t) ** 3 })
  }
  const schedule = () => {
    window.clearTimeout(timer)
    timer = window.setTimeout(check, 220)
  }
  lenis.on("scroll", schedule)
  return () => {
    window.clearTimeout(timer)
    lenis.off("scroll", schedule)
  }
}

/**
 * Une timeline par section, liée au scroll, d'une durée de 1 : 0 quand le haut de la section entre en bas de
 * l'écran (85 %), 1 à la fin de son arrêt (ou, pour la dernière, quand elle est en place). La section se cale sur
 * l'écran vers 0,6 : ce qui est placé après se joue pendant l'arrêt, sous les yeux.
 */
function sectionTimelines(holds: Holds) {
  const timelines = new Map<Element, gsap.core.Timeline>()
  const timeline = (el: Element) => {
    const sec = section(el) ?? el
    let tl = timelines.get(sec)
    if (!tl) {
      const hold = holds.get(sec)
      tl = gsap.timeline({
        defaults: { ease: "none" },
        scrollTrigger: { trigger: sec, start: "top 85%", end: hold ? () => hold.end : "top 5%", scrub: true, invalidateOnRefresh: true },
      })
      tl.set({}, {}, 1)
      timelines.set(sec, tl)
    }
    return tl
  }
  return timeline
}

/** Valeur d'arrivée de chaque propriété de départ : l'élément revient à sa place, visible. */
const NEUTRAL: Record<string, string | number> = { autoAlpha: 1, opacity: 1, x: 0, y: 0, xPercent: 0, yPercent: 0, rotation: 0, rotate: 0, scale: 1, scaleX: 1, scaleY: 1 }

/**
 * Animation d'entrée : l'état de départ est posé tout de suite (sinon un élément décalé dans une animation en
 * cascade reste visible jusqu'à ce que le scroll atteigne son tour), puis on anime vers sa place.
 */
function enterTween(targets: gsap.TweenTarget, from: gsap.TweenVars, vars: gsap.TweenVars) {
  gsap.set(targets, from)
  const to: gsap.TweenVars = { ...vars }
  for (const key of Object.keys(from)) if (key in NEUTRAL) to[key] = NEUTRAL[key]
  return gsap.to(targets, to)
}
/** `enterTween` placé dans une timeline (à la suite si `pos` est omis). */
const enter = (tl: gsap.core.Timeline, targets: gsap.TweenTarget, from: gsap.TweenVars, vars: gsap.TweenVars, pos?: gsap.Position) => tl.add(enterTween(targets, from, vars), pos)

/**
 * Titre découpé en lignes (ou en mots) et animé dans la timeline de sa section. Au redécoupage (polices chargées,
 * redimensionnement), SplitText retire l'ancienne animation et on remet la nouvelle à la même place.
 */
function splitInto(tl: gsap.core.Timeline, el: HTMLElement, type: "lines" | "words", mask: boolean, make: (targets: Element[]) => gsap.core.Tween, at: number) {
  SplitText.create(el, {
    type,
    mask: mask ? type : undefined,
    autoSplit: true,
    onSplit: (self) => {
      if (mask) roomy(self)
      const tween = make(type === "lines" ? self.lines : self.words)
      tl.add(tween, at)
      return tween
    },
  })
}

/* ---------- « Le brut reste sur le poste » ---------- */

/**
 * Le parcours des captures (PrivacyFlow), placé dans une timeline entre `at` et `at + span` :
 * le poste et ses captures, puis les trois étapes du filtre (perso écarté, secret masqué, distillé),
 * enfin le cerveau qui reçoit trois connaissances. Les captures, elles, restent sur le poste.
 */
function privacyStory(fig: Element, tl: gsap.core.Timeline, at: number, span: number) {
  const t = (p: number) => at + p * span
  const d = (p: number) => p * span
  const poste = fig.querySelector("[data-pf-poste]")
  const brain = fig.querySelector("[data-pf-brain]")
  const rail = fig.querySelector("[data-pf-rail]")

  if (poste) enter(tl, poste, { autoAlpha: 0, y: 24 }, { duration: d(0.12), ease: "power1.out" }, t(0))
  enter(tl, all(fig, "[data-pf-row]"), { autoAlpha: 0, x: -12 }, { duration: d(0.06), stagger: d(0.025), ease: "power1.out" }, t(0.05))

  // Le rail se trace d'une étape à l'autre ; chaque étape s'affiche, puis sa bille se remplit quand elle agit.
  if (rail) enter(tl, rail, { scaleY: 0 }, { duration: d(0.36) }, t(0.22))
  enter(tl, all(fig, "[data-pf-step]"), { autoAlpha: 0, x: -8 }, { duration: d(0.05), stagger: d(0.14), ease: "power1.out" }, t(0.22))
  all(fig, "[data-pf-node]").forEach((node, i) => enter(tl, node, { scale: 0 }, { duration: d(0.04), ease: "power2.out" }, t(0.27 + i * 0.14)))

  // 1. Apps de travail seulement : WhatsApp et la banque perso sont barrés et pâlissent, sans quitter le poste.
  const dim = all(fig, "[data-pf-dim]")
  gsap.set(dim, { opacity: 1 })
  tl.add(gsap.to(dim, { opacity: 0.4, duration: d(0.06) }), t(0.29))
  enter(tl, all(fig, "[data-pf-strike]"), { scaleX: 0 }, { duration: d(0.06), stagger: d(0.02), ease: "power1.inOut" }, t(0.29))
  // 2. Secrets masqués : la clé Stripe disparaît sous une barre.
  enter(tl, all(fig, "[data-pf-mask]"), { scaleX: 0 }, { duration: d(0.06), ease: "power2.out" }, t(0.43))
  // 3. Distillé sur le poste : les captures de travail sont retenues.
  enter(tl, all(fig, "[data-pf-pass]"), { scale: 0 }, { duration: d(0.04), stagger: d(0.02), ease: "power2.out" }, t(0.57))

  // Le cerveau reçoit trois connaissances, une à une.
  if (brain) enter(tl, brain, { autoAlpha: 0, x: -16 }, { duration: d(0.1), ease: "power1.out" }, t(0.66))
  enter(tl, all(fig, "[data-pf-chip]"), { autoAlpha: 0, x: -24 }, { duration: d(0.08), stagger: d(0.07), ease: "power2.out" }, t(0.72))
}

/* ---------- Boutons magnétiques (Récit, Cinétique) ---------- */

/**
 * Chaque bouton de la page glisse vers le pointeur quand on le survole, revient en place avec un léger rebond
 * quand on le quitte, et s'enfonce un peu au clic. Souris seulement (pas au doigt).
 *
 * Le suivi (quickTo) est recréé à chaque entrée : l'animation de retour le remplace, et un quickTo remplacé
 * ne bouge plus. La transition CSS sur transform des boutons est retirée ici (data-magnetic, globals.css),
 * sinon elle se bat avec GSAP.
 */
function magnetic(root: HTMLElement): () => void {
  if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return () => {}
  const offs: (() => void)[] = []
  for (const el of all(root, ".btn, [data-magnetic]")) {
    if (el.closest(".motion-switcher")) continue
    el.setAttribute("data-magnetic", "")
    let follow: { x: gsap.QuickToFunc; y: gsap.QuickToFunc } | null = null
    const enter = () => {
      gsap.killTweensOf(el, "x,y")
      follow = { x: gsap.quickTo(el, "x", { duration: 0.45, ease: "power3.out" }), y: gsap.quickTo(el, "y", { duration: 0.45, ease: "power3.out" }) }
    }
    const move = (e: PointerEvent) => {
      if (!follow) enter()
      const r = el.getBoundingClientRect()
      // Le rectangle inclut le décalage en cours : on vise le centre d'origine du bouton.
      const cx = r.left + r.width / 2 - Number(gsap.getProperty(el, "x"))
      const cy = r.top + r.height / 2 - Number(gsap.getProperty(el, "y"))
      follow!.x((e.clientX - cx) * 0.3)
      follow!.y((e.clientY - cy) * 0.4)
    }
    // Pas d'overwrite : on coupe nous-mêmes ce qui tourne, sinon le suivi et le retour se disputent x et y.
    const leave = () => {
      follow?.x.tween.kill()
      follow?.y.tween.kill()
      follow = null
      gsap.killTweensOf(el, "x,y,scale")
      gsap.to(el, { x: 0, y: 0, scale: 1, duration: 0.8, ease: "elastic.out(1, 0.45)" })
    }
    const press = (scale: number, duration: number) => {
      gsap.killTweensOf(el, "scale")
      gsap.to(el, { scale, duration, ease: "power2.out" })
    }
    const down = () => press(0.97, 0.1)
    const up = () => press(1, 0.25)
    const events: [string, EventListener][] = [
      ["pointerenter", enter],
      ["pointermove", move as EventListener],
      ["pointerleave", leave],
      ["pointerdown", down],
      ["pointerup", up],
      ["pointercancel", up],
    ]
    for (const [type, fn] of events) el.addEventListener(type, fn)
    offs.push(() => {
      for (const [type, fn] of events) el.removeEventListener(type, fn)
      gsap.set(el, { clearProps: "transform" })
    })
  }
  return () => offs.forEach((fn) => fn())
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

/** Révélations sobres, dans l'ordre de lecture, au rythme du scroll : titre, texte, panneau, détails. */
function epure(root: HTMLElement, holds: Holds) {
  heroIn(root, "lines")
  const timeline = sectionTimelines(holds)

  for (const el of all(root, '[data-reveal="title"]')) {
    splitInto(timeline(el), el, "lines", true, (lines) => enterTween(lines, { yPercent: 125 }, { duration: 0.24, ease: "power2.out", stagger: 0.05 }), 0)
  }
  for (const el of all(root, '[data-reveal="text"]')) {
    enter(timeline(el), el, { autoAlpha: 0, y: 20 }, { duration: 0.2, ease: "power1.out" }, 0.16)
  }
  for (const panel of all(root, '[data-reveal="panel"]')) {
    const tl = timeline(panel)
    enter(tl, panel, { autoAlpha: 0, y: 28 }, { duration: 0.22, ease: "power1.out" }, 0.26)
    const rows = all(panel, "[data-rows] > li")
    if (rows.length) enter(tl, rows, { autoAlpha: 0, y: 10 }, { duration: 0.1, stagger: 0.05 }, 0.42)
    const typed = panel.querySelector("[data-type]")
    if (typed) enter(tl, typed, { autoAlpha: 0 }, { duration: 0.12 }, 0.66)
  }

  const fig = root.querySelector("[data-privacy]")
  if (fig) privacyStory(fig, timeline(fig), 0.28, 0.44)

  for (const el of all(root, "[data-rule]")) enter(timeline(el), el, { scaleX: 0, transformOrigin: "0% 50%" }, { duration: 0.14 }, 0.72)
  const facts = root.querySelector("[data-facts]")
  if (facts) enter(timeline(facts), facts.children, { autoAlpha: 0, y: 16 }, { duration: 0.1, stagger: 0.04 }, 0.78)
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
    if (fill) gsap.fromTo(fill, { scale: 0 }, { scale: 1, ease: "none", scrollTrigger: at(bead, { start: "top 75%", end: "top 45%", scrub: true }) })
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

  /**
   * De l'arrivée de la section à l'écran jusqu'à la fin de son arrêt. Avec `centred`, rien ne bouge avant que la
   * section soit calée sur l'écran : on lit d'abord le titre et le texte, puis l'illustration se joue pendant
   * l'arrêt. Sur petit écran (section plus haute que l'écran, arrêtée sur son bas), l'illustration serait déjà
   * sortie par le haut au début de l'arrêt : elle démarre alors plus tôt, quand on la voit.
   */
  const throughHold = (el: Element, centred = false): ScrollTrigger.Vars => {
    const sec = section(el) as HTMLElement | undefined
    const hold = sec && holds.get(sec)
    if (!hold || !sec) return at(el, { start: "top 80%", end: "bottom 40%", scrub: true })
    return { trigger: sec, start: centred ? () => (fits(sec) ? hold.start : "top 40%") : "top 40%", end: () => hold.end, scrub: true, invalidateOnRefresh: true }
  }

  // Le panneau se remplit ligne par ligne, puis le prompt de Jean-Marc s'écrit caractère par caractère.
  for (const panel of all(root, '[data-reveal="panel"]')) {
    const tl = gsap.timeline({ defaults: { ease: "none" }, scrollTrigger: throughHold(panel) })
    enter(tl, panel, { autoAlpha: 0, y: 40 }, { duration: 0.2, ease: "none" })
    const rows = all(panel, "[data-rows] > li")
    if (rows.length) enter(tl, rows, { autoAlpha: 0, x: -16 }, { duration: 0.12, stagger: 0.08, ease: "none" })
    const typed = panel.querySelector<HTMLElement>("[data-type]")
    if (typed) {
      const chars = SplitText.create(typed, { type: "chars" }).chars
      enter(tl, chars, { opacity: 0 }, { duration: 0.01, stagger: 0.4 / chars.length, ease: "none" })
    }
    tl.to({}, { duration: 0.15 })
  }

  // Le brut reste sur le poste : le filtre écarte, masque, distille, et seules trois connaissances montent.
  const fig = root.querySelector("[data-privacy]")
  if (fig) {
    const tl = gsap.timeline({ defaults: { ease: "none" }, scrollTrigger: throughHold(fig, true) })
    privacyStory(fig, tl, 0, 0.78)
    // Le trait encre et les engagements, à la suite, toujours pendant l'arrêt.
    for (const rule of all(root, "[data-rule]")) enter(tl, rule, { scaleX: 0, transformOrigin: "0% 50%" }, { duration: 0.2, ease: "none" }, 0.8)
    const facts = root.querySelector("[data-facts]")
    if (facts) enter(tl, facts.children, { autoAlpha: 0, y: 20 }, { duration: 0.12, stagger: 0.06, ease: "none" }, 0.9)
    tl.to({}, { duration: 0.1 })
  }
}

/* ---------- Version 3 : Cinétique ---------- */

/**
 * Plus expressive : titres croisés, panneaux qui s'ouvrent, prompt décodé, le tout au rythme du scroll ;
 * en plus, inclinaison à la vitesse du scroll, boutons magnétiques et cerveau en parallaxe.
 */
function cinetique(root: HTMLElement, holds: Holds): () => void {
  heroIn(root, "kinetic")
  const timeline = sectionTimelines(holds)
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

  cleanups.push(magnetic(root))

  // Titres : chaque ligne arrive d'un côté opposé. Le dernier titre grandit en plus jusqu'à sa taille.
  const titles = all(root, '[data-reveal="title"]')
  for (const el of titles) {
    const tl = timeline(el)
    const last = Boolean(el.closest("[data-close]"))
    splitInto(
      tl,
      el,
      "lines",
      false,
      (lines) => enterTween(lines, { x: (i: number) => (i % 2 ? -1 : 1) * window.innerWidth * 0.1, autoAlpha: 0 }, { duration: last ? 0.5 : 0.3, ease: "power2.out", stagger: 0.04 }),
      0,
    )
    if (last) enter(tl, el, { scale: 0.82, transformOrigin: "0% 100%" }, { duration: 0.7, ease: "power1.out" }, 0)
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
    enter(timeline(el), el, { autoAlpha: 0, y: 40 }, { duration: 0.2, ease: "power2.out" }, el.closest("[data-close]") ? 0.4 : 0.18)
  }

  // Panneaux : ils s'ouvrent depuis leur centre, puis les lignes arrivent et le prompt se décode.
  for (const panel of all(root, '[data-reveal="panel"]')) {
    const tl = timeline(panel)
    enter(tl, panel, { clipPath: "inset(16% 12% 16% 12% round 8px)", scale: 0.94 }, { clipPath: "inset(0% 0% 0% 0% round 8px)", duration: 0.3, ease: "power1.out" }, 0.2)
    const rows = all(panel, "[data-rows] > li")
    if (rows.length) enter(tl, rows, { autoAlpha: 0, x: 48 }, { duration: 0.12, ease: "power2.out", stagger: 0.05 }, 0.42)
    const typed = panel.querySelector<HTMLElement>("[data-type]")
    if (typed) {
      const text = typed.textContent ?? ""
      typed.setAttribute("aria-label", text)
      // Au départ, des points à la place des lettres ; en remontant, le décodage repart vers les points.
      gsap.set(typed, { textContent: text.replace(/\S/g, "·") })
      // revealDelay est en unités de la timeline (durée totale 1) : il doit rester petit devant la durée du décodage.
      tl.to(typed, { scrambleText: { text, chars: "lowerCase", revealDelay: 0.04, tweenLength: false }, duration: 0.2 }, 0.64)
    }
  }

  const fig = root.querySelector("[data-privacy]")
  if (fig) privacyStory(fig, timeline(fig), 0.28, 0.44)

  for (const el of all(root, "[data-rule]")) enter(timeline(el), el, { scaleX: 0, transformOrigin: "0% 50%" }, { duration: 0.14, ease: "power2.out" }, 0.72)
  const facts = root.querySelector("[data-facts]")
  if (facts) enter(timeline(facts), facts.children, { autoAlpha: 0, x: 60 }, { duration: 0.12, ease: "power2.out", stagger: 0.04 }, 0.78)

  return () => cleanups.forEach((fn) => fn())
}
