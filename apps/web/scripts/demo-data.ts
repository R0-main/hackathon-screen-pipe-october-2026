// Entreprise fictive pour la démo : Butine, balances connectées pour ruches et app de suivi pour les apiculteurs.

import type { Entity, KnowledgeKind, Role, SkillFile } from "@brain/core"

export const DEMO_ORG = {
  name: "Butine",
  description:
    "Butine fabrique des balances connectées pour ruches : glissée sous la ruche, la balance dit à l'apiculteur, sur son téléphone, si ses abeilles vont bien (récolte, essaimage, froid, vol), sans ouvrir la ruche. 3 200 ruches équipées chez 140 apiculteurs, 6 personnes, basée à Lyon.",
}

/** Ancien nom de l'entreprise de démo : un cerveau de démo resté sur lui est remplacé une fois par la démo actuelle. */
export const LEGACY_DEMO_NAMES = ["Fournil"]

/**
 * `manager` : clé de la personne à qui le poste est rattaché (déclarée avant dans la liste).
 * `publishSkills` : peut pousser des skills dans le cerveau (les admins le peuvent toujours).
 */
export type DemoUser = {
  key: string
  name: string
  title: string
  role: Role
  zones: string[]
  email: string
  manager?: string
  publishSkills?: boolean
}

export const DEMO_USERS: DemoUser[] = [
  { key: "claire", name: "Claire Martin", title: "CEO", role: "admin", zones: [], email: "claire@butine.example" },
  { key: "hugo", name: "Hugo Bernard", title: "Lead dev", role: "member", zones: ["dev", "produit", "support"], email: "hugo@butine.example", manager: "claire", publishSkills: true },
  { key: "ines", name: "Inès Lefèvre", title: "Développeuse full-stack", role: "member", zones: ["dev", "produit"], email: "ines@butine.example", manager: "hugo" },
  { key: "jeanmarc", name: "Jean-Marc Dubois", title: "Responsable compta", role: "member", zones: ["compta"], email: "jean-marc@butine.example", manager: "claire", publishSkills: true },
  { key: "sarah", name: "Sarah Cohen", title: "Head of Sales", role: "member", zones: ["sales", "support", "produit"], email: "sarah@butine.example", manager: "claire" },
  { key: "leo", name: "Léo Petit", title: "Product manager", role: "member", zones: ["produit", "dev", "support", "sales"], email: "leo@butine.example", manager: "claire" },
]

export type DemoItem = {
  author: string
  zone: string
  kind: KnowledgeKind
  title: string
  body: string
  entities: Entity[]
  daysAgo: number
  tool?: "claude-code" | "codex" | "chatgpt" | "claude"
  done?: boolean
}

const t = (name: string): Entity => ({ type: "tool", name })
const c = (name: string): Entity => ({ type: "client", name })
const p = (name: string): Entity => ({ type: "person", name })
const pr = (name: string): Entity => ({ type: "project", name })

export const DEMO_ITEMS: DemoItem[] = [
  // --- Dev ---
  {
    author: "hugo", zone: "dev", kind: "decision", daysAgo: 9, tool: "claude-code",
    title: "Les abonnements passent de Stripe Checkout à Stripe Billing",
    body: "Stripe Billing gère la facturation à la ruche (la quantité change dès qu'un apiculteur ajoute une balance), les essais gratuits et l'annuel demandé par les coopératives. Checkout reste utilisé pour la vente des balances. Décidé avec Léo.",
    entities: [t("Stripe"), p("Léo Petit"), pr("Abonnements")],
  },
  {
    author: "hugo", zone: "dev", kind: "procedure", daysAgo: 8, tool: "claude-code",
    title: "Déployer Butine en production",
    body: "1. Merger sur main via une PR approuvée.\n2. La CI GitHub Actions lance les tests et applique les migrations Supabase sur staging.\n3. Créer le tag vX.Y.Z : Vercel déploie l'API et l'app web.\n4. Surveiller Sentry pendant 15 minutes ; rollback via « Promote » de la release précédente sur Vercel.\nLe firmware des balances ne part jamais avec ce tag : il a sa propre mise à jour à distance, par lots de 5 %.",
    entities: [t("GitHub"), t("Supabase"), t("Vercel"), t("Sentry")],
  },
  {
    author: "ines", zone: "dev", kind: "fact", daysAgo: 7, tool: "claude-code",
    title: "Les balances dérivent de 300 g par nuit de gel",
    body: "La jauge de poids se contracte sous 0 °C : sans correction, l'app voyait les ruches maigrir chaque nuit d'hiver. Compensation en température en place dans le service mesures (mesures/compensation-froid.ts).",
    entities: [pr("Balance B2"), pr("Mesures")],
  },
  {
    author: "hugo", zone: "dev", kind: "decision", daysAgo: 6, tool: "claude-code",
    title: "Isolation des apiculteurs par RLS Supabase plutôt que par schémas séparés",
    body: "Toutes les tables métier portent un beekeeper_id et des politiques RLS. Un schéma par client aurait compliqué les migrations pour 140 apiculteurs.",
    entities: [t("Supabase"), t("Postgres")],
  },
  {
    author: "ines", zone: "dev", kind: "task", daysAgo: 3, tool: "claude-code",
    title: "Corriger les fausses alertes d'essaimage pendant la récolte",
    body: "Retirer une hausse pleine fait chuter le poids de 15 kg d'un coup : l'algorithme y voit un essaim qui part. Ignorer les chutes quand l'apiculteur a signalé une visite.",
    entities: [pr("Alerte essaimage"), pr("Mesures")],
  },
  {
    author: "ines", zone: "dev", kind: "task", daysAgo: 5, tool: "claude-code", done: true,
    title: "Ajouter des tests e2e Playwright sur l'installation d'une balance",
    body: "Couvre l'appairage, le choix du rucher et la première pesée affichée dans l'app.",
    entities: [t("Playwright"), pr("Balance B2")],
  },
  {
    author: "hugo", zone: "dev", kind: "fact", daysAgo: 4, tool: "codex",
    title: "Le webhook Stripe invoice.paid peut arriver avant la création du client",
    body: "On rend le handler idempotent (clé = event.id) et on réessaie trois fois avec backoff si le client n'existe pas encore.",
    entities: [t("Stripe"), pr("Abonnements")],
  },
  {
    author: "hugo", zone: "dev", kind: "procedure", daysAgo: 2, tool: "claude-code",
    title: "Restaurer une sauvegarde Supabase sur staging",
    body: "1. Télécharger le backup quotidien depuis le dashboard Supabase.\n2. supabase db reset --linked sur staging.\n3. Restaurer avec pg_restore --no-owner.\n4. Relancer les migrations manquantes puis vérifier le nombre de ruches.",
    entities: [t("Supabase"), t("Postgres")],
  },
  {
    author: "ines", zone: "dev", kind: "question", daysAgo: 1, tool: "claude-code",
    title: "Faut-il garder les pesées sur la balance quand le réseau LoRa tombe ?",
    body: "Les ruchers de montagne perdent le réseau des journées entières : c'est la moitié des tickets « balance muette ». Une mémoire tampon de 7 jours réglerait le problème mais demande un nouveau firmware (~3 semaines).",
    entities: [pr("Balance B2"), t("LoRaWAN")],
  },
  // --- Produit ---
  {
    author: "leo", zone: "produit", kind: "decision", daysAgo: 9, tool: "claude",
    title: "Priorité du trimestre : l'alerte essaimage",
    body: "Objectif T4 : prévenir l'apiculteur dans l'heure quand une colonie essaime (chute de poids brutale, bourdonnement qui monte). C'est la demande n°1 des apiculteurs interrogés : un essaim perdu, c'est la moitié de la récolte de la ruche.",
    entities: [pr("Alerte essaimage")],
  },
  {
    author: "leo", zone: "produit", kind: "fact", daysAgo: 8, tool: "claude",
    title: "Les apiculteurs ouvrent l'app au rucher, gants aux mains",
    body: "D'où les très gros boutons, le contraste maximal en plein soleil et l'absence de saisie clavier sur l'écran de visite.",
    entities: [pr("App Butine")],
  },
  {
    author: "sarah", zone: "produit", kind: "fact", daysAgo: 6, tool: "chatgpt",
    title: "Miellerie Roussel considère l'export des pesées vers Excel comme indispensable",
    body: "Leur technicien suit la miellée ruche par ruche dans Excel chaque semaine. Sans export, pas de signature.",
    entities: [c("Miellerie Roussel"), t("Excel")],
  },
  {
    author: "leo", zone: "produit", kind: "task", daysAgo: 4, tool: "claude",
    title: "Rédiger la spec de l'alerte essaimage",
    body: "Seuils de chute de poids, confirmation par le son, notification push et SMS, mode « je suis au rucher » qui coupe les alertes pendant la visite.",
    entities: [pr("Alerte essaimage")],
  },
  {
    author: "leo", zone: "produit", kind: "decision", daysAgo: 3, tool: "claude",
    title: "Pas de détection du frelon asiatique dans la première version",
    body: "On livre d'abord l'alerte essaimage ; la détection du frelon par le son viendra en mars, avec Miellerie Roussel comme client pilote.",
    entities: [pr("Alerte essaimage"), pr("Détection frelon"), c("Miellerie Roussel")],
  },
  {
    author: "leo", zone: "produit", kind: "fact", daysAgo: 2, tool: "claude",
    title: "Objectif produit : 50 % des apiculteurs avec l'alerte essaimage activée fin décembre",
    body: "Mesuré par au moins une ruche suivie avec l'alerte activée. Suivi dans le tableau de bord produit.",
    entities: [pr("Alerte essaimage")],
  },
  // --- Sales ---
  {
    author: "sarah", zone: "sales", kind: "fact", daysAgo: 7, tool: "chatgpt",
    title: "Miellerie Roussel (900 ruches) prête à signer si l'export des pesées arrive en novembre",
    body: "Contrat annuel estimé à 35 000 €. Décideuse : la gérante. Prochaine étape : démo de l'export le 5 novembre.",
    entities: [c("Miellerie Roussel")],
  },
  {
    author: "sarah", zone: "sales", kind: "fact", daysAgo: 5, tool: "claude",
    title: "Pipeline d'octobre : 22 prospects, 7 démos planifiées, 3 négociations",
    body: "Les trois négociations : Miellerie Roussel, Hôtels Céleste et Coop'Apis Provence. Taux de conversion démo → signature de 35 % sur le trimestre.",
    entities: [c("Miellerie Roussel"), c("Hôtels Céleste"), c("Coop'Apis Provence"), t("HubSpot")],
  },
  {
    author: "claire", zone: "sales", kind: "decision", daysAgo: 6, tool: "claude",
    title: "Nouveau prix : 4 € par ruche et par mois, -20 % en annuel",
    body: "La balance reste vendue 149 €. Aligné sur la concurrence directe et compatible avec l'objectif de MRR. Les clients existants gardent leur tarif jusqu'en juin.",
    entities: [pr("Abonnements")],
  },
  {
    author: "sarah", zone: "sales", kind: "procedure", daysAgo: 4, tool: "claude",
    title: "Préparer une démo Butine",
    body: "1. Créer un rucher de démo depuis l'admin (bouton « Démo »).\n2. Charger une saison type (miellée d'acacia, essaimage en mai, hivernage).\n3. Montrer la courbe de poids, l'alerte d'une ruche qui s'allège puis l'export des pesées.\n4. Finir sur l'alerte essaimage (maquettes Figma tant que le module n'est pas livré).",
    entities: [t("Figma"), pr("Alerte essaimage")],
  },
  {
    author: "sarah", zone: "sales", kind: "task", daysAgo: 2, tool: "claude",
    title: "Relancer Hôtels Céleste après le congrès Miel & Ruches",
    body: "Ils veulent montrer à leurs clients les 24 ruches posées sur les toits de leurs hôtels. Envoyer la proposition avant vendredi.",
    entities: [c("Hôtels Céleste"), pr("Ruches d'entreprise")],
  },
  {
    author: "sarah", zone: "sales", kind: "fact", daysAgo: 1, tool: "chatgpt",
    title: "Le congrès Miel & Ruches génère 40 % des leads de l'année",
    body: "Budget stand 2027 à prévoir dès janvier ; inscription avant le 15 décembre pour le tarif réduit.",
    entities: [],
  },
  // --- Compta ---
  {
    author: "jeanmarc", zone: "compta", kind: "procedure", daysAgo: 9, tool: "claude",
    title: "Rapprochement bancaire quotidien Qonto ↔ Pennylane",
    body: "1. Exporter les transactions Qonto de la veille.\n2. Les rapprocher des factures et des versements Stripe dans Pennylane.\n3. Lister les écarts (paiement sans facture, facture non payée à J+30).\n4. Envoyer les écarts à Sarah pour les relances clients.",
    entities: [t("Qonto"), t("Pennylane"), t("Stripe"), p("Sarah Cohen")],
  },
  {
    author: "jeanmarc", zone: "compta", kind: "fact", daysAgo: 8, tool: "claude",
    title: "Clôture mensuelle : export Pennylane avant le 5 pour le cabinet Durand",
    body: "L'expert-comptable (cabinet Durand) produit la situation mensuelle sous 10 jours à partir de cet export.",
    entities: [t("Pennylane"), c("Cabinet Durand")],
  },
  {
    author: "jeanmarc", zone: "compta", kind: "decision", daysAgo: 6, tool: "claude",
    title: "Les notes de frais passent par Swile à partir de novembre",
    body: "Fin des tableurs, déplacements aux ruchers compris : chaque dépense est photographiée dans Swile et synchronisée avec Pennylane.",
    entities: [t("Swile"), t("Pennylane")],
  },
  {
    author: "jeanmarc", zone: "compta", kind: "fact", daysAgo: 5, tool: "claude",
    title: "Burn mensuel d'environ 48 k€, runway de 14 mois au 1er octobre",
    body: "Hors levée de fonds. Les apiculteurs achètent leurs balances entre janvier et mars : la trésorerie se creuse en hiver et remonte au printemps.",
    entities: [],
  },
  {
    author: "jeanmarc", zone: "compta", kind: "task", daysAgo: 3, tool: "claude",
    title: "Déclarer la TVA de septembre avant le 19 octobre",
    body: "Montant estimé : 6 900 €. Vérifier l'autoliquidation sur l'import des cartes électroniques des balances.",
    entities: [pr("Balance B2")],
  },
  {
    author: "jeanmarc", zone: "compta", kind: "fact", daysAgo: 2, tool: "claude",
    title: "Les paiements Stripe arrivent sur Qonto à J+7",
    body: "À prendre en compte dans le prévisionnel de trésorerie et dans le rapprochement quotidien.",
    entities: [t("Stripe"), t("Qonto")],
  },
  // --- Support ---
  {
    author: "hugo", zone: "support", kind: "procedure", daysAgo: 7, tool: "claude-code",
    title: "Réveiller une balance qui ne remonte plus de pesées",
    body: "1. Dans l'app, regarder la dernière pesée et le niveau de batterie.\n2. Batterie sous 10 % : changer les piles (lithium, jamais alcalines : elles lâchent au froid).\n3. Sinon, appuyer 5 secondes sous la balance jusqu'au clignotement bleu : elle rejoint le réseau LoRa.\n4. Attendre une pesée (15 minutes). Toujours rien : ouvrir un ticket « matériel » avec le numéro de série.",
    entities: [pr("Balance B2"), t("LoRaWAN")],
  },
  {
    author: "leo", zone: "support", kind: "fact", daysAgo: 4, tool: "claude",
    title: "Top 3 des tickets d'octobre : balance muette, fausses alertes, export Excel",
    body: "58 tickets au total, dont 22 sur des balances qui ne remontent plus (réseau LoRa en montagne). La mémoire tampon et l'export Excel supprimeraient la moitié du volume.",
    entities: [t("Excel"), pr("Balance B2")],
  },
  {
    author: "sarah", zone: "support", kind: "task", daysAgo: 1, tool: "claude",
    title: "Écrire la FAQ sur les ruchers sans réseau",
    body: "Expliquer ce qui se passe quand le rucher perd le réseau LoRa, et comment poser une antenne relais au bord du rucher.",
    entities: [t("LoRaWAN")],
  },
  // --- Direction ---
  {
    author: "claire", zone: "direction", kind: "fact", daysAgo: 9, tool: "claude",
    title: "Objectif T4 : 4 500 ruches équipées et 20 k€ de MRR",
    body: "Nous sommes à 3 200 ruches chez 140 apiculteurs et 13,4 k€ de MRR au 1er octobre. L'alerte essaimage et Miellerie Roussel sont les deux leviers principaux.",
    entities: [c("Miellerie Roussel"), pr("Alerte essaimage")],
  },
  {
    author: "claire", zone: "direction", kind: "decision", daysAgo: 7, tool: "claude",
    title: "Levée seed reportée à avril 2027 : on lève après la saison des commandes",
    body: "Les apiculteurs équipent leurs ruches entre janvier et mars : avec 14 mois de runway, on préfère lever avec les chiffres du printemps. Le board a validé le 2 octobre.",
    entities: [],
  },
  {
    author: "claire", zone: "direction", kind: "task", daysAgo: 4, tool: "claude",
    title: "Recruter un ou une ingénieur·e embarqué·e d'ici janvier",
    body: "Pour le firmware de la mémoire tampon, puis la détection du frelon par le son. Fiche de poste à valider avec Hugo.",
    entities: [p("Hugo Bernard"), pr("Détection frelon")],
  },
  {
    author: "claire", zone: "direction", kind: "fact", daysAgo: 1, tool: "claude",
    title: "Board trimestriel le 12 novembre : KPIs MRR, churn et ruches actives",
    body: "Jean-Marc prépare les chiffres financiers, Léo l'adoption de l'alerte essaimage.",
    entities: [p("Jean-Marc Dubois"), p("Léo Petit")],
  },
]

/** Prompts typiques par zone, pour l'historique et le simulateur. */
export const DEMO_PROMPTS: Record<string, { user: string; text: string }[]> = {
  dev: [
    { user: "hugo", text: "Pourquoi le webhook Stripe invoice.paid échoue en prod ce matin ?" },
    { user: "ines", text: "Corrige les fausses alertes d'essaimage quand l'apiculteur retire une hausse" },
    { user: "hugo", text: "Prépare la migration Supabase pour la table des alertes" },
    { user: "ines", text: "Écris les tests Playwright de l'appairage d'une balance" },
  ],
  produit: [
    { user: "leo", text: "Rédige la spec du mode « je suis au rucher » de l'alerte essaimage" },
    { user: "leo", text: "Synthétise les retours des apiculteurs sur l'écran de visite" },
  ],
  sales: [
    { user: "sarah", text: "Prépare une proposition annuelle pour les ruches de toit d'Hôtels Céleste" },
    { user: "sarah", text: "Résume le pipeline et les deals en négociation cette semaine" },
  ],
  compta: [
    { user: "jeanmarc", text: "Prépare la déclaration de TVA de septembre à partir de Pennylane" },
    { user: "jeanmarc", text: "Mets à jour le prévisionnel de trésorerie avec les versements Stripe" },
  ],
  support: [
    { user: "hugo", text: "Pourquoi la balance de la ruche 12 du rucher de Die ne remonte plus ?" },
    { user: "sarah", text: "Rédige la réponse au ticket sur l'export Excel des pesées" },
  ],
  direction: [
    { user: "claire", text: "Prépare les KPIs MRR et churn pour le board du 12 novembre" },
    { user: "claire", text: "Quel est l'état d'avancement des objectifs du trimestre ?" },
  ],
}

/** Le prompt que Jean-Marc lance chaque matin vers 9 h : la suggestion d'automatisation de la démo. */
export const JEANMARC_DAILY_PROMPT = "Rapproche les relevés Qonto d'hier avec les factures Pennylane et liste les écarts"

/** Skills de Butine : `zone` est le cortex qui les reçoit (null : toute l'entreprise). */
export type DemoSkill = { author: string; name: string; description: string; zone: string | null; daysAgo: number; version?: number; files: SkillFile[] }

export const DEMO_SKILLS: DemoSkill[] = [
  {
    author: "claire", name: "ton-butine", zone: null, daysAgo: 9,
    description: "Rédiger un email, un post ou une réponse client dans le ton de Butine. À utiliser pour tout texte destiné à un apiculteur.",
    files: [
      {
        path: "SKILL.md",
        content: `# Le ton de Butine

Nos clients sont des apiculteurs : ils nous lisent au rucher, gants aux mains, souvent en plein soleil.

- Vouvoyer, phrases courtes, un message = une idée.
- Parler de leur métier (colonies, miellée, hausses, visite), jamais de « solution » ou de « plateforme ».
- Pas d'emoji, pas de point d'exclamation.
- Finir par une action claire et une date quand il y en a une.
- Signer avec le prénom de la personne, suivi de « l'équipe Butine ».
`,
      },
    ],
  },
  {
    author: "hugo", name: "deployer-butine", zone: "dev", daysAgo: 8, version: 3,
    description: "Déployer Butine en production (tag, Vercel, surveillance Sentry) et revenir en arrière si besoin.",
    files: [
      {
        path: "SKILL.md",
        content: `# Déployer Butine en production

1. Vérifier que main est verte : \`gh run list --branch main --limit 1\`.
2. Lancer \`scripts/release.sh <version>\` : il crée le tag vX.Y.Z, Vercel déploie l'API et l'app web.
3. Surveiller Sentry 15 minutes (\`scripts/release.sh --watch\`).
4. En cas d'erreur nouvelle : « Promote » de la release précédente sur Vercel, puis prévenir #dev.

Les migrations Supabase sont appliquées par la CI sur staging avant le tag : ne jamais les lancer à la main en prod.
Le firmware des balances ne part jamais avec ce tag : il a sa propre mise à jour à distance, par lots de 5 %.
`,
      },
      {
        path: "scripts/release.sh",
        content: `#!/usr/bin/env bash
# Crée le tag de release (Vercel déploie la prod sur le tag), ou surveille Sentry avec --watch.
set -euo pipefail

if [[ "\${1:-}" == "--watch" ]]; then
  echo "Nouvelles erreurs Sentry des 15 dernières minutes :"
  sentry-cli issues list --project butine-api --query "firstSeen:-15m" --status unresolved
  exit 0
fi

version="\${1:?usage : release.sh 1.42.0}"
git fetch origin main --tags
if [[ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]]; then
  echo "Placez-vous sur origin/main à jour avant de taguer." >&2
  exit 1
fi
git tag -a "v$version" -m "Release v$version"
git push origin "v$version"
echo "Tag v$version poussé : Vercel déploie la prod. Lancez ensuite : $0 --watch"
`,
      },
    ],
  },
  {
    author: "jeanmarc", name: "rapprochement-qonto-pennylane", zone: "compta", daysAgo: 5, version: 2,
    description: "Rapprocher les transactions Qonto de la veille avec les factures Pennylane et lister les écarts à relancer.",
    files: [
      {
        path: "SKILL.md",
        content: `# Rapprochement Qonto ↔ Pennylane

Chaque matin, pour la veille :

1. Lancer \`python3 scripts/ecarts.py --jour hier\` : il lit l'export Qonto (CSV) et l'export des factures Pennylane.
2. Relire les écarts : paiement sans facture, facture non payée à J+30, versement Stripe incomplet.
3. Envoyer la liste des factures à relancer à Sarah (sales).

Les versements Stripe arrivent sur Qonto à J+7 : un écart Stripe de moins de 7 jours n'en est pas un.
`,
      },
      {
        path: "scripts/ecarts.py",
        content: `#!/usr/bin/env python3
"""Écarts entre l'export Qonto et les factures Pennylane (CSV exportés dans ~/Compta/exports)."""
import argparse
import csv
import datetime as dt
from pathlib import Path

EXPORTS = Path.home() / "Compta" / "exports"


def lire(fichier):
    with open(EXPORTS / fichier, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f, delimiter=";"))


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--jour", default="hier", help="hier, ou une date AAAA-MM-JJ")
    args = p.parse_args()
    jour = dt.date.today() - dt.timedelta(days=1) if args.jour == "hier" else dt.date.fromisoformat(args.jour)
    transactions = [t for t in lire(f"qonto-{jour}.csv") if t["sens"] == "credit"]
    factures = {f["numero"]: f for f in lire("pennylane-factures.csv")}
    for t in transactions:
        numero = t["reference"].strip()
        if numero not in factures:
            print(f"Paiement sans facture : {t['montant']} € ({t['libelle']})")
    for f in factures.values():
        echeance = dt.date.fromisoformat(f["echeance"])
        if f["statut"] != "payee" and (jour - echeance).days > 30:
            print(f"À relancer : facture {f['numero']} ({f['client']}, {f['montant']} €)")


if __name__ == "__main__":
    main()
`,
      },
    ],
  },
  {
    author: "claire", name: "preparer-demo-client", zone: "sales", daysAgo: 4,
    description: "Préparer la démo de Butine pour un prospect : rucher de démo, saison type, déroulé en 20 minutes.",
    files: [
      {
        path: "SKILL.md",
        content: `# Préparer une démo client

1. Créer un rucher de démo depuis l'admin (bouton « Démo »), au nom du prospect.
2. Charger une saison type (miellée d'acacia, essaimage en mai, hivernage).
3. Déroulé : courbe de poids d'une ruche, alerte d'une ruche qui s'allège, export des pesées, puis alerte essaimage.
4. Noter dans le cerveau ce que le prospect a demandé (zone Sales), avec la prochaine étape et sa date.
`,
      },
    ],
  },
  {
    author: "hugo", name: "depanner-balance", zone: "support", daysAgo: 3,
    description: "Guider un apiculteur dont la balance ne remonte plus de pesées.",
    files: [
      {
        path: "SKILL.md",
        content: `# Dépanner une balance muette

1. Dans l'app, regarder la dernière pesée et le niveau de batterie.
2. Batterie sous 10 % : changer les piles (lithium, jamais alcalines : elles lâchent au froid).
3. Sinon, appuyer 5 secondes sous la balance jusqu'au clignotement bleu : elle rejoint le réseau LoRa.
4. Attendre une pesée (15 minutes). Toujours rien : ouvrir un ticket « matériel » avec le numéro de série.
`,
      },
    ],
  },
]
