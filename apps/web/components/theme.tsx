"use client"

import { useSyncExternalStore } from "react"
import { isCoreZone } from "@brain/core"
import { THEME_KEY } from "./theme-script"
import { MoonIcon, SunIcon, zoneColor } from "./ui"

/**
 * Light (bone, the default) or dark theme. The choice lives on <html data-theme>, set before the first paint by
 * THEME_SCRIPT (layout) and remembered in localStorage; the CSS tokens (globals.css) and the brain's palette follow it.
 */
export type Theme = "light" | "dark"

const read = (): Theme => (document.documentElement.dataset.theme === "dark" ? "dark" : "light")

function subscribe(onChange: () => void) {
  const mo = new MutationObserver(onChange)
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] })
  return () => mo.disconnect()
}

export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, read, () => "light")
}

export function setTheme(theme: Theme) {
  if (theme === "dark") document.documentElement.dataset.theme = "dark"
  else delete document.documentElement.dataset.theme
  try {
    localStorage.setItem(THEME_KEY, theme)
  } catch {}
}

/** Sun / moon button: switches the whole interface, the brain included. */
export function ThemeToggle({ className = "btn btn-icon" }: { className?: string }) {
  const theme = useTheme()
  const next = theme === "dark" ? "light" : "dark"
  const label = next === "dark" ? "Dark mode" : "Light mode"
  return (
    <button type="button" className={className} onClick={() => setTheme(next)} aria-label={label} title={label}>
      {theme === "dark" ? <SunIcon /> : <MoonIcon />}
    </button>
  )
}

/**
 * The brain's colors (3D scenes and 2D fallback), per theme. In light: ink on white. In dark, the values swap: the network,
 * the links and the core are drawn in white and light grays on a near-black page; the zones keep their colors.
 */
export type BrainPalette = {
  /** Network lines and the ring around a lit zone. */
  ink: number
  /** A zone's links to its knowledge, at rest. */
  line: number
  /** Locked zone. */
  neutral: number
  /** Neurons outside any zone (cerebellum, brainstem). */
  bare: number
  /** Raw, not yet placed matter (home page). */
  raw: number
  /** The core's bead (null: its own color, from the zone), its orbits and its color when it lights up. */
  core: number | null
  coreLine: number
  coreGlow: number
  /** The backgrounds the brain blends into: panel (dashboard) and page (home, /create). */
  surface: number
  bone: number
}

export const BRAIN_PALETTE: Record<Theme, BrainPalette> = {
  light: {
    ink: 0x0a0a0a,
    line: 0xd6d6cf,
    neutral: 0xb8b8b8,
    bare: 0xc4c4bc,
    raw: 0xc6c6bf,
    core: null,
    coreLine: 0x9a9a93,
    coreGlow: 0x3a3a35,
    surface: 0xffffff,
    bone: 0xf6f6f3,
  },
  dark: {
    ink: 0xf4f4f0,
    line: 0x8e8e87,
    neutral: 0x8a8a8a,
    bare: 0x6c6c66,
    raw: 0x5c5c57,
    core: 0xe6e6e0,
    coreLine: 0xc6c6bf,
    coreGlow: 0xffffff,
    surface: 0x161615,
    bone: 0x0e0e0d,
  },
}

export function useBrainPalette(): BrainPalette {
  return BRAIN_PALETTE[useTheme()]
}

export const hex = (c: number) => `#${c.toString(16).padStart(6, "0")}`

/** A zone's color in the brain: its own, except the core's, drawn in light gray in dark theme. */
export const brainZoneColor = (z: { id: string; color: string | null; position: number }, palette: BrainPalette) =>
  isCoreZone(z.id) && palette.core !== null ? hex(palette.core) : zoneColor(z.color, z.position)
