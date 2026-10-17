import { MOTION_VARIANTS, type MotionVariant } from "./motion/variants"

/**
 * Sélecteur de version du motion design, le temps de comparer. Liens classiques (rechargement complet) : chaque
 * version repart du haut de page avec une scène et des déclencheurs neufs.
 */
export function MotionSwitcher({ current }: { current: MotionVariant }) {
  const active = MOTION_VARIANTS.find((m) => m.id === current)!
  return (
    <nav className="motion-switcher panel" aria-label="Version du motion design">
      <p className="px-1 text-[12px] text-trace">Motion design</p>
      <ul className="mt-1.5 flex flex-wrap gap-1">
        {MOTION_VARIANTS.map((m) => (
          <li key={m.id}>
            <a href={m.id === "actuelle" ? "/" : `/?v=${m.id}`} className={`btn ${m.id === current ? "btn-primary" : ""}`} aria-current={m.id === current ? "page" : undefined}>
              {m.label}
            </a>
          </li>
        ))}
      </ul>
      <p className="mt-2 max-w-[19rem] px-1 text-[12px] leading-snug text-trace">{active.hint}</p>
    </nav>
  )
}
