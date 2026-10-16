# Cerveau d'entreprise

> Hackathon Screenpipe « Build Agents That Remember » — 42 Paris, octobre 2026.
> Le pitch est dans [IDEA.md](IDEA.md), l'architecture dans [ARCHITECTURE.md](ARCHITECTURE.md), le déroulé de la démo dans [demo/DEMO.md](demo/DEMO.md).

Chaque employé travaille déjà avec Claude Code, Codex ou ChatGPT, mais ce contexte reste enfermé dans des sessions individuelles.
**Screenpipe** capte ces sessions sur chaque poste, **brain-sync** les distille en connaissances (décisions, procédures, faits, tâches) et les envoie à **un cerveau unique de l'entreprise**. Les agents de chacun interrogent ce cerveau via un **MCP**, avec des **accès par zone**, et le dashboard montre le cerveau s'allumer en direct.

**Le brut reste sur le PC, seul le distillé monte au cerveau.**

## Lancer la démo en 2 minutes

Prérequis : Node.js ≥ 20.

```bash
npm install
npm run seed                 # entreprise fictive « Fournil » : 6 comptes, 34 connaissances, 10 jours d'activité
BRAIN_DEMO=1 npm run dev     # http://localhost:3000 → connexion en un clic (mode démo)
npm run simulate             # dans un 2e terminal : des agents travaillent, le cerveau s'allume
```

- Connectez-vous en **Claire (CEO, admin)** pour tout voir, puis « Voir en tant que : Jean-Marc » : la compta ne voit que sa zone, et une question sur le déploiement ne renvoie rien (la zone Dev est verrouillée).
- Sans clé Claude, tout fonctionne avec des heuristiques locales. Avec `ANTHROPIC_API_KEY`, le résumé « où en est la boîte » et l'onboarding sont rédigés par Claude.
- `npm run smoke` vérifie le cerveau de bout en bout (accès par zone, masquage des secrets, détection d'automatisation…).

## Ce que contient le repo

```
packages/core/        Contrats partagés (KnowledgeItem, AgentEvent), zones, filtre vie privée,
                      distillation (Claude + heuristique), détection d'automatisations, résumé d'état
apps/web/             Le cerveau : dashboard Next.js + API (/api/ingest, /api/query, /api/events, /api/stream…)
  lib/store/          Stockage : fichier JSON (zéro config) ou Postgres/Supabase (DATABASE_URL)
  scripts/            seed (Fournil), simulate (activité en direct), smoke (tests), migrate (SQL)
apps/client/          Le client poste, livré en UN fichier (brain.mjs, servi par le dashboard sur /brain.mjs) :
                      brain-sync, serveur MCP company-brain, hooks Claude Code, installation
supabase/migrations/  Schéma Postgres + politiques RLS par zone
install/              Le « prompt magique » d'installation (généré par le dashboard pour chaque employé)
demo/                 Script de démo
```

## Les briques

| Brique | Où | Rôle |
|---|---|---|
| **Dashboard** | `apps/web` | Cerveau découpé en zones qui s'allument en néon (flux SSE), agents en direct, « où en est la boîte », automatisations proposées, tâches, connaissances, recherche « en tant que ». |
| **Équipe & accès** | `/admin` | Matrice membres × zones, invitation → prompt d'installation avec jeton personnel, rôles. |
| **Onboarding** | `/onboarding` | Interview guidée de 7 questions + lecture des liens → zones et premières connaissances, validées avant application. |
| **Passation** | `/people/:id` | Zones, sujets, prompts fréquents et connaissances d'un poste (et droit de regard : l'employé supprime ses items). |
| **brain-sync** | `brain.mjs sync` | Lit les logs Claude Code / Codex et l'API locale de Screenpipe, filtre (liste blanche d'apps, secrets, données perso), distille, envoie. |
| **MCP company-brain** | `brain.mjs mcp` | `search_brain`, `get_zone_summary`, `list_zones`, `whoami_context`, `company_status`, `remember`. Chaque requête allume la zone trouvée. |
| **Hooks Claude Code** | `brain.mjs hook` | `SessionStart` / `UserPromptSubmit` / `Stop` → événements (néons fiables + détection des prompts répétitifs par empreinte, sans stocker le prompt brut). |

## API du cerveau

Authentification : `Authorization: Bearer cb_…` (jeton personnel, haché en SHA-256 côté serveur) pour les agents ; cookie de session signé pour le dashboard.

| Méthode | Route | Usage |
|---|---|---|
| POST | `/api/ingest` | `{items: KnowledgeItemInput[]}` — connaissances distillées (re-masquées côté serveur). |
| POST | `/api/events` | `AgentEventInput` ou `{events: [...]}` — ce qui fait s'allumer le cerveau. |
| POST | `/api/query` | `{query, zones?, limit?}` — recherche limitée aux zones lisibles ; signale les zones restreintes sans rien en dire. |
| GET | `/api/zones`, `/api/zones/:id` | Zones (avec mots-clés pour les hooks), résumé d'une zone. |
| GET | `/api/whoami`, `/api/people/:id` | Contexte du poste (passation). |
| GET | `/api/stream` | Flux SSE des événements, filtré selon les droits. |
| GET/POST | `/api/status` | État de l'entreprise / régénération (admin). |
| GET/POST/PATCH | `/api/automations…` | Suggestions (heuristique + workflows Screenpipe), validation par un admin. |
| … | `/api/admin/*`, `/api/onboarding*`, `/api/session*` | Comptes, accès, zones, onboarding, connexion. |

## Brancher un vrai poste

1. Dans `/admin`, invitez la personne et choisissez ses zones : le dashboard génère son prompt (voir [install/PROMPT.md](install/PROMPT.md)).
2. Elle le colle dans Claude Code, qui télécharge `brain.mjs`, vérifie/installe Screenpipe, ajoute le MCP et les hooks, planifie `sync` toutes les 15 min et fait un test (`hello` → son néon s'allume).
3. Ensuite rien à faire : en travaillant avec Claude Code, elle nourrit le cerveau.

Le dashboard doit être joignable par les postes (URL publique ou réseau local) : définissez `BRAIN_PUBLIC_URL`.

## Déployer le cerveau partagé (Supabase + Vercel)

1. Créez un projet Supabase et récupérez la chaîne de connexion « Transaction pooler » (port 6543).
2. `DATABASE_URL=… npm run db:migrate` (ou collez `supabase/migrations/*.sql` dans l'éditeur SQL), puis `DATABASE_URL=… npm run seed` pour la démo.
3. Déployez `apps/web` sur Vercel (root directory `apps/web`, build `npm run build`) avec `DATABASE_URL`, `BRAIN_SESSION_SECRET`, `BRAIN_PUBLIC_URL`, et optionnellement `ANTHROPIC_API_KEY` et `BRAIN_DEMO=1` (uniquement avec des données fictives).

Variables : voir [apps/web/.env.example](apps/web/.env.example).

## Vie privée et sécurité (MVP)

- Sur le poste : liste blanche d'apps (sessions IA, terminaux, éditeurs), exclusion des contenus perso, masquage des secrets (clés API, jetons, mots de passe, clés privées), emails, téléphones, IBAN, cartes (Luhn), n° de sécu. Rien de brut n'est envoyé.
- Côté serveur : nouveau masquage à l'ingestion, lecture filtrée par zone sur **toutes** les routes (même règle que les politiques RLS SQL), événements des zones restreintes visibles sans leur contenu, jetons stockés hachés, protection SSRF sur le scraping d'onboarding.
- Droit de regard : chaque employé voit et supprime les connaissances issues de son poste.
- À trancher avant une vraie mise en production : consentement des salariés et information CSE, durée de conservation, hébergement UE, audit des accès.

## Tests

```bash
npm test                 # tests unitaires (core + client)
npm run typecheck
npm run smoke            # bout en bout sur le stockage courant (fichier, ou Postgres si DATABASE_URL)
```
