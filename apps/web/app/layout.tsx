import "./globals.css"
import type { ReactNode } from "react"
import type { Metadata, Viewport } from "next"
import { IBM_Plex_Mono, Space_Grotesk } from "next/font/google"
import { RestoreGuard } from "@/components/RestoreGuard"
import { THEME_SCRIPT } from "@/components/theme-script"

// Two families only: a grotesque for the interface, a mono for tokens and code.
const sans = Space_Grotesk({ subsets: ["latin"], variable: "--font-space-grotesk", display: "swap" })
const mono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-plex-mono", display: "swap" })

export const metadata: Metadata = {
  title: "NOS Brainer",
  description: "Your company's digital brain, fed through Screenpipe by every computer's AI chats, meetings and repeated workflows.",
}

export const viewport: Viewport = { themeColor: "#f6f6f3", width: "device-width", initialScale: 1 }

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // suppressHydrationWarning: THEME_SCRIPT may set data-theme on <html> before React hydrates.
    <html lang="en" className={`${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-dvh">
        <RestoreGuard />
        {children}
      </body>
    </html>
  )
}
