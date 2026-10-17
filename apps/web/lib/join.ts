// The team message (joining a company on request): rules shared by the /api/join and /api/admin/join routes.

import { z } from "zod"
import type { BrainStore } from "./store"
import { caFingerprint } from "./ca"
import { buildJoinPrompt } from "./install-prompt"

/** Pending requests beyond which a company receives no more (a code shared too widely). */
export const MAX_PENDING_JOINS = 30

/**
 * Field pre-filled by the requester's Claude: empty, or left as the message's "<role>" placeholder, it is ignored
 * rather than rejected (an admin will fill it in).
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
  return { code, prompt: buildJoinPrompt({ baseUrl, code, orgName: org.name, caFingerprint: caFingerprint() }) }
}
