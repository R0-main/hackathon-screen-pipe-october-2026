import type Anthropic from "@anthropic-ai/sdk"
import { createClaude } from "@brain/core/claude"

const g = globalThis as unknown as { __claude?: Anthropic | null }

/** Client Claude côté serveur, ou null sans ANTHROPIC_API_KEY (on utilise alors les heuristiques). */
export function getClaude(): Anthropic | null {
  if (g.__claude === undefined) g.__claude = createClaude(process.env.ANTHROPIC_API_KEY)
  return g.__claude
}
