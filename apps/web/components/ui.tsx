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

export function MenuIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />
    </Icon>
  )
}

/** Icônes de la barre latérale : un trait, rien de décoratif. */
export function NavBrainIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="8" cy="8" r="5.5" />
      <circle cx="6" cy="6.5" r="1" fill="currentColor" stroke="none" />
      <circle cx="10.2" cy="9.5" r="1" fill="currentColor" stroke="none" />
      <path d="M6 6.5l4.2 3" />
    </Icon>
  )
}

export function PulseIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M1.5 8.5h3l1.8-4 3.2 8 1.8-4h3.2" />
    </Icon>
  )
}

export function DocIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 2.5h5.5L12 5v8.5H4z" />
      <path d="M6 8h4M6 10.5h4" />
    </Icon>
  )
}

export function StackIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 2.5l5.5 2.8L8 8.1 2.5 5.3z" />
      <path d="M2.5 8l5.5 2.8L13.5 8M2.5 10.7l5.5 2.8 5.5-2.8" />
    </Icon>
  )
}

export function TaskIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" />
      <path d="M5 8.2l2 1.8 4-4" />
    </Icon>
  )
}

export function BoltIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M9 1.5L3.5 9H8l-1 5.5L12.5 7H8z" />
    </Icon>
  )
}

/** Skill : un savoir-faire outillé (chevrons de code). */
export function SkillIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5M9 3l-2 10" />
    </Icon>
  )
}

export function UsersIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="6" cy="5.5" r="2.3" />
      <path d="M1.8 13.5c.4-2.4 2.1-3.7 4.2-3.7s3.8 1.3 4.2 3.7" />
      <path d="M10.5 3.4a2.3 2.3 0 0 1 0 4.3M12 9.9c1.2.5 2 1.7 2.2 3.6" />
    </Icon>
  )
}

export function ChatIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2.5 3.5h11v7.5H7l-3 2.5V11H2.5z" />
    </Icon>
  )
}

/** Chaîne (connecteurs). */
export function LinkIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6.5 9.5l3-3" />
      <path d="M7 11.5l-1.2 1.2a2.3 2.3 0 01-3.3-3.3L4.3 7.6M9 4.5l1.2-1.2a2.3 2.3 0 013.3 3.3L11.7 8.4" />
    </Icon>
  )
}

/** Cadran (supervision). */
export function WatchIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 5v3l2 1.5" />
    </Icon>
  )
}

/** Étiquette (entités). */
export function TagIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2.5 3.5v4.2l6 6 5-5-6-6H3.5a1 1 0 00-1 .8z" />
      <circle cx="5.5" cy="6" r="0.8" />
    </Icon>
  )
}

export function LogoutIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6.5 2.5h-3v11h3M10 5l3 3-3 3M13 8H6" />
    </Icon>
  )
}

/** Pictogramme du cerveau : un trait d'encre, deux points. Jamais de couleur. */
export function BrainIcon({ size = 30, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className={className}>
      <path
        d="M15 5c-2.2-1.6-5.6-.8-6.4 1.9C6 7.3 4.6 9.7 5.4 12c-2 1.4-2 4.5 0 6-.8 2.4.7 4.8 3.2 5.1.9 2.7 4.2 3.5 6.4 1.9V5zM17 5c2.2-1.6 5.6-.8 6.4 1.9 2.6.4 4 2.8 3.2 5.1 2 1.4 2 4.5 0 6 .8 2.4-.7 4.8-3.2 5.1-.9 2.7-4.2 3.5-6.4 1.9V5z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <circle cx="10.5" cy="12" r="1.5" fill="currentColor" />
      <circle cx="21.5" cy="18" r="1.5" fill="currentColor" />
    </svg>
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
