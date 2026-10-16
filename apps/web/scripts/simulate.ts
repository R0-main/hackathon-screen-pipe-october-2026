// Simulateur d'activité pour la démo : des agents « travaillent » et le cerveau s'allume en direct.
// Usage : npm run simulate                 (boucle, Ctrl-C pour arrêter)
//         npm run simulate -- --once       (une seule scène)
//         npm run simulate -- --speed 2    (deux fois plus rapide)

import { promptFingerprint, type KnowledgeItemInput } from "@brain/core"
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
  produit: ["priorité du trimestre précommandes", "retours La Mie Dorée export Excel", "usage de l'app le matin"],
  sales: ["pipeline octobre négociations", "nouveau pricing annuel", "préparer une démo"],
  compta: ["rapprochement Qonto Pennylane", "clôture mensuelle cabinet Durand", "versements Stripe sur Qonto"],
  support: ["réinitialiser l'imprimante de tickets", "top des tickets d'octobre"],
  direction: ["objectifs T4 MRR", "levée seed reportée", "board trimestriel KPIs"],
}

/** Connaissances fraîches que brain-sync « distille » pendant la démo. */
const FRESH: (KnowledgeItemInput & { author: string })[] = [
  {
    author: "hugo", zone: "dev", kind: "decision", title: "Les précommandes utilisent une file Supabase Queues pour les notifications SMS",
    body: "Évite de bloquer la requête de commande ; les SMS partent en moins de 30 secondes via Brevo.",
    entities: [{ type: "tool", name: "Supabase" }, { type: "tool", name: "Brevo" }, { type: "project", name: "Précommandes" }],
    source: { app: "Terminal", tool: "claude-code", at: "" }, confidence: 0.82,
  },
  {
    author: "sarah", zone: "sales", kind: "fact", title: "Au Pain d'Antan demande une remise pour 3 boutiques",
    body: "Ils signeraient à 44 €/boutique en annuel. À valider avec Claire avant vendredi.",
    entities: [{ type: "client", name: "Au Pain d'Antan" }, { type: "person", name: "Claire Martin" }],
    source: { app: "Claude", tool: "claude", at: "" }, confidence: 0.78,
  },
  {
    author: "jeanmarc", zone: "compta", kind: "procedure", title: "Préparer l'export mensuel pour le cabinet Durand",
    body: "1. Clôturer les rapprochements Qonto.\n2. Exporter le FEC depuis Pennylane.\n3. Joindre les justificatifs Swile.\n4. Envoyer avant le 5 du mois.",
    entities: [{ type: "tool", name: "Pennylane" }, { type: "client", name: "Cabinet Durand" }, { type: "tool", name: "Swile" }],
    source: { app: "Claude", tool: "claude", at: "" }, confidence: 0.85,
  },
  {
    author: "leo", zone: "produit", kind: "decision", title: "Créneaux de retrait des précommandes par tranches de 30 minutes",
    body: "Les boulangers veulent lisser l'affluence du samedi matin ; 30 minutes est le meilleur compromis d'après les interviews.",
    entities: [{ type: "project", name: "Précommandes" }],
    source: { app: "Claude", tool: "claude", at: "" }, confidence: 0.8,
  },
  {
    author: "ines", zone: "dev", kind: "fact", title: "Le mode hors ligne de la caisse perd les tickets au-delà de 500 ventes",
    body: "La file IndexedDB est plafonnée ; à corriger avant la PWA. Repro : script e2e caisse-offline.spec.ts.",
    entities: [{ type: "project", name: "Caisse" }, { type: "tool", name: "Playwright" }],
    source: { app: "Terminal", tool: "claude-code", at: "" }, confidence: 0.76,
  },
]

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

async function scene(vs: Record<string, Viewer>, freshIndex: number) {
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
  // De temps en temps, brain-sync remonte une nouvelle connaissance.
  if (Math.random() < 0.45) {
    const f = FRESH[freshIndex % FRESH.length]
    const author = vs[f.author] ?? v
    const { author: _a, ...item } = f
    await ingestItems(author, [{ ...item, source: { ...item.source, at: new Date().toISOString() } }])
    console.log(`  ↳ brain-sync : « ${f.title} » (${f.zone})`)
    return true
  }
  await recordEvents(v, [{ agent, type: "stopped", session_id: session }])
  return false
}

async function main() {
  const vs = await viewers()
  let fresh = 0
  console.log(`Simulation sur le cerveau (${getStore().kind}). Ouvrez le dashboard pour voir les zones s'allumer.`)
  do {
    if (await scene(vs, fresh)) fresh++
    if (!once) await sleep(1500 + Math.random() * 2500)
  } while (!once)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
