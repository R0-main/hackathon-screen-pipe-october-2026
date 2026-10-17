// Le message d'équipe (rejoindre une entreprise sur demande) : règles partagées par les routes /api/join et /api/admin/join.

import { z } from "zod"
import type { BrainStore } from "./store"
import { caFingerprint } from "./ca"
import { buildJoinPrompt } from "./install-prompt"

/** Demandes en attente au-delà desquelles une entreprise n'en reçoit plus (un code diffusé trop largement). */
export const MAX_PENDING_JOINS = 30

/**
 * Champ prérempli par le Claude du demandeur : vide, ou resté sous la forme « <poste> » du message, il est ignoré
 * plutôt que refusé (un admin le complétera).
 */
export const prefilled = (max: number) =>
  z
    .string()
    .max(max * 2)
    .optional()
    .transform((v) => {
      const t = v?.trim().replace(/\s+/g, " ").slice(0, max)
      return t && !/^<.*>$/.test(t) ? t : undefined
    })

export const prefilledEmail = prefilled(200).transform((v) => (v && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : undefined))

export async function joinPromptFor(store: BrainStore, baseUrl: string) {
  const [code, org] = await Promise.all([store.getJoinCode(), store.getOrg()])
  return { code, prompt: buildJoinPrompt({ baseUrl, code, orgName: org.name, orgDescription: org.description, caFingerprint: caFingerprint() }) }
}
