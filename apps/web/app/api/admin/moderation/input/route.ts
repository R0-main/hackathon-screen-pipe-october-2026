import { moderationInput } from "@/lib/moderation"
import { json, withViewer } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Admins : la matière d'un passage du modérateur (connaissances arrivées depuis le passage précédent, numérotées, avec
 * leur id et les connaissances proches déjà en place), pour le Claude Code de l'entreprise (`brain moderate`).
 * `{skipped: "nothing" | "off"}` s'il n'y a rien à relire.
 */
export const GET = withViewer(async () => json(await moderationInput()), { admin: true })
