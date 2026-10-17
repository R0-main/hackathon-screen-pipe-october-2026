import { randomBytes } from "node:crypto"

/** Team message code: it only allows asking to join, never accessing the brain. */
export function newJoinCode(): string {
  return `cj_${randomBytes(18).toString("base64url")}`
}

export const JOIN_CODE_RE = /^cj_[A-Za-z0-9_-]{16,64}$/
