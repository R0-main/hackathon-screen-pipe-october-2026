// Entreprise fictive pour la démo : Fournil, SaaS de gestion pour boulangeries artisanales.

import type { Entity, KnowledgeKind, Role } from "@brain/core"

export const DEMO_ORG = {
  name: "Fournil",
  description:
    "Fournil édite un logiciel de caisse, de stocks et de précommandes pour les boulangeries artisanales. 85 boulangeries clientes, 6 personnes, basée à Paris.",
}

export type DemoUser = { key: string; name: string; title: string; role: Role; zones: string[]; email: string }

export const DEMO_USERS: DemoUser[] = [
  { key: "claire", name: "Claire Martin", title: "CEO", role: "admin", zones: [], email: "claire@fournil.example" },
  { key: "hugo", name: "Hugo Bernard", title: "Lead dev", role: "member", zones: ["dev", "produit", "support"], email: "hugo@fournil.example" },
  { key: "ines", name: "Inès Lefèvre", title: "Développeuse full-stack", role: "member", zones: ["dev", "produit"], email: "ines@fournil.example" },
  { key: "jeanmarc", name: "Jean-Marc Dubois", title: "Responsable compta", role: "member", zones: ["compta"], email: "jean-marc@fournil.example" },
  { key: "sarah", name: "Sarah Cohen", title: "Head of Sales", role: "member", zones: ["sales", "support", "produit"], email: "sarah@fournil.example" },
  { key: "leo", name: "Léo Petit", title: "Product manager", role: "member", zones: ["produit", "dev", "support", "sales"], email: "leo@fournil.example" },
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
    body: "Stripe Billing gère la proration, les essais gratuits et la facturation annuelle demandée par les clients multi-boutiques. Checkout reste utilisé pour les achats ponctuels (matériel). Décidé avec Léo.",
    entities: [t("Stripe"), p("Léo Petit"), pr("Abonnements")],
  },
  {
    author: "hugo", zone: "dev", kind: "procedure", daysAgo: 8, tool: "claude-code",
    title: "Déployer Fournil en production",
    body: "1. Merger sur main via une PR approuvée.\n2. La CI GitHub Actions lance les tests et applique les migrations Supabase sur staging.\n3. Créer le tag vX.Y.Z : Vercel déploie la prod.\n4. Surveiller Sentry pendant 15 minutes ; rollback via « Promote » de la release précédente sur Vercel.",
    entities: [t("GitHub"), t("Supabase"), t("Vercel"), t("Sentry")],
  },
  {
    author: "ines", zone: "dev", kind: "fact", daysAgo: 7, tool: "claude-code",
    title: "Les terminaux SumUp se déconnectent après 30 min d'inactivité",
    body: "Le SDK SumUp coupe la session Bluetooth au bout de 30 minutes. Contournement en place : un keepalive toutes les 10 minutes dans le service caisse (caisse/sumup-keepalive.ts).",
    entities: [t("SumUp"), pr("Caisse")],
  },
  {
    author: "hugo", zone: "dev", kind: "decision", daysAgo: 6, tool: "claude-code",
    title: "Isolation des boulangeries par RLS Supabase plutôt que par schémas séparés",
    body: "Toutes les tables métier portent un bakery_id et des politiques RLS. Un schéma par client aurait compliqué les migrations pour 85 boulangeries.",
    entities: [t("Supabase"), t("Postgres")],
  },
  {
    author: "ines", zone: "dev", kind: "task", daysAgo: 3, tool: "claude-code",
    title: "Corriger le calcul des stocks négatifs sur les viennoiseries",
    body: "Les retours d'invendus sont décomptés deux fois quand la boutique clôture la journée hors ligne.",
    entities: [pr("Stocks")],
  },
  {
    author: "ines", zone: "dev", kind: "task", daysAgo: 5, tool: "claude-code", done: true,
    title: "Ajouter des tests e2e Playwright sur le parcours de commande",
    body: "Couvre la création de commande, le paiement et l'impression du ticket.",
    entities: [t("Playwright"), pr("Précommandes")],
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
    body: "1. Télécharger le backup quotidien depuis le dashboard Supabase.\n2. supabase db reset --linked sur staging.\n3. Restaurer avec pg_restore --no-owner.\n4. Relancer les migrations manquantes puis vérifier le nombre de boulangeries.",
    entities: [t("Supabase"), t("Postgres")],
  },
  {
    author: "ines", zone: "dev", kind: "question", daysAgo: 1, tool: "claude-code",
    title: "Faut-il passer l'app caisse en offline-first (PWA) ?",
    body: "Les coupures réseau du matin causent la moitié des tickets de synchro. Une PWA avec file d'attente locale réglerait le problème mais demande ~3 semaines.",
    entities: [pr("Caisse")],
  },
  // --- Produit ---
  {
    author: "leo", zone: "produit", kind: "decision", daysAgo: 9, tool: "claude",
    title: "Priorité du trimestre : le module de précommandes en ligne",
    body: "Objectif T4 : permettre aux clients des boulangeries de précommander le pain et les gâteaux du week-end. C'est la demande n°1 des boulangers interrogés.",
    entities: [pr("Précommandes")],
  },
  {
    author: "leo", zone: "produit", kind: "fact", daysAgo: 8, tool: "claude",
    title: "Les boulangers utilisent l'app surtout entre 5 h et 7 h du matin",
    body: "D'où le mode sombre par défaut, les gros boutons et l'absence de saisie clavier sur l'écran de fournée.",
    entities: [pr("Caisse")],
  },
  {
    author: "sarah", zone: "produit", kind: "fact", daysAgo: 6, tool: "chatgpt",
    title: "La Mie Dorée considère l'export des ventes vers Excel comme indispensable",
    body: "Leur comptable retraite les ventes par boutique dans Excel chaque semaine. Sans export, pas de signature.",
    entities: [c("La Mie Dorée"), t("Excel")],
  },
  {
    author: "leo", zone: "produit", kind: "task", daysAgo: 4, tool: "claude",
    title: "Rédiger la spec du module de précommandes",
    body: "Parcours client, créneaux de retrait, paiement en ligne optionnel, notifications SMS.",
    entities: [pr("Précommandes")],
  },
  {
    author: "leo", zone: "produit", kind: "decision", daysAgo: 3, tool: "claude",
    title: "Pas de multi-boutiques dans la première version des précommandes",
    body: "On livre d'abord pour une boutique unique ; le multi-boutiques viendra en janvier avec La Mie Dorée comme client pilote.",
    entities: [pr("Précommandes"), c("La Mie Dorée")],
  },
  {
    author: "leo", zone: "produit", kind: "fact", daysAgo: 2, tool: "claude",
    title: "Objectif produit : 40 % des boulangeries actives sur les précommandes fin décembre",
    body: "Mesuré par au moins une précommande par semaine. Suivi dans le tableau de bord produit.",
    entities: [pr("Précommandes")],
  },
  // --- Sales ---
  {
    author: "sarah", zone: "sales", kind: "fact", daysAgo: 7, tool: "chatgpt",
    title: "La Mie Dorée (12 boutiques) prête à signer si l'export comptable arrive en novembre",
    body: "Contrat estimé à 7 000 €/an. Décideur : la directrice financière. Prochaine étape : démo de l'export le 5 novembre.",
    entities: [c("La Mie Dorée")],
  },
  {
    author: "sarah", zone: "sales", kind: "fact", daysAgo: 5, tool: "claude",
    title: "Pipeline d'octobre : 18 prospects, 6 démos planifiées, 3 négociations",
    body: "Les trois négociations : La Mie Dorée, Maison Kayser Lyon et Au Pain d'Antan. Taux de conversion démo → signature de 35 % sur le trimestre.",
    entities: [c("La Mie Dorée"), c("Maison Kayser Lyon"), c("Au Pain d'Antan"), t("HubSpot")],
  },
  {
    author: "claire", zone: "sales", kind: "decision", daysAgo: 6, tool: "claude",
    title: "Nouveau prix : 49 € par mois et par boutique, -20 % en annuel",
    body: "Aligné sur la concurrence directe et compatible avec l'objectif de MRR. Les clients existants gardent leur tarif jusqu'en juin.",
    entities: [pr("Abonnements")],
  },
  {
    author: "sarah", zone: "sales", kind: "procedure", daysAgo: 4, tool: "claude",
    title: "Préparer une démo Fournil",
    body: "1. Créer une boulangerie de démo depuis l'admin (bouton « Démo »).\n2. Importer le catalogue type (pains, viennoiseries, pâtisseries).\n3. Montrer la fournée du matin, la caisse puis l'export des ventes.\n4. Finir sur les précommandes (maquettes Figma tant que le module n'est pas livré).",
    entities: [t("Figma"), pr("Précommandes")],
  },
  {
    author: "sarah", zone: "sales", kind: "task", daysAgo: 2, tool: "claude",
    title: "Relancer Maison Kayser Lyon après le salon Europain",
    body: "Ils attendaient le nouveau pricing annuel. Envoyer la proposition avant vendredi.",
    entities: [c("Maison Kayser Lyon")],
  },
  {
    author: "sarah", zone: "sales", kind: "fact", daysAgo: 1, tool: "chatgpt",
    title: "Le salon Europain génère 40 % des leads de l'année",
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
    body: "Fin des tableurs : chaque dépense est photographiée dans Swile et synchronisée avec Pennylane.",
    entities: [t("Swile"), t("Pennylane")],
  },
  {
    author: "jeanmarc", zone: "compta", kind: "fact", daysAgo: 5, tool: "claude",
    title: "Burn mensuel d'environ 62 k€, runway de 14 mois au 1er octobre",
    body: "Hors levée de fonds. Le passage au pricing annuel améliorerait le BFR dès le premier trimestre 2027.",
    entities: [],
  },
  {
    author: "jeanmarc", zone: "compta", kind: "task", daysAgo: 3, tool: "claude",
    title: "Déclarer la TVA de septembre avant le 19 octobre",
    body: "Montant estimé : 8 400 €. Vérifier l'autoliquidation sur les achats de matériel SumUp.",
    entities: [t("SumUp")],
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
    title: "Réinitialiser l'imprimante de tickets d'une boutique",
    body: "1. Éteindre l'imprimante 10 secondes.\n2. Dans l'app : Réglages > Périphériques > Oublier l'imprimante.\n3. Ré-appairer en Bluetooth en maintenant le bouton FEED.\n4. Imprimer un ticket test.",
    entities: [pr("Caisse")],
  },
  {
    author: "leo", zone: "support", kind: "fact", daysAgo: 4, tool: "claude",
    title: "Top 3 des tickets d'octobre : imprimante, synchro caisse, export Excel",
    body: "62 tickets au total, dont 24 sur l'imprimante. L'export Excel et la PWA hors ligne supprimeraient la moitié du volume.",
    entities: [t("Excel"), pr("Caisse")],
  },
  {
    author: "sarah", zone: "support", kind: "task", daysAgo: 1, tool: "claude",
    title: "Écrire la FAQ sur la synchronisation hors ligne",
    body: "Expliquer ce qui se passe quand la boutique perd le réseau et comment forcer une synchronisation.",
    entities: [pr("Caisse")],
  },
  // --- Direction ---
  {
    author: "claire", zone: "direction", kind: "fact", daysAgo: 9, tool: "claude",
    title: "Objectif T4 : 120 boulangeries clientes et 25 k€ de MRR",
    body: "Nous sommes à 85 boulangeries et 17,8 k€ de MRR au 1er octobre. Les précommandes et La Mie Dorée sont les deux leviers principaux.",
    entities: [c("La Mie Dorée"), pr("Précommandes")],
  },
  {
    author: "claire", zone: "direction", kind: "decision", daysAgo: 7, tool: "claude",
    title: "Levée seed reportée à mars 2027 : priorité à la rentabilité",
    body: "Avec 14 mois de runway, on préfère lever avec 30 k€ de MRR. Le board a validé le 2 octobre.",
    entities: [],
  },
  {
    author: "claire", zone: "direction", kind: "task", daysAgo: 4, tool: "claude",
    title: "Recruter un ou une développeur·se mobile d'ici janvier",
    body: "Pour la PWA caisse puis l'app de précommandes. Fiche de poste à valider avec Hugo.",
    entities: [p("Hugo Bernard")],
  },
  {
    author: "claire", zone: "direction", kind: "fact", daysAgo: 1, tool: "claude",
    title: "Board trimestriel le 12 novembre : KPIs MRR, churn et NPS",
    body: "Jean-Marc prépare les chiffres financiers, Léo le NPS et l'adoption des précommandes.",
    entities: [p("Jean-Marc Dubois"), p("Léo Petit")],
  },
]

/** Prompts typiques par zone, pour l'historique et le simulateur. */
export const DEMO_PROMPTS: Record<string, { user: string; text: string }[]> = {
  dev: [
    { user: "hugo", text: "Pourquoi le webhook Stripe invoice.paid échoue en prod ce matin ?" },
    { user: "ines", text: "Corrige le calcul des stocks quand la boutique clôture hors ligne" },
    { user: "hugo", text: "Prépare la migration Supabase pour la table des précommandes" },
    { user: "ines", text: "Écris les tests Playwright du parcours de paiement" },
  ],
  produit: [
    { user: "leo", text: "Rédige la spec des créneaux de retrait pour les précommandes" },
    { user: "leo", text: "Synthétise les retours utilisateurs sur l'écran de fournée" },
  ],
  sales: [
    { user: "sarah", text: "Prépare une proposition commerciale annuelle pour Maison Kayser Lyon" },
    { user: "sarah", text: "Résume le pipeline et les deals en négociation cette semaine" },
  ],
  compta: [
    { user: "jeanmarc", text: "Prépare la déclaration de TVA de septembre à partir de Pennylane" },
    { user: "jeanmarc", text: "Mets à jour le prévisionnel de trésorerie avec les versements Stripe" },
  ],
  support: [
    { user: "hugo", text: "Pourquoi l'imprimante de tickets de la boutique Rivoli ne répond plus ?" },
    { user: "sarah", text: "Rédige la réponse au ticket sur l'export Excel des ventes" },
  ],
  direction: [
    { user: "claire", text: "Prépare les KPIs MRR et churn pour le board du 12 novembre" },
    { user: "claire", text: "Quel est l'état d'avancement des objectifs du trimestre ?" },
  ],
}

/** Le prompt que Jean-Marc lance chaque matin vers 9 h : la suggestion d'automatisation de la démo. */
export const JEANMARC_DAILY_PROMPT = "Rapproche les relevés Qonto d'hier avec les factures Pennylane et liste les écarts"
