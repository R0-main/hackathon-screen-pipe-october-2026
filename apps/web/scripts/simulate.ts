// Simulateur d'activité pour la démo : des agents « travaillent » et le cerveau s'allume en direct.
// Usage : npm run simulate                 (boucle, Ctrl-C pour arrêter)
//         npm run simulate -- --once       (une seule scène)
//         npm run simulate -- --speed 2    (deux fois plus rapide)

import { normalize, promptFingerprint, type KnowledgeItemInput } from "@brain/core"
import { getStore } from "../lib/store"
import { getAccess } from "../lib/access"
import { ingestItems, queryBrain, recordEvents } from "../lib/brain"
import type { Viewer } from "../lib/auth"
import { DEMO_PROMPTS, DEMO_USERS } from "./demo-data"

const args = process.argv.slice(2)
const once = args.includes("--once")
const speed = Number(args[args.indexOf("--speed") + 1]) || 1
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms / speed))
const pick = <T,>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)]

/** Questions qu'un agent pose au cerveau via le MCP (search_brain). */
const AGENT_QUERIES: Record<string, string[]> = {
  dev: ["procédure de déploiement en production", "webhook Stripe invoice.paid", "isolation RLS Supabase", "restaurer une sauvegarde"],
  produit: ["priorité du trimestre alerte essaimage", "retours Miellerie Roussel export Excel", "usage de l'app au rucher"],
  sales: ["pipeline octobre négociations", "nouveau pricing annuel", "préparer une démo"],
  compta: ["rapprochement Qonto Pennylane", "clôture mensuelle cabinet Durand", "versements Stripe sur Qonto"],
  support: ["balance qui ne remonte plus", "top des tickets d'octobre"],
  direction: ["objectifs T4 MRR", "levée seed reportée", "board trimestriel KPIs"],
}

/** Connaissances fraîches que brain-sync « distille » pendant la démo. */
const FRESH: (KnowledgeItemInput & { author: string })[] = [
  {
    author: "hugo", zone: "dev", kind: "decision", title: "Les alertes essaimage passent par une file Supabase Queues",
    body: "Évite de bloquer la réception des pesées ; le SMS part chez l'apiculteur en moins de 30 secondes via Brevo.",
    entities: [{ type: "tool", name: "Supabase" }, { type: "tool", name: "Brevo" }, { type: "project", name: "Alerte essaimage" }],
    source: { app: "Terminal", tool: "claude-code", at: "" }, confidence: 0.82,
  },
  {
    author: "sarah", zone: "sales", kind: "fact", title: "Coop'Apis Provence demande une remise pour ses 60 apiculteurs",
    body: "Ils signeraient à 3,40 € par ruche en annuel. À valider avec Claire avant vendredi.",
    entities: [{ type: "client", name: "Coop'Apis Provence" }, { type: "person", name: "Claire Martin" }],
    source: { app: "Claude", tool: "claude", at: "" }, confidence: 0.78,
  },
  {
    author: "jeanmarc", zone: "compta", kind: "procedure", title: "Préparer l'export mensuel pour le cabinet Durand",
    body: "1. Clôturer les rapprochements Qonto.\n2. Exporter le FEC depuis Pennylane.\n3. Joindre les justificatifs Swile.\n4. Envoyer avant le 5 du mois.",
    entities: [{ type: "tool", name: "Pennylane" }, { type: "client", name: "Cabinet Durand" }, { type: "tool", name: "Swile" }],
    source: { app: "Claude", tool: "claude", at: "" }, confidence: 0.85,
  },
  {
    author: "leo", zone: "produit", kind: "decision", title: "L'alerte essaimage se coupe pendant une heure de visite",
    body: "Ouvrir la ruche fait varier le poids de plusieurs kilos ; une heure couvre une visite d'après les interviews d'apiculteurs.",
    entities: [{ type: "project", name: "Alerte essaimage" }],
    source: { app: "Claude", tool: "claude", at: "" }, confidence: 0.8,
  },
  {
    author: "ines", zone: "dev", kind: "fact", title: "La mémoire tampon de la balance déborde au-delà de 2 000 pesées",
    body: "La file en mémoire flash est plafonnée ; à corriger avant le nouveau firmware. Repro : script e2e balance-hors-reseau.spec.ts.",
    entities: [{ type: "project", name: "Balance B2" }, { type: "tool", name: "Playwright" }],
    source: { app: "Terminal", tool: "claude-code", at: "" }, confidence: 0.76,
  },
  {
    author: "sarah", zone: "support", kind: "procedure", title: "Répondre à une demande de remboursement d'abonnement",
    body: "1. Vérifier la date de souscription dans Stripe.\n2. Rembourser au prorata si moins de 14 jours.\n3. Noter le motif dans HubSpot pour le suivi du churn.",
    entities: [{ type: "tool", name: "Stripe" }, { type: "tool", name: "HubSpot" }],
    source: { app: "Claude", tool: "claude", at: "" }, confidence: 0.8,
  },
  {
    author: "claire", zone: "direction", kind: "decision", title: "Le recrutement d'un second profil support est avancé à novembre",
    body: "Le volume de tickets a doublé depuis la rentrée ; budget validé sur la trésorerie actuelle, sans attendre la levée.",
    entities: [{ type: "project", name: "Recrutement" }],
    source: { app: "Claude", tool: "claude", at: "" }, confidence: 0.79,
  },
  {
    author: "hugo", zone: "dev", kind: "procedure", title: "Rejouer un webhook Stripe en local",
    body: "stripe listen --forward-to localhost:3000/api/stripe puis stripe events resend <id>. Ne jamais rejouer en production sans vérifier l'idempotence.",
    entities: [{ type: "tool", name: "Stripe" }],
    source: { app: "Terminal", tool: "claude-code", at: "" }, confidence: 0.84,
  },
]

const titleKey = (zone: string, title: string) => `${zone}|${normalize(title).replace(/\s+/g, " ").trim()}`

/**
 * Connaissances fraîches pas encore présentes dans le cerveau : chacune n'est distillée qu'une fois (relancer le
 * simulateur ou le laisser tourner longtemps ne crée pas de doublons ; le serveur dédoublonne aussi).
 */
async function freshQueue(): Promise<typeof FRESH> {
  const since = new Date(Date.now() - 30 * 86400_000).toISOString()
  const known = new Set((await getStore().listItems({ sinceIso: since, limit: 100_000 })).map((i) => titleKey(i.zone, i.title)))
  return FRESH.filter((f) => !known.has(titleKey(f.zone, f.title)))
}

async function viewers(): Promise<Record<string, Viewer>> {
  const store = getStore()
  const profiles = await store.listProfiles()
  const out: Record<string, Viewer> = {}
  for (const u of DEMO_USERS) {
    const p = profiles.find((x) => x.name === u.name)
    if (p) out[u.key] = { profile: p, real: p, access: await getAccess(p) }
  }
  if (Object.keys(out).length === 0) throw new Error("Aucun compte de démo : lancez d'abord `npm run seed`.")
  return out
}

async function scene(vs: Record<string, Viewer>, queue: typeof FRESH) {
  const zone = pick(Object.keys(DEMO_PROMPTS))
  const prompt = pick(DEMO_PROMPTS[zone])
  const v = vs[prompt.user]
  if (!v) return
  const session = `sim-${Date.now()}`
  const agent = prompt.user === "hugo" && Math.random() < 0.4 ? "codex" : "claude-code"
  console.log(`· ${v.profile.name} (${agent}) : « ${prompt.text} »`)
  await recordEvents(v, [{ agent, type: "started", session_id: session }])
  await sleep(900)
  await recordEvents(v, [{ agent, type: "query", zones: [zone], summary: prompt.text, fingerprint: promptFingerprint(prompt.text), session_id: session }])
  await sleep(1600)
  // L'agent va chercher du contexte dans le cerveau via le MCP.
  const q = pick(AGENT_QUERIES[zone] ?? [prompt.text])
  const res = await queryBrain(v, { query: q, agent: "mcp" })
  console.log(`  ↳ MCP search_brain « ${q} » → ${res.items.length} résultat(s) dans ${res.zones_hit.join(", ") || "aucune zone"}`)
  await sleep(2200)
  // De temps en temps, brain-sync remonte une nouvelle connaissance (jamais deux fois la même).
  if (queue.length > 0 && Math.random() < 0.45) {
    const f = queue.shift()!
    const author = vs[f.author] ?? v
    const { author: _a, ...item } = f
    const res = await ingestItems(author, [{ ...item, source: { ...item.source, at: new Date().toISOString() } }])
    console.log(res.inserted ? `  ↳ brain-sync : « ${f.title} » (${f.zone})` : `  ↳ brain-sync : « ${f.title} » déjà connue, ignorée`)
    if (queue.length === 0) console.log("  (toutes les connaissances fraîches ont été distillées : la suite ne fait plus que des recherches)")
  }
  await recordEvents(v, [{ agent, type: "stopped", session_id: session }])
}

async function main() {
  const vs = await viewers()
  const queue = await freshQueue()
  console.log(`Simulation sur le cerveau (${getStore().kind}). Ouvrez le dashboard pour voir les zones s'allumer.`)
  console.log(`${queue.length}/${FRESH.length} connaissance(s) fraîche(s) à distiller pendant la démo.`)
  do {
    await scene(vs, queue)
    if (!once) await sleep(1500 + Math.random() * 2500)
  } while (!once)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
