import "./globals.css"
import type { ReactNode } from "react"
import type { Metadata, Viewport } from "next"
import { RestoreGuard } from "@/components/RestoreGuard"

export const metadata: Metadata = {
  title: "Cerveau d'entreprise",
  description: "Le cerveau numérique de votre entreprise, alimenté par les sessions IA de chaque poste via Screenpipe.",
}

export const viewport: Viewport = { themeColor: "#04060c", width: "device-width", initialScale: 1 }

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="fr">
      <body>
        <RestoreGuard />
        {children}
      </body>
    </html>
  )
}
