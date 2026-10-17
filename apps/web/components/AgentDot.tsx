import { hashString } from "./brain-geometry"

const INK = "#0a0a0a"

/** Les tenues des dots : choisies par l'identifiant de la personne, elles ne changent jamais d'une visite à l'autre. */
export const LOOKS = ["plain", "beret", "frog", "glasses", "shades"] as const
export type DotLook = (typeof LOOKS)[number]

export const dotLook = (id: string): DotLook => LOOKS[hashString(id) % LOOKS.length]

/**
 * Le dot d'une personne : une petite boule ronde, dans la couleur de la zone où elle travaille, avec sa tenue.
 * Dessiné à plat (pas de dégradé ni d'ombre), comme le reste du cerveau.
 */
export function AgentDot({ id, color, look = dotLook(id), size = 40 }: { id: string; color: string; look?: DotLook; size?: number }) {
  return (
    <svg viewBox="0 0 40 36" width={size} height={(size * 36) / 40} aria-hidden className="block overflow-visible">
      {look === "frog" && (
        <>
          <circle cx="13" cy="13" r="6" fill={color} />
          <circle cx="27" cy="13" r="6" fill={color} />
        </>
      )}
      <path d="M3 35 C2 22 9 11 20 11 C31 11 38 22 37 35 Z" fill={color} />
      {look === "frog" ? (
        <>
          <circle cx="13" cy="12.5" r="3.8" fill="#fff" />
          <circle cx="27" cy="12.5" r="3.8" fill="#fff" />
          <circle cx="13.6" cy="12.8" r="2" fill={INK} />
          <circle cx="27.6" cy="12.8" r="2" fill={INK} />
        </>
      ) : look === "glasses" ? (
        <>
          <path d="M12.6 24 q2 2 4 0 M23.4 24 q2 2 4 0" stroke={INK} strokeWidth="1.4" fill="none" strokeLinecap="round" />
          <circle cx="14.6" cy="23.5" r="4.6" stroke={INK} strokeWidth="1.5" fill="none" />
          <circle cx="25.4" cy="23.5" r="4.6" stroke={INK} strokeWidth="1.5" fill="none" />
          <path d="M19.2 23 h1.6" stroke={INK} strokeWidth="1.5" />
        </>
      ) : look === "shades" ? (
        <>
          <circle cx="14.6" cy="24" r="4.2" fill={INK} />
          <circle cx="25.4" cy="24" r="4.2" fill={INK} />
          <path d="M18.6 23.5 h2.8" stroke={INK} strokeWidth="1.5" />
        </>
      ) : (
        <>
          <ellipse cx="16" cy="25" rx="1.7" ry="2.4" fill={INK} />
          <ellipse cx="24" cy="25" rx="1.7" ry="2.4" fill={INK} />
        </>
      )}
      {look === "beret" && (
        <g transform="rotate(-10 18 12)">
          <ellipse cx="18" cy="13" rx="13" ry="5" fill={INK} />
          <circle cx="18" cy="7" r="2" fill={INK} />
        </g>
      )}
    </svg>
  )
}
