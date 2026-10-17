import { randomBytes } from "node:crypto"

/** Code du message d'équipe : il permet seulement de demander à rejoindre, jamais d'accéder au cerveau. */
export function newJoinCode(): string {
  return `cj_${randomBytes(18).toString("base64url")}`
}

export const JOIN_CODE_RE = /^cj_[A-Za-z0-9_-]{16,64}$/
