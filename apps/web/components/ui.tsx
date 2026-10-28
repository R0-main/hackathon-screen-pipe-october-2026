import type { SVGProps } from "react"

/**
 * Zone colors: fixed-order categorical palette, validated for color blindness and contrast
 * on the bone background (#f6f6f3). It never colors text: only a zone's dot and
 * its beads in the brain. The old neon colors still stored in the database are remapped
 * so that rendering stays consistent without a reseed.
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

/** A zone's identity dot (8 px). Always accompanied by the name in text. */
export function Dot({ color, size = 8, className = "" }: { color: string; size?: number; className?: string }) {
  return <span aria-hidden className={`inline-block shrink-0 rounded-full ${className}`} style={{ background: color, width: size, height: size }} />
}

/**
 * Zone bead, like the center of a zone in the brain: its color ringed in ink. It hooks a zone (or a piece of knowledge
 * from that zone) to a thread; the zone's name is always written next to it.
 */
export function ZoneBead({ color, size = 11, className = "" }: { color: string; size?: number; className?: string }) {
  return <span aria-hidden className={`block shrink-0 rounded-full border border-ink ${className}`} style={{ background: color, width: size, height: size }} />
}

/** Zone name with its dot: the only way to show a zone in the interface. */
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

export function SearchIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.4 10.4l3.1 3.1" />
    </Icon>
  )
}

export function CopyIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.2" />
      <path d="M10.5 5.5V3.7a1.2 1.2 0 0 0-1.2-1.2H3.7a1.2 1.2 0 0 0-1.2 1.2v5.6a1.2 1.2 0 0 0 1.2 1.2h1.8" />
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

/** Sidebar icons: a single stroke, nothing decorative. */
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

export function DocIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 2.5h5.5L12 5v8.5H4z" />
      <path d="M6 8h4M6 10.5h4" />
    </Icon>
  )
}

/** Paperclip: a document attached to knowledge, and the Documents page. */
export function PaperclipIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M10.5 5.5l-4.3 4.3a1.3 1.3 0 001.8 1.8l4.6-4.6a2.6 2.6 0 00-3.7-3.7L4.3 7.9a3.9 3.9 0 005.5 5.5l3.2-3.2" />
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

/** Skill: tooled know-how (code chevrons). */
export function SkillIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5M9 3l-2 10" />
    </Icon>
  )
}

/** Import and export: a box with an arrow going in and out. */
export function ArchiveIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2.5 9.5v3.5h11V9.5" />
      <path d="M8 2.5v7M5.2 6.8L8 9.6l2.8-2.8" />
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

/** Chain (connectors). */
export function LinkIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6.5 9.5l3-3" />
      <path d="M7 11.5l-1.2 1.2a2.3 2.3 0 01-3.3-3.3L4.3 7.6M9 4.5l1.2-1.2a2.3 2.3 0 013.3 3.3L11.7 8.4" />
    </Icon>
  )
}

/** Dial (monitoring). */
export function WatchIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 5v3l2 1.5" />
    </Icon>
  )
}

/** Gear (settings). */
export function GearIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="8" cy="8" r="2" />
      <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" />
      <circle cx="8" cy="8" r="4.5" />
    </Icon>
  )
}

/** Tag (entities). */
export function TagIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2.5 3.5v4.2l6 6 5-5-6-6H3.5a1 1 0 00-1 .8z" />
      <circle cx="5.5" cy="6" r="0.8" />
    </Icon>
  )
}

export function ChevronsIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5 6l3-3 3 3M5 10l3 3 3-3" />
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

/** NOS Brainer logo (same drawing as the favicon): six linked ink beads, the central bead in phosphor. */
export function LogoMark({ size = 26, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 97 97" aria-hidden className={className}>
      <path
        d="M24.6 15.95L8.05 50.35L25.75 80.8L48.35 49.5L24.6 15.95M48.35 49.5L72.35 17.2L84.55 51.35L69.1 82.65M48.35 49.5L84.55 51.35"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
      />
      <g fill="currentColor">
        <circle cx="24.6" cy="15.95" r="13.6" />
        <circle cx="72.35" cy="17.2" r="8.4" />
        <circle cx="84.55" cy="51.35" r="12.5" />
        <circle cx="8.05" cy="50.35" r="8" />
        <circle cx="25.75" cy="80.8" r="13.8" />
        <circle cx="69.1" cy="82.65" r="8.3" />
      </g>
      <circle cx="48.35" cy="49.5" r="9" fill="var(--color-phosphor)" />
    </svg>
  )
}

/** GitHub mark (Simple Icons, CC0), filled with the text color. */
export function GithubIcon({ size = 16, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden className={className}>
      <path
        fill="currentColor"
        d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"
      />
    </svg>
  )
}

/** Error message shown next to the action, announced to screen readers. */
export function ErrorText({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <p role="alert" className={`text-[13px] text-danger ${className}`}>
      {children}
    </p>
  )
}
