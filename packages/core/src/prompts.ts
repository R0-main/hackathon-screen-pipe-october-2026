// Prompts de distillation partagés (SDK Claude côté serveur / poste, et `claude -p` en repli sur le poste).

import type { Conversation, ZoneHint } from "./distill"
import { renderConversation } from "./distill"

export const DISTILL_MARKER = "[company-brain:distill]"

export const DISTILL_SYSTEM = `Tu alimentes le « cerveau » d'une entreprise : une base de connaissances partagée entre les équipes.
On te donne une session de travail entre un employé et un assistant IA (Claude Code, Codex, ChatGPT…), déjà filtrée sur le poste.
Ton travail : en extraire uniquement la connaissance RÉUTILISABLE par l'entreprise.

À garder :
- decision : un choix tranché (technique, produit, commercial, financier) et sa raison.
- procedure : une façon de faire reproductible (étapes, commandes, règles).
- fact : un fait durable sur un client, un projet, un outil, un chiffre, une contrainte.
- task : quelque chose qui reste à faire, avec le responsable s'il est connu.
- question : une question ouverte importante restée sans réponse.

À ignorer absolument :
- tout contenu personnel ou sans rapport avec le travail ;
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
À partir des connaissances récentes et des tâches de chaque zone, tu produis :
- headline : 1 à 2 phrases sur l'état global de l'entreprise cette semaine ;
- pour chaque zone fournie : summary (2 phrases max), objectives (0 à 3), progress (une phrase sur l'avancement),
  next_steps (0 à 3 prochaines étapes concrètes), who_did_what (qui a fait quoi, 0 à 4 lignes, avec le prénom de la personne).
Factuel, en français, sans inventer : si une zone est vide, dis-le simplement.`

export const ONBOARDING_SYSTEM = `Tu construis la première version du « cerveau » d'une entreprise à partir d'une interview de son dirigeant
et du contenu de quelques pages web qu'il a fournies.
Tu produis :
- company_name et description (2-3 phrases) ;
- zones : 4 à 8 domaines de connaissance (id court en minuscules sans accents, name, description, 10 à 25 keywords sans accents
  qui servent à classer automatiquement les sessions de travail) ; réutilise les zones existantes fournies quand elles conviennent ;
- items : 8 à 25 connaissances de départ (mêmes règles que pour une session : fact, decision, procedure, task, question),
  chacune rattachée à une zone.
En français, factuel, sans inventer ce qui n'est pas dans l'interview ou les pages.`
