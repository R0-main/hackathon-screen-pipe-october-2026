import type { Zone } from "./types"
import { normalize, tokenize } from "./text"

/** Zones proposées par défaut. L'onboarding peut les remplacer ou en ajouter. */
export const DEFAULT_ZONES: Zone[] = [
  {
    id: "dev",
    name: "Dev",
    description: "Code, architecture, infra, déploiements, bugs.",
    color: "#22d3ee",
    keywords: [
      "code", "bug", "deploy", "deploiement", "api", "repo", "git", "pr", "pull", "merge", "test", "tests", "ci", "build",
      "backend", "frontend", "base", "donnees", "database", "sql", "postgres", "supabase", "migration", "serveur", "server",
      "deployer", "production", "docker", "typescript", "react", "next", "node", "python", "endpoint", "refacto", "refactor", "prod", "staging",
      "infra", "kubernetes", "aws", "vercel", "auth", "webhook", "stack", "lib", "librairie", "fonction", "function", "erreur",
      "error", "crash", "logs", "performance", "schema", "commit", "branche", "branch", "release",
    ],
    position: 0,
  },
  {
    id: "produit",
    name: "Produit",
    description: "Roadmap, specs, design, retours utilisateurs.",
    color: "#a78bfa",
    keywords: [
      "produit", "product", "roadmap", "feature", "fonctionnalite", "spec", "specs", "user", "utilisateur", "utilisateurs",
      "ux", "ui", "design", "maquette", "figma", "persona", "feedback", "retour", "retours", "onboarding", "parcours",
      "priorisation", "backlog", "sprint", "mvp", "experimentation", "metrique", "retention", "activation", "interview",
    ],
    position: 1,
  },
  {
    id: "sales",
    name: "Sales",
    description: "Prospects, clients, pipeline, devis, partenariats.",
    color: "#f472b6",
    keywords: [
      "client", "clients", "prospect", "prospects", "prospection", "devis", "crm", "hubspot", "pipeline", "deal", "deals",
      "vente", "ventes", "sales", "rdv", "demo", "proposition", "commerciale", "pricing", "prix", "tarif", "tarifs", "contrat",
      "signature", "lead", "leads", "partenaire", "partenariat", "salon", "relance", "churn", "upsell", "abonnement",
    ],
    position: 2,
  },
  {
    id: "compta",
    name: "Compta",
    description: "Facturation, trésorerie, clôtures, TVA, paie.",
    color: "#facc15",
    keywords: [
      "compta", "comptabilite", "comptable", "facture", "factures", "facturation", "tva", "cloture", "bilan", "tresorerie",
      "banque", "bancaire", "releve", "releves", "rapprochement", "qonto", "pennylane", "urssaf", "paie", "salaire", "salaires",
      "budget", "depense", "depenses", "note", "frais", "expert", "fiscal", "impots", "cash", "burn", "encaissement", "avoir",
    ],
    position: 3,
  },
  {
    id: "support",
    name: "Support",
    description: "Tickets, incidents clients, FAQ, procédures de support.",
    color: "#34d399",
    keywords: [
      "support", "ticket", "tickets", "incident", "incidents", "faq", "zendesk", "intercom", "sav", "reclamation", "plainte",
      "remboursement", "panne", "bloque", "aide", "question", "escalade", "sla", "hotline",
    ],
    position: 4,
  },
  {
    id: "direction",
    name: "Direction",
    description: "Stratégie, objectifs, levée de fonds, recrutement, organisation.",
    color: "#fb923c",
    keywords: [
      "strategie", "objectif", "objectifs", "okr", "okrs", "levee", "fonds", "investisseur", "investisseurs", "board", "bp",
      "recrutement", "recruter", "embauche", "rh", "organisation", "vision", "kpi", "kpis", "trimestre", "q1", "q2", "q3", "q4",
      "comite", "associes", "valorisation", "plan",
    ],
    position: 5,
  },
]

const ZONE_COLORS = ["#22d3ee", "#a78bfa", "#f472b6", "#facc15", "#34d399", "#fb923c", "#60a5fa", "#f87171", "#c084fc", "#2dd4bf"]

export function zoneColor(index: number): string {
  return ZONE_COLORS[index % ZONE_COLORS.length]
}

export function slugify(s: string): string {
  return normalize(s)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "zone"
}

/**
 * Classe un texte dans les zones par mots-clés (sans accents, préfixes tolérés).
 * Retourne les zones triées par score décroissant, au plus `max`.
 */
export function classifyZones(text: string, zones: Pick<Zone, "id" | "name" | "keywords">[], max = 2): string[] {
  const scored = scoreZones(text, zones)
  if (scored.length === 0) return []
  const best = scored[0].score
  return scored
    .filter((s) => s.score >= Math.max(0.5, best * 0.5))
    .slice(0, max)
    .map((s) => s.zone)
}

export function scoreZones(text: string, zones: Pick<Zone, "id" | "name" | "keywords">[]): { zone: string; score: number }[] {
  const tokens = tokenize(text)
  if (tokens.length === 0) return []
  const out: { zone: string; score: number }[] = []
  for (const z of zones) {
    const kws = new Set([...z.keywords.map(normalize), normalize(z.id), normalize(z.name)])
    let score = 0
    for (const t of tokens) {
      if (kws.has(t)) score += 1
      else if (t.length >= 5) {
        for (const k of kws) {
          if (k.length >= 5 && (t.startsWith(k) || k.startsWith(t))) {
            score += 0.5
            break
          }
        }
      }
    }
    if (score > 0) out.push({ zone: z.id, score })
  }
  return out.sort((a, b) => b.score - a.score)
}
