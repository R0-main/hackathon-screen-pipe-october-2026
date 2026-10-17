# NOS Brainer

> Le cerveau d'entreprise qui est un *no-brainer* : un prompt à coller dans Claude Code, et ta boîte a un cerveau.

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
2. Elle le colle dans Claude Code, qui lance **une seule commande** (`brain.mjs setup`) : Screenpipe installé et lancé, autorisations macOS
   (écran, et accessibilité en option ; pas de micro) avec reprise automatique, MCP, hooks, synchro toutes les 15 min, néon allumé.
3. Le cerveau s'ouvre dans son navigateur, déjà connecté. Ensuite rien à faire : en travaillant avec Claude Code, elle le nourrit.

Le dashboard doit être joignable par les postes (URL publique ou réseau local) : définissez `BRAIN_PUBLIC_URL`.

## Déployer le cerveau partagé (Vercel + Neon, offres gratuites)

Le cerveau tourne sur **Vercel Hobby** (toujours en ligne) avec **Neon** (Postgres gratuit, en veille après 5 min d'inactivité, réveil en moins d'une seconde). N'importe quel Postgres convient (Supabase compris) : le schéma est dans `supabase/migrations/`.

1. **Base** : créez un projet Neon (région Francfort), puis `DATABASE_URL=… npm run db:migrate` — ou exécutez `supabase/local/auth_stub.sql` puis `supabase/migrations/*.sql` dans l'éditeur SQL de Neon.
2. **Vercel** : importez le repo avec ces réglages :
   - Root Directory : `apps/web` (avec « Include source files outside of the Root Directory »)
   - Install Command : `cd ../.. && npm ci` (le monorepo s'installe depuis la racine)
   - Build Command : `npm run build` (construit aussi `brain.mjs`, servi sur `/brain.mjs`)
   - Région des fonctions : la même que la base (`fra1` pour Neon Francfort)
   - Désactivez « Vercel Authentication » : les postes appellent l'API avec leur jeton personnel.
3. **Variables** : `DATABASE_URL` (Neon, connexion « pooled »), `BRAIN_PUBLIC_URL` (l'URL publique, utilisée dans le prompt d'installation), `BRAIN_DEMO=1` pour la démo. Avec `BRAIN_DEMO=1`, une base vide est automatiquement remplie avec l'entreprise fictive Fournil au premier passage sur `/login`. Le secret de session est généré tout seul et conservé dans la base.

Variables : voir [apps/web/.env.example](apps/web/.env.example).

### Claude sans clé API (abonnement Claude Code)

- **brain-sync** distille sur chaque poste avec `claude -p` : il utilise l'abonnement Claude Code de l'employé.
- Pour la synchro planifiée en arrière-plan, un jeton longue durée généré par `claude setup-token` permettra au client d'appeler Claude sans session ouverte (option `init --claude-token`, en cours d'ajout ; le jeton reste sur le poste).
- Le serveur n'a besoin d'aucune clé : sans `ANTHROPIC_API_KEY`, le résumé « où en est la boîte » et l'onboarding utilisent les heuristiques locales.
- Limite : les quotas de l'abonnement s'appliquent ; pour proposer l'outil à d'autres entreprises, il faut une clé API (conditions d'Anthropic).

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
