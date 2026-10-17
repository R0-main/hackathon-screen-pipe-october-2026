import { DEFAULT_ZONES } from "@brain/core"
import type { ZoneView } from "@/lib/brain"

/**
 * Le cerveau de Fournil (entreprise fictive de la démo) tel que la page d'accueil le montre : mêmes zones et
 * mêmes volumes que `scripts/demo-data.ts`, sans appel au serveur puisque le visiteur n'est pas connecté.
 */
const COUNTS: Record<string, number> = { dev: 9, produit: 6, sales: 6, compta: 6, support: 3, direction: 4 }

export const LANDING_ZONES: ZoneView[] = DEFAULT_ZONES.map((z) => ({
  ...z,
  count: COUNTS[z.id] ?? 0,
  last_at: null,
  contributors: 0,
  locked: false,
  entities: [],
}))

export const LANDING_TOTAL = LANDING_ZONES.reduce((n, z) => n + z.count, 0)

/** Zones qui partagent des entités dans la démo (client, outil, projet). */
export const LANDING_SYNAPSES = [
  { a: "dev", b: "produit", weight: 4, via: ["précommandes"] },
  { a: "sales", b: "produit", weight: 3, via: ["La Mie Dorée"] },
  { a: "compta", b: "sales", weight: 2, via: ["Stripe"] },
  { a: "dev", b: "support", weight: 3, via: ["app caisse"] },
  { a: "compta", b: "direction", weight: 2, via: ["runway"] },
  { a: "sales", b: "direction", weight: 1, via: ["MRR"] },
]

/**
 * Trois agents qui vont chercher du contexte pendant le dernier chapitre. `from`/`to` sont des fractions de la
 * scène épinglée ; les requêtes visent de vraies connaissances de la démo.
 */
export const LANDING_AGENTS = [
  { zone: "dev", from: 0.6, to: 0.69, label: "Claude Code de Hugo cherche «\u00a0déployer en production\u00a0»" },
  { zone: "compta", from: 0.68, to: 0.77, label: "Codex de Jean-Marc cherche «\u00a0rapprochement Qonto\u00a0»" },
  { zone: "sales", from: 0.76, to: 0.85, label: "Claude de Sarah cherche «\u00a0prix par boutique\u00a0»" },
]
