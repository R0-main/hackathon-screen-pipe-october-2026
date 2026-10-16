// Test de fumée du cerveau sur le stockage courant (fichier ou Postgres) : npm run smoke
import { getStore } from "../lib/store"
import { getAccess } from "../lib/access"
import { getPersonContext, getState, ingestItems, queryBrain, recordEvents, refreshStatus, runAutomationDetection } from "../lib/brain"
import type { Viewer } from "../lib/auth"

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(`ÉCHEC : ${msg}`)
  console.log(`✓ ${msg}`)
}

async function viewer(name: string): Promise<Viewer> {
  const p = (await getStore().listProfiles()).find((x) => x.name.startsWith(name))
  if (!p) throw new Error(`profil ${name} introuvable (lancez le seed)`)
  return { profile: p, real: p, access: await getAccess(p) }
}

async function main() {
  const store = getStore()
  console.log(`Stockage : ${store.kind}`)
  const claire = await viewer("Claire")
  const jm = await viewer("Jean-Marc")
  const hugo = await viewer("Hugo")

  assert(claire.access.isAdmin && claire.access.readable.length >= 6, "l'admin lit toutes les zones")
  assert(jm.access.readable.join() === "compta", "Jean-Marc ne lit que la compta")

  const devForJm = await queryBrain(jm, { query: "déployer en production" })
  assert(devForJm.items.length === 0, "RLS : la compta ne voit rien de la zone dev")
  assert(devForJm.zones_restricted.includes("dev"), "la zone dev est signalée comme restreinte")
  const devForHugo = await queryBrain(hugo, { query: "déployer en production" })
  assert(devForHugo.items.some((i) => i.title.includes("Déployer Fournil")), "Hugo trouve la procédure de déploiement")
  const compta = await queryBrain(jm, { query: "rapprochement Qonto Pennylane" })
  assert(compta.items[0]?.zone === "compta" && compta.zones_hit.includes("compta"), "Jean-Marc trouve le rapprochement, la zone compta s'allume")

  const before = (await store.zoneStats()).find((z) => z.zone === "dev")?.count ?? 0
  const res = await ingestItems(hugo, [
    {
      zone: "inconnue", kind: "task", title: "Ajouter un index sur les précommandes", body: "TODO avant la mise en prod. Contact : hugo@fournil.example, clé sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
      entities: [{ type: "tool", name: "Postgres" }], source: { app: "Terminal", tool: "claude-code", at: new Date().toISOString() }, confidence: 0.7,
    },
  ])
  const item = await store.getItem(res.ids[0])
  assert(item && item.zone === "dev", "une zone inconnue est reclassée (dev)")
  assert(item && !item.body.includes("sk-ant") && !item.body.includes("@fournil"), "secrets et emails masqués côté serveur")
  assert(((await store.zoneStats()).find((z) => z.zone === "dev")?.count ?? 0) === before + 1, "le compteur de la zone dev augmente")
  assert((await store.listTasks({ zones: ["dev"] })).some((t) => t.source_item_id === res.ids[0]), "une tâche est créée depuis l'item")

  const evs = await recordEvents(hugo, [{ agent: "claude-code", type: "query", summary: "corrige le bug du webhook stripe en prod" }])
  assert(evs[0].zones.includes("dev"), "un prompt sans zone est classé (dev)")
  const after = await store.listEvents({ afterId: evs[0].id - 1, limit: 10 })
  assert(after[0]?.id === evs[0].id, "le flux temps réel relit les événements dans l'ordre")

  const stJm = await getState(jm)
  assert(stJm.items.every((i) => i.zone === "compta"), "l'état de Jean-Marc ne contient que la compta")
  assert(stJm.zones.find((z) => z.id === "dev")?.locked === true, "la zone dev est verrouillée pour Jean-Marc")
  assert(stJm.automations.every((a) => a.user_id === jm.profile.id), "Jean-Marc ne voit que ses automatisations")

  const autos = await runAutomationDetection()
  assert(autos.some((a) => a.title.includes("Qonto")), "l'automatisation du rapprochement de 9 h est détectée")
  const status = await refreshStatus(claire)
  assert(status.zones.length >= 6 && status.headline.length > 10, `état de l'entreprise généré (${status.generator})`)
  const ctx = await getPersonContext(claire, hugo.profile.id)
  assert(ctx && ctx.zones[0]?.zone === "dev" && ctx.items.length > 0, "contexte de passation de Hugo")

  assert(await store.deleteItem(res.ids[0]), "l'auteur peut supprimer une connaissance")
  console.log("\nTout est vert.")
  if ("end" in store) await (store as unknown as { end: () => Promise<void> }).end()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
