import { createHash } from "node:crypto"
import type Anthropic from "@anthropic-ai/sdk"
import { createClaude } from "@brain/core/claude"
import { getOrgClaudeKey } from "./claude-key"
import { getStore, type BrainStore } from "./store"

const g = globalThis as unknown as { __claude?: Anthropic | null; __claudeByKey?: Map<string, Anthropic> }

/**
 * Server-side Claude client for a company (by default the request's): its own key (set by an admin)
 * first, otherwise the deployment's ANTHROPIC_API_KEY, otherwise null (heuristics are then used).
 */
export async function getClaude(store: BrainStore = getStore()): Promise<Anthropic | null> {
  const key = await getOrgClaudeKey(store)
  if (key) {
    // One client per key (not per company): a replaced key creates a new one, the old one is never served again.
    const cache = (g.__claudeByKey ??= new Map())
    const id = createHash("sha256").update(key).digest("hex")
    let client = cache.get(id)
    if (!client) {
      client = createClaude(key)!
      cache.set(id, client)
    }
    return client
  }
  if (g.__claude === undefined) g.__claude = createClaude(process.env.ANTHROPIC_API_KEY)
  return g.__claude
}
