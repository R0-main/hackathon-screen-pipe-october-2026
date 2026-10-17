import {
  addAgentProgress,
  AgentDraftSchema,
  clearAgentDraft,
  clearAgentProgress,
  loadAgentDraft,
  loadAgentProgress,
  saveAgentDraft,
  storeForOnboardingCode,
} from "@/lib/onboarding-agent"
import { getStore } from "@/lib/store"
import { error, internalError, json, parseBody, withViewer } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const plural = (n: number, word: string) => `${n} ${word}${n > 1 ? "s" : ""}`

/**
 * Claude Code ou Codex dépose sa proposition d'onboarding, avec le code d'envoi du prompt (Bearer co_…). Elle remplace
 * la précédente (l'agent envoie une première version puis la complète) et attend que l'admin la relise et la valide.
 */
export async function POST(req: Request) {
  try {
    const store = await storeForOnboardingCode(req)
    if (!store) return error(401, "Code d'envoi invalide ou expiré : recopiez le prompt depuis la page Onboarding.")
    const body = await parseBody(req, AgentDraftSchema)
    if ("response" in body) return body.response
    // Déjà une proposition dans ce passage (même validée depuis à l'étape des zones) : celle-ci la complète.
    const run = await loadAgentProgress(store)
    const previous = run.slice(run.findLastIndex((e) => e.step === "start") + 1).some((e) => e.step === "draft")
    const draft = await saveAgentDraft(store, body.data)
    const counts = `${plural(draft.zones.length, "zone")}, ${plural(draft.items.length, "connaissance")}`
    await addAgentProgress(store, { step: "draft", message: previous ? `Proposition complétée : ${counts}` : `Première proposition reçue : ${counts}` })
    return json({ ok: true, zones: draft.zones.length, items: draft.items.length, review: "Proposition reçue : à relire et valider à l'écran (création de l'entreprise, ou page Onboarding du dashboard)." }, 201)
  } catch (err) {
    return internalError(err)
  }
}

/** Admins : la proposition en attente (null s'il n'y en a pas). La page Onboarding la relit pour se remplir toute seule. */
export const GET = withViewer(async () => json({ draft: await loadAgentDraft(getStore()) }), { admin: true })

/** Admins : écarte la proposition, et le fil du passage qui l'a produite. */
export const DELETE = withViewer(
  async () => {
    await clearAgentDraft(getStore())
    await clearAgentProgress(getStore())
    return json({ ok: true })
  },
  { admin: true },
)
