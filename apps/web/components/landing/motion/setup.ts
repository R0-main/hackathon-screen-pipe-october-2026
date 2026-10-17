import { gsap } from "gsap"
import { ScrollTrigger } from "gsap/ScrollTrigger"
import { SplitText } from "gsap/SplitText"
import type Lenis from "lenis"

gsap.registerPlugin(ScrollTrigger, SplitText)

/*
  Motion of the home page, outside the brain scene (driven in Landing and ScrollBrain).
  The markup carries attributes this module animates:
  - data-hero="nav|title|sub|cta|note"  first screen;
  - data-reveal="title|text|panel|cards" section titles, paragraphs, panels and cards (hosting, pricing);
  - data-rows, data-type                 rows of "Where Butine stands" and Jean-Marc's prompt;
  - data-privacy (+ data-pf-*)           the path of the captures, from the computer to the brain (PrivacyFlow);
  - data-rule, data-facts                ink rule and three commitments;
  - data-after, data-thread, data-bead   thread of beads linking the sections;
  - .btn                                 magnetic buttons (data-magnetic is set here).

  Rhythm: each section fills one screen (CSS) and holds aligned with it for part of the scroll; when
  you let go of the scroll very close to a chapter or a section, the page snaps to it.

  All section animations follow the scroll (scrub): they move forward when you scroll down, stop
  when you stop and replay backwards when you scroll up. So they cannot be missed. Only the entrance of the
  first screen plays on load.

  Everything is created in Landing's useGSAP context: animations, SplitText and ScrollTrigger are reverted on
  unmount. Listeners (pointer, Lenis) are returned by the cleanup function.
  Only called when motion is allowed (not under prefers-reduced-motion).
*/

type Ctx = {
  lenis: Lenis
  /** Trigger of the pinned brain scene. */
  scene: ScrollTrigger
  /** Middle of each chapter of the scene, as a fraction of its progress. */
  stops: number[]
}

type Holds = Map<Element, ScrollTrigger>

const all = <T extends Element = HTMLElement>(root: ParentNode, sel: string) => Array.from(root.querySelectorAll<T>(sel))
const section = (el: Element) => el.closest<HTMLElement>(".landing-section") ?? undefined

/** Trigger of an element inside a section. `pinnedContainer`: positions account for the hold. */
const at = (trigger: Element, vars: ScrollTrigger.Vars = {}): ScrollTrigger.Vars => ({ trigger, pinnedContainer: section(trigger), ...vars })

/** Duration of each section's hold, as a fraction of the screen height. */
const HOLD = 0.6

export function setupLandingMotion(root: HTMLElement, ctx: Ctx): () => void {
  // Holds first: the triggers created afterwards inside the sections account for them.
  const holds = holdSections(root)
  heroIn(root)
  thread(root)
  sections(root, holds)
  const cleanups = [settle(root, ctx, holds), magnetic(root)]
  return () => cleanups.forEach((fn) => fn())
}

/* ---------- Rhythm: holds and snapping ---------- */

/** The section fits in the screen: it holds aligned with it (otherwise, when you see its bottom). */
const fits = (el: HTMLElement) => el.offsetHeight <= window.innerHeight + 2

/**
 * Each section (except the last) holds aligned with the screen for `HOLD` screen height of scroll, or
 * for the duration given by its `data-hold` attribute (a section with more to show holds longer).
 * If its content is taller than the screen (small screen), it holds when you see its bottom.
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
 * When you let go of the scroll very close to a chapter of the scene or a section, the page slides to it: the
 * section ends up exactly aligned with the screen. The reach stays short, so that snapping does not move
 * a scroll-driven animation forward on our behalf. Already in a hold or far from everything, nothing moves.
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

/* ---------- Animation tools ---------- */

/** Arrival value of each starting property: the element comes back to its place, visible. */
const NEUTRAL: Record<string, string | number> = { autoAlpha: 1, opacity: 1, x: 0, y: 0, scale: 1, scaleX: 1, scaleY: 1 }

/**
 * Entrance animation placed in a timeline (after the previous one if `pos` is omitted). The starting state is set right
 * away, otherwise an element offset in a staggered animation stays visible until the scroll reaches its
 * turn; then it animates to its place.
 */
function enter(tl: gsap.core.Timeline, targets: gsap.TweenTarget, from: gsap.TweenVars, vars: gsap.TweenVars, pos?: gsap.Position) {
  gsap.set(targets, from)
  const to: gsap.TweenVars = { ...vars }
  for (const key of Object.keys(from)) if (key in NEUTRAL) to[key] = NEUTRAL[key]
  return tl.add(gsap.to(targets, to), pos)
}

/* ---------- First screen ---------- */

/** On load: the title's words arrive one by one, then the subtitle, the buttons and the note. */
function heroIn(root: HTMLElement) {
  const title = root.querySelector<HTMLElement>('[data-hero="title"]')
  if (title) {
    gsap.set(title, { autoAlpha: 1 })
    SplitText.create(title, {
      type: "words",
      autoSplit: true,
      onSplit: (self) => gsap.from(self.words, { autoAlpha: 0, y: "0.22em", duration: 0.7, ease: "power3.out", stagger: 0.055, delay: 0.15 }),
    })
  }
  const fade = (sel: string, delay: number, y = 16) => {
    const el = root.querySelector(`[data-hero="${sel}"]`)
    if (el) gsap.fromTo(el, { autoAlpha: 0, y }, { autoAlpha: 1, y: 0, duration: 0.9, ease: "power3.out", delay })
  }
  fade("nav", 0.05, 0)
  fade("sub", 0.75)
  fade("cta", 0.87)
  fade("note", 1.01, 0)
}

/* ---------- The thread ---------- */

/** An ink line going down along the sections, and a bead that fills on arriving at each one. */
function thread(root: HTMLElement) {
  const after = root.querySelector("[data-after]")
  const line = root.querySelector("[data-thread]")
  if (after && line) {
    gsap.fromTo(line, { scaleY: 0 }, { scaleY: 1, ease: "none", transformOrigin: "50% 0%", scrollTrigger: { trigger: after, start: "top 60%", end: "bottom bottom", scrub: true } })
  }
  for (const bead of all(root, "[data-bead]")) {
    const fill = bead.querySelector("[data-bead-fill]")
    if (fill) gsap.fromTo(fill, { scale: 0 }, { scale: 1, ease: "none", scrollTrigger: at(bead, { start: "top 75%", end: "top 45%", scrub: true }) })
  }
}

/* ---------- Sections ---------- */

/**
 * You read the page the way you read the brain. Titles go from pale to ink and texts rise to the rhythm of the
 * scroll; the "Where Butine stands" panel and the privacy diagram play during their section's hold:
 * the page holds still, the story moves on before your eyes.
 */
function sections(root: HTMLElement, holds: Holds) {
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
  // Side-by-side cards (hosting, pricing): they rise one by one and are in place before the hold, so that
  // you can compare them as soon as you reach the section (by scrolling or through the "Pricing" link).
  for (const el of all(root, '[data-reveal="cards"]')) {
    gsap.fromTo(el.children, { autoAlpha: 0, y: 32 }, { autoAlpha: 1, y: 0, ease: "none", stagger: 0.12, scrollTrigger: at(el, { start: "top 95%", end: "top 45%", scrub: true }) })
  }

  /**
   * From the section's arrival on screen to the end of its hold. With `centred`, nothing moves before the
   * section is snapped to the screen: you read the title and the text first, then the illustration plays during
   * the hold. On a small screen (section taller than the screen, held on its bottom), the illustration would already
   * have left through the top at the start of the hold: it then starts earlier, when you see it. A panel followed
   * by other content (connectors) likewise ends there once its own bottom is on screen, before the hold.
   */
  const throughHold = (el: Element, centred = false): ScrollTrigger.Vars => {
    const sec = section(el)
    const hold = sec && holds.get(sec)
    if (!hold || !sec) return at(el, { start: "top 80%", end: "bottom 40%", scrub: true })
    return {
      trigger: sec,
      endTrigger: el,
      start: centred ? () => (fits(sec) ? hold.start : "top 40%") : "top 40%",
      end: () => (centred || fits(sec) ? hold.end : "bottom bottom"),
      scrub: true,
      invalidateOnRefresh: true,
    }
  }

  // The panel fills row by row, then Jean-Marc's prompt types itself character by character.
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

  // The raw data stays on the computer: the filter drops, redacts, distills, and only three items go up.
  const fig = root.querySelector("[data-privacy]")
  if (fig) {
    const tl = gsap.timeline({ defaults: { ease: "none" }, scrollTrigger: throughHold(fig, true) })
    privacyStory(fig, tl, 0, 0.78)
    // The ink rule and the commitments, right after, still during the hold.
    for (const rule of all(root, "[data-rule]")) enter(tl, rule, { scaleX: 0, transformOrigin: "0% 50%" }, { duration: 0.2, ease: "none" }, 0.8)
    const facts = root.querySelector("[data-facts]")
    if (facts) enter(tl, facts.children, { autoAlpha: 0, y: 20 }, { duration: 0.12, stagger: 0.06, ease: "none" }, 0.9)
    tl.to({}, { duration: 0.1 })
  }
}

/**
 * The path of the captures (PrivacyFlow), placed in a timeline between `at` and `at + span`:
 * the computer and its captures, then the three filter steps (personal dropped, secret redacted, distilled),
 * finally the brain receiving three items. The captures themselves stay on the computer.
 */
function privacyStory(fig: Element, tl: gsap.core.Timeline, at: number, span: number) {
  const t = (p: number) => at + p * span
  const d = (p: number) => p * span
  const workstation = fig.querySelector("[data-pf-workstation]")
  const brain = fig.querySelector("[data-pf-brain]")
  const rail = fig.querySelector("[data-pf-rail]")

  if (workstation) enter(tl, workstation, { autoAlpha: 0, y: 24 }, { duration: d(0.12), ease: "power1.out" }, t(0))
  enter(tl, all(fig, "[data-pf-row]"), { autoAlpha: 0, x: -12 }, { duration: d(0.06), stagger: d(0.025), ease: "power1.out" }, t(0.05))

  // The rail draws itself from one step to the next; each step appears, then its bead fills when it acts.
  if (rail) enter(tl, rail, { scaleY: 0 }, { duration: d(0.36) }, t(0.22))
  enter(tl, all(fig, "[data-pf-step]"), { autoAlpha: 0, x: -8 }, { duration: d(0.05), stagger: d(0.14), ease: "power1.out" }, t(0.22))
  all(fig, "[data-pf-node]").forEach((node, i) => enter(tl, node, { scale: 0 }, { duration: d(0.04), ease: "power2.out" }, t(0.27 + i * 0.14)))

  // 1. Work apps only: WhatsApp and the personal bank are struck through and fade, without leaving the computer.
  const dim = all(fig, "[data-pf-dim]")
  gsap.set(dim, { opacity: 1 })
  tl.add(gsap.to(dim, { opacity: 0.4, duration: d(0.06) }), t(0.29))
  enter(tl, all(fig, "[data-pf-strike]"), { scaleX: 0 }, { duration: d(0.06), stagger: d(0.02), ease: "power1.inOut" }, t(0.29))
  // 2. Secrets redacted: the Stripe key disappears under a bar.
  enter(tl, all(fig, "[data-pf-mask]"), { scaleX: 0 }, { duration: d(0.06), ease: "power2.out" }, t(0.43))
  // 3. Distilled on the computer: the work captures are kept.
  enter(tl, all(fig, "[data-pf-pass]"), { scale: 0 }, { duration: d(0.04), stagger: d(0.02), ease: "power2.out" }, t(0.57))

  // The brain receives three items, one by one.
  if (brain) enter(tl, brain, { autoAlpha: 0, x: -16 }, { duration: d(0.1), ease: "power1.out" }, t(0.66))
  enter(tl, all(fig, "[data-pf-chip]"), { autoAlpha: 0, x: -24 }, { duration: d(0.08), stagger: d(0.07), ease: "power2.out" }, t(0.72))
}

/* ---------- Magnetic buttons ---------- */

/**
 * Each button on the page slides toward the pointer when hovered, comes back in place with a slight bounce
 * when left, and sinks in a bit on click. Mouse only (not touch).
 *
 * The follower (quickTo) is recreated on each entry: the return animation replaces it, and a replaced quickTo
 * no longer moves. The CSS transition on the buttons' transform is removed here (data-magnetic, globals.css),
 * otherwise it fights with GSAP.
 */
function magnetic(root: HTMLElement): () => void {
  if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return () => {}
  const offs: (() => void)[] = []
  for (const el of all(root, ".btn")) {
    el.setAttribute("data-magnetic", "")
    let follow: { x: gsap.QuickToFunc; y: gsap.QuickToFunc } | null = null
    const enterButton = () => {
      gsap.killTweensOf(el, "x,y")
      follow = { x: gsap.quickTo(el, "x", { duration: 0.45, ease: "power3.out" }), y: gsap.quickTo(el, "y", { duration: 0.45, ease: "power3.out" }) }
    }
    const move = (e: PointerEvent) => {
      if (!follow) enterButton()
      const r = el.getBoundingClientRect()
      // The rectangle includes the current offset: aim at the button's original center.
      const cx = r.left + r.width / 2 - Number(gsap.getProperty(el, "x"))
      const cy = r.top + r.height / 2 - Number(gsap.getProperty(el, "y"))
      follow!.x((e.clientX - cx) * 0.3)
      follow!.y((e.clientY - cy) * 0.4)
    }
    // No overwrite: we kill what is running ourselves, otherwise the follower and the return fight over x and y.
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
      ["pointerenter", enterButton],
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
      el.removeAttribute("data-magnetic")
    })
  }
  return () => offs.forEach((fn) => fn())
}
