// Prompts de distillation partagés (SDK Claude côté serveur / poste, et `claude -p` en repli sur le poste).

import type { Conversation, ZoneHint } from "./distill"
import { renderConversation } from "./distill"
import type { StatusInput } from "./status"
import { truncate } from "./text"

export const DISTILL_MARKER = "[company-brain:distill]"

export const DISTILL_SYSTEM = `Tu alimentes le « cerveau » d'une entreprise : une base de connaissances partagée entre les équipes.
On te donne une session de travail entre un employé et un assistant IA (Claude Code, Codex, ChatGPT…), déjà filtrée sur le poste,
ou la transcription d'une réunion (outil « meeting », lignes « Prénom : texte »). Pour une réunion, les décisions, les engagements
(qui fait quoi, pour quand) et les faits annoncés priment ; une opinion en l'air n'est pas une décision.
Ton travail : en extraire uniquement la connaissance RÉUTILISABLE par l'entreprise.

À garder :
- decision : un choix tranché (technique, produit, commercial, financier) et sa raison.
- procedure : une façon de faire reproductible (étapes, commandes, règles).
- fact : un fait durable sur un client, un projet, un outil, un chiffre, une contrainte.
- task : quelque chose qui reste à faire, avec le responsable s'il est connu.
- question : une question ouverte importante restée sans réponse.

À ignorer absolument :
- tout contenu personnel ou sans rapport avec le travail : achats et prix pour soi (le prix d'une PS5 Pro, d'un téléphone,
  d'un billet pour ses vacances), loisirs, jeux, sport, cuisine, sorties, actualité ou culture générale sans lien avec
  l'activité de l'entreprise. Dans une session mixte, ignore ces passages et garde le reste ; si toute la session est hors
  travail, ne renvoie aucun item (pas même un item pour dire qu'elle a été ignorée) ;
- secrets, mots de passe, clés, emails, numéros de téléphone (même masqués) ;
- le bavardage, les tâtonnements, les erreurs corrigées, le code brut (résume ce qu'il fait plutôt que de le recopier).

Règles d'écriture :
- en français, concis, compréhensible par un collègue qui n'a pas vu la session ;
- title : une phrase courte et précise (≤ 120 caractères) ;
- body : 1 à 5 phrases, avec le « pourquoi » quand il existe ;
- zone : obligatoirement l'un des identifiants de zone fournis ;
- entities : personnes, projets, clients, outils, documents explicitement cités ;
- confidence : entre 0 et 1, ta confiance que c'est exact et utile ;
- au plus 6 items ; aucun item si rien ne mérite d'être retenu.`

export function renderZones(zones: ZoneHint[]): string {
  return zones.map((z) => `- ${z.id} : ${z.name} — ${z.description}`).join("\n")
}

export function buildTriagePrompt(conv: Conversation, zones: ZoneHint[]): string {
  return `Zones de l'entreprise :
${renderZones(zones)}

Cette session contient-elle de la connaissance réutilisable par l'entreprise (décision, procédure, fait durable, tâche) ?
Une session hors travail (achat ou prix d'un produit pour soi, comme une PS5 Pro, loisirs, sport, cuisine, vacances…) n'est
jamais utile : useful = faux, et la raison dit seulement « hors travail », sans en citer le contenu.
Réponds avec useful (vrai/faux), la zone la plus concernée (identifiant exact) et une raison en une phrase.

<session>
${renderConversation(conv)}
</session>`
}

export function buildExtractionPrompt(conv: Conversation, zones: ZoneHint[]): string {
  return `Zones de l'entreprise :
${renderZones(zones)}

Extrais les connaissances réutilisables de cette session.

<session>
${renderConversation(conv)}
</session>`
}

/** Version « texte » pour `claude -p` : on demande un JSON brut, analysé de façon tolérante. */
export function buildCliExtractionPrompt(conv: Conversation, zones: ZoneHint[]): string {
  return `${DISTILL_MARKER}
${DISTILL_SYSTEM}

${buildExtractionPrompt(conv, zones)}

Réponds UNIQUEMENT avec un objet JSON de la forme :
{"items":[{"zone":"<id>","kind":"fact|decision|task|procedure|question","title":"…","body":"…","entities":[{"type":"person|project|client|tool|doc","name":"…"}],"confidence":0.8}]}
Sans texte autour, sans bloc de code.`
}

export const STATUS_SYSTEM = `Tu rédiges l'écran « Où en est la boîte ? » du cerveau d'une entreprise, pour ses dirigeants.
On te donne, zone par zone, les connaissances récentes et les tâches de chaque zone. Tu produis :
- headline : 1 à 2 phrases sur l'état global de l'entreprise ; c'est le seul endroit où tu peux résumer l'ensemble des zones ;
- pour chaque zone fournie : summary (2 phrases max), objectives (0 à 3), progress (une phrase sur l'avancement),
  next_steps (0 à 3 prochaines étapes concrètes), who_did_what (qui a fait quoi, 0 à 4 lignes, avec le prénom de la personne).
Cloisonnement strict : la section d'une zone s'appuie UNIQUEMENT sur les connaissances et les tâches listées sous cette zone.
N'y cite jamais un fait, un chiffre, un client ou une personne qui n'apparaît que dans une autre zone : certains lecteurs
ne voient que quelques zones.
Factuel, en français, sans inventer : si une zone est vide, dis-le simplement.
Formulations neutres : ne présume jamais du genre d'une personne (pas d'accord au féminin ou au masculin deviné d'après un prénom).`

/** Corps du prompt de résumé : entreprise, date, puis une section par zone avec SES connaissances et SES tâches. */
export function buildStatusPrompt(input: StatusInput): string {
  const sections = input.zones.map((z) => {
    const items = input.items
      .filter((i) => i.zone === z.id)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, 40)
      .map((i) => `- [${i.kind}] ${truncate(i.title, 160)} — ${truncate(i.body.replace(/\s+/g, " "), 220)} (par ${i.author}, ${i.created_at.slice(0, 10)})`)
    const tasks = input.tasks
      .filter((t) => t.zone === z.id)
      .sort((a, b) => Number(a.status === "done") - Number(b.status === "done"))
      .slice(0, 20)
      .map((t) => `- [${t.status === "done" ? "fait" : "à faire"}] ${truncate(t.title, 160)}${t.assignee ? ` (${t.assignee})` : ""}`)
    return (
      `## Zone ${z.id} (${z.name})${z.description ? ` — ${z.description}` : ""}\n` +
      `Connaissances récentes de cette zone :\n${items.join("\n") || "(aucune)"}\n` +
      `Tâches de cette zone :\n${tasks.join("\n") || "(aucune)"}`
    )
  })
  return `Entreprise : ${input.company_name}\nDate : ${input.generated_for}\n\n${sections.join("\n\n")}`
}

/**
 * Version « texte » pour `claude -p` sur le poste d'un admin (abonnement Claude, sans clé API).
 * Commence par DISTILL_MARKER : brain-sync n'ingère jamais cette session.
 */
export function buildCliStatusPrompt(input: StatusInput): string {
  return `${DISTILL_MARKER}
${STATUS_SYSTEM}

${buildStatusPrompt(input)}

Réponds UNIQUEMENT avec un objet JSON de la forme :
{"headline":"…","zones":[{"zone":"<id>","summary":"…","objectives":["…"],"progress":"…","next_steps":["…"],"who_did_what":[{"person":"…","did":"…"}]}]}
Une entrée par zone fournie, avec son identifiant exact (${input.zones.map((z) => z.id).join(", ") || "aucune zone"}).
Sans texte autour, sans bloc de code.`
}

export const ONBOARDING_SYSTEM = `Tu construis la première version du « cerveau » d'une entreprise à partir d'une interview de son dirigeant
et du contenu de quelques pages web qu'il a fournies.
Tu produis :
- company_name et description (2-3 phrases) ;
- zones : 4 à 8 domaines de connaissance (id court en minuscules sans accents, name, description, 10 à 25 keywords sans accents
  qui servent à classer automatiquement les sessions de travail) ; réutilise les zones existantes fournies quand elles conviennent ;
- items : 8 à 25 connaissances de départ (mêmes règles que pour une session : fact, decision, procedure, task, question),
  chacune rattachée à une zone.
En français, factuel, sans inventer ce qui n'est pas dans l'interview ou les pages.`
