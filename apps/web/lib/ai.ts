import { createHash } from "node:crypto"
import type Anthropic from "@anthropic-ai/sdk"
import { createClaude } from "@brain/core/claude"
import { getOrgClaudeKey } from "./claude-key"
import { getStore, type BrainStore } from "./store"

const g = globalThis as unknown as { __claude?: Anthropic | null; __claudeByKey?: Map<string, Anthropic> }

/**
 * Client Claude côté serveur pour une entreprise (par défaut celle de la requête) : sa propre clé (réglée par un admin)
 * d'abord, sinon ANTHROPIC_API_KEY du déploiement, sinon null (on utilise alors les heuristiques).
 */
export async function getClaude(store: BrainStore = getStore()): Promise<Anthropic | null> {
  const key = await getOrgClaudeKey(store)
  if (key) {
    // Un client par clé (pas par entreprise) : une clé remplacée en crée un neuf, l'ancien n'est plus jamais servi.
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
