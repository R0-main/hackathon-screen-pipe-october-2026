import "./globals.css"
import type { ReactNode } from "react"
import type { Metadata, Viewport } from "next"
import { IBM_Plex_Mono, Space_Grotesk } from "next/font/google"

// Deux familles seulement : une grotesque pour l'interface, une mono pour les jetons et le code.
const sans = Space_Grotesk({ subsets: ["latin"], variable: "--font-space-grotesk", display: "swap" })
const mono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-plex-mono", display: "swap" })

export const metadata: Metadata = {
  title: "Cerveau d'entreprise",
  description: "Le cerveau numérique de votre entreprise, alimenté par les sessions IA de chaque poste via Screenpipe.",
}

export const viewport: Viewport = { themeColor: "#f6f6f3", width: "device-width", initialScale: 1 }

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="fr" className={`${sans.variable} ${mono.variable}`}>
      <body className="min-h-dvh">{children}</body>
    </html>
  )
}
