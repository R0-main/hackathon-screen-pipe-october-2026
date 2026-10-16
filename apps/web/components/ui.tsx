import type { SVGProps } from "react"

/**
 * Couleurs de zone : palette catégorielle à ordre fixe, validée pour le daltonisme et le contraste
 * sur fond bone (#f6f6f3). Elle ne colore jamais du texte : seulement la pastille d'une zone et
 * ses billes dans le cerveau. Les anciennes couleurs néon encore stockées en base sont remappées
 * pour que le rendu reste cohérent sans re-seed.
 */
export const ZONE_PALETTE = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948", "#0e9aa7", "#9c4dcc"] as const

const LEGACY_NEON: Record<string, string> = {
  "#22d3ee": ZONE_PALETTE[0],
  "#a78bfa": ZONE_PALETTE[1],
  "#f472b6": ZONE_PALETTE[2],
  "#facc15": ZONE_PALETTE[3],
  "#34d399": ZONE_PALETTE[4],
  "#fb923c": ZONE_PALETTE[5],
  "#60a5fa": ZONE_PALETTE[6],
  "#f87171": ZONE_PALETTE[7],
  "#c084fc": ZONE_PALETTE[8],
  "#2dd4bf": ZONE_PALETTE[9],
}

export function zoneColor(color: string | null | undefined, index = 0): string {
  if (!color) return ZONE_PALETTE[index % ZONE_PALETTE.length]
  return LEGACY_NEON[color.toLowerCase()] ?? color
}

/** Pastille d'identité d'une zone (8 px). Toujours accompagnée du nom en texte. */
export function Dot({ color, size = 8, className = "" }: { color: string; size?: number; className?: string }) {
  return <span aria-hidden className={`inline-block shrink-0 rounded-full ${className}`} style={{ background: color, width: size, height: size }} />
}

/** Nom de zone avec sa pastille : la seule façon d'afficher une zone dans l'interface. */
export function ZoneTag({ name, color, className = "" }: { name: string; color: string; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`}>
      <Dot color={color} />
      {name}
    </span>
  )
}

type IconProps = SVGProps<SVGSVGElement> & { size?: number }

function Icon({ size = 16, children, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden {...rest}>
      {children}
    </svg>
  )
}

export function CloseIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />
    </Icon>
  )
}

export function CheckIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3 8.5l3.2 3L13 4.5" />
    </Icon>
  )
}

export function LockIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3.5" y="7" width="9" height="6.5" rx="1" />
      <path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7" />
    </Icon>
  )
}

export function PlusIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 3.5v9M3.5 8h9" />
    </Icon>
  )
}

export function MinusIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3.5 8h9" />
    </Icon>
  )
}

export function ClockIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 5v3.2l2 1.3" />
    </Icon>
  )
}

/** Message d'erreur affiché à côté de l'action, annoncé aux lecteurs d'écran. */
export function ErrorText({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <p role="alert" className={`text-[13px] text-danger ${className}`}>
      {children}
    </p>
  )
}
