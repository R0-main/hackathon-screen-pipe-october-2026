# NOS Brainer

> Le cerveau d'entreprise qui est un *no-brainer* : un prompt à coller dans Claude Code, et ta boîte a un cerveau.

> Hackathon Screenpipe « Build Agents That Remember » — 42 Paris, octobre 2026.
> Le pitch est dans [IDEA.md](IDEA.md), l'architecture dans [ARCHITECTURE.md](ARCHITECTURE.md), le déroulé de la démo dans [demo/DEMO.md](demo/DEMO.md), l'hébergement sur une machine de l'entreprise dans [docs/LOCAL.md](docs/LOCAL.md).

Chaque employé travaille déjà avec Claude Code, Codex ou ChatGPT, mais ce contexte reste enfermé dans des sessions individuelles.
**Screenpipe** capte ces sessions sur chaque poste, **brain-sync** les distille en connaissances (décisions, procédures, faits, tâches) et les envoie à **un cerveau unique de l'entreprise**. Les agents de chacun interrogent ce cerveau via un **MCP**, avec des **accès par zone**, et le dashboard montre le cerveau s'allumer en direct.

**Le brut reste sur le PC, seul le distillé monte au cerveau.**

## Lancer la démo en 2 minutes

Prérequis : Node.js ≥ 20.

```bash
npm install
npm run seed                 # entreprise fictive « Fournil » : 6 comptes, 5 skills, 34 connaissances, 10 jours d'activité
BRAIN_DEMO=1 npm run dev     # http://localhost:3000/demo → connexion en un clic (mode démo)
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
| **Dashboard** | `apps/web` | Barre latérale à gauche, cerveau 3D en plein écran à droite (zones qui s'allument en néon via SSE, molette pour zoomer, recherche « en tant que »). Pages séparées : agents en direct (`/activite`), « où en est la boîte » (`/etat`), connaissances, tâches, automatisations. |
| **Équipe & accès** | `/admin` | Organigramme (qui est rattaché à qui, agents actifs, zones de chacun ; cliquer une carte pour régler rattachement, rôle et zones), matrice membres × zones, invitation → prompt d'installation avec jeton personnel. |
| **Skills** | `/skills` | Les skills Claude Code de l'entreprise (SKILL.md et les scripts qu'ils utilisent), regroupés par cortex. Publier demande un droit accordé dans `/admin` (les admins l'ont toujours) ; un skill attribué à un cortex (une zone) n'est donné qu'à ceux qui lisent cette zone. Un script qui contient un secret est refusé. |
| **Onboarding** | `/onboarding` | Interview guidée de 7 questions + lecture des liens → zones et premières connaissances, validées avant application. |
| **Passation** | `/people/:id` | Zones, sujets, prompts fréquents et connaissances d'un poste (et droit de regard : l'employé supprime ses items). |
| **brain-sync** | `brain.mjs sync` | Lit les logs Claude Code / Codex et l'API locale de Screenpipe, filtre (liste blanche d'apps, secrets, données perso), distille avec Claude, envoie. `--dry-run --full` montre tout ce qui partirait, `--confirm` envoie exactement ce qui a été relu. |
| **Skills sur le poste** | `brain.mjs skills` | Installe dans `~/.claude/skills` les skills attribués au poste (après chaque synchro et au `setup`), retire ceux qui ne le sont plus, ne touche jamais un skill personnel. `skills push <dossier> --cortex <zone>` publie un dossier. |
| **État par Claude** | `brain.mjs refresh-status` | Admins : rédige « où en est la boîte » sur le poste avec Claude (abonnement) et l'envoie au dashboard. |
| **MCP company-brain** | `brain.mjs mcp` | `search_brain`, `get_zone_summary`, `list_zones`, `whoami_context`, `company_status`, `remember`. Chaque requête allume la zone trouvée. |
| **Hooks Claude Code** | `brain.mjs hook` | `SessionStart` / `UserPromptSubmit` / `Stop` → événements : néons fiables, et détection des prompts répétitifs par empreinte. Un court résumé masqué n'est envoyé que si le prompt concerne une zone et n'a rien de personnel (`init --share-prompt-summaries non` le supprime). |

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
| GET/POST | `/api/status` | État de l'entreprise (titre global réservé à qui lit toutes les zones). POST admin : sans corps, recalcul côté serveur ; avec `{status}`, résumé rédigé sur un poste. |
| GET | `/api/status/input` | Admin : matière du résumé (30 derniers jours) pour `refresh-status`. |
| GET/POST | `/api/skills` | Skills reçus par la personne (toute l'entreprise + ses cortex), fichiers compris. POST `{name, description, zone?, files: [{path, content}]}` : publie (droit requis), même nom → version suivante. |
| PATCH/DELETE | `/api/skills/:id` | `{zone}` : attribue le skill à un cortex (`null` : toute l'entreprise). Auteur ou admin. |
| GET/POST/PATCH | `/api/automations…` | Suggestions (heuristique + workflows Screenpipe), validation par un admin. |
| POST | `/api/orgs` | Public (sauf `BRAIN_SIGNUP=0`) : crée une entreprise et son admin, ouvre la session, renvoie son prompt d'installation. |
| POST | `/api/join`, `/api/join/status` | Public : demande pour rejoindre avec le code du message d'équipe (empreinte du jeton du poste), puis son état (pour qui détient le jeton). |
| GET/POST | `/api/admin/join`, `/api/admin/join/:id` | Admin : message d'équipe et demandes en attente, changer le code ; accepter (compte créé tel que réglé) ou refuser. |
| GET | `/api/admin/team` | Admin : l'équipe et le dernier signe de chaque poste (`last_at`, null tant qu'il n'est pas branché). |
| … | `/api/admin/*`, `/api/onboarding*`, `/api/session*` | Comptes, accès, zones, onboarding, connexion. |

## Créer son entreprise à partir de zéro

Sur la page d'accueil, **Créer mon entreprise** (`/creer`) : quatre questions, une par écran (nom, activité, qui
vous êtes, zones du cerveau), et le dashboard de l'entreprise existe, vous en êtes l'admin. Ensuite :

1. **Votre poste** : copiez le prompt (ou « Ouvrir dans Claude Code ») et collez-le dans Claude Code. Il installe tout
   comme la démo de la page d'accueil ; la page passe à « Votre poste est connecté » dès le premier signe de son agent.
2. **Votre équipe**, de deux façons (sur cette page, puis dans Équipe et accès) :
   - **un message par personne** : un nom, les zones qu'elle lit, et son prompt (avec son propre jeton) est copié.
     Envoyez-le-lui : elle le colle dans Claude Code, son poste rejoint le cerveau et apparaît connecté ;
   - **un seul message pour toute l'équipe** (Équipe et accès, puis Demandes) : le même pour tout le monde, à n'envoyer qu'à ses
     collègues. Le Claude de chacun remplit la demande avec ce qu'il sait déjà (nom, poste, email ; rien d'inventé,
     le reste reste vide), et `brain join` l'envoie puis attend. Un admin la complète (poste, rôle, zones,
     rattachement) et l'accepte : le poste termine alors son installation tout seul. Le code ne donne accès à rien ;
     le jeton est créé sur le poste et seule son empreinte part avec la demande. « Changer le code » invalide
     l'ancien message. Code de sortie 5 : toujours en attente (`~/.company-brain/brain join` reprend la même
     demande) ; 6 : refusée.

Chaque entreprise a son cerveau à part : comptes, zones, connaissances et activité ne se croisent jamais, et la démo
Fournil n'est pas touchée (un reseed la remplace sans effacer les entreprises créées). Côté stockage : une
organisation par entreprise (Postgres : marquée `tenant:<id>` dans `brain_settings`, sans migration ; fichier :
`<BRAIN_DATA_DIR>/orgs/<id>/`). Un jeton ou une session désigne son entreprise, et chaque route lit la sienne.
`BRAIN_SIGNUP=0` ferme la création, `BRAIN_MAX_ORGS` la plafonne (200 par défaut).

## Brancher un vrai poste

1. Dans `/admin`, invitez la personne et choisissez ses zones : le dashboard génère son prompt (voir [install/PROMPT.md](install/PROMPT.md)).
2. Elle le colle dans Claude Code, qui lance **une seule commande** (`install.sh`, qui trouve ou installe Node.js puis lance
   `brain setup` ; pourquoi un CLI : [docs/CLI.md](docs/CLI.md)) : Screenpipe installé et lancé, autorisations macOS
   (écran, et accessibilité en option ; pas de micro) avec reprise automatique, MCP, hooks, synchro toutes les 15 min, néon allumé.
3. Le cerveau s'ouvre dans son navigateur, déjà connecté. Ensuite rien à faire : en travaillant avec Claude Code, elle le nourrit.
   `sync --dry-run --full` permet de revoir à tout moment ce qui partirait, `uninstall` retire tout.

Le dashboard doit être joignable par les postes (URL publique ou réseau local) : définissez `BRAIN_PUBLIC_URL`.

## Héberger le cerveau sur une machine de l'entreprise (Docker, HTTPS local)

Rien ne sort de l'entreprise : Postgres, le dashboard et HTTPS tournent sur un ordinateur allumé en permanence, les postes
le joignent sur le réseau local, et le prompt d'installation épingle le certificat du cerveau.

```bash
sh deploy/local/brain-local.sh up      # .env, image Docker, Postgres + cerveau + Caddy, adresse affichée
```

Puis `https://<adresse>/creer` pour créer l'entreprise. Tout le détail (certificats, sauvegarde, mise à jour, options) :
[docs/LOCAL.md](docs/LOCAL.md).

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
- Synchro planifiée (sans session ouverte) : générez un jeton avec `claude setup-token` puis `node ~/.company-brain/brain.mjs init --claude-token <jeton>`. Le jeton reste sur le poste (config en mode 600), il est passé à chaque `claude -p` du client et n'apparaît jamais dans la crontab ni dans les logs. Il est valable **un an** et ne se renouvelle pas tout seul : à expiration, le client l'indique ; relancez `claude setup-token` puis `init --claude-token`.
- « Où en est la boîte » rédigé par Claude : un admin lance `node ~/.company-brain/brain.mjs refresh-status` sur son poste (planifiable chaque matin) ; sans cela, le serveur garde le résumé heuristique. Le serveur n'a besoin d'aucune clé (`ANTHROPIC_API_KEY` reste possible).
- Chaque employé utilise **son propre** abonnement et son propre jeton : les conditions d'Anthropic interdisent de faire passer les requêtes de plusieurs personnes par l'abonnement d'une seule. Pour proposer l'outil à d'autres entreprises, il faut des clés API.
- Si `ANTHROPIC_API_KEY` est définie sur le poste, c'est elle que Claude Code utilise ; `claude auth status` indique l'authentification active.
- Pannes et limites : une limite d'abonnement atteinte (« You've hit your session limit », quota hebdomadaire…), une surcharge ou une erreur réseau n'est jamais imputée à une conversation : rien n'est perdu, la synchro suivante réessaie. Un jeton expiré ou révoqué arrête la synchro avec la marche à suivre (`claude setup-token`, puis `init --claude-token`).
- Une conversation n'est abandonnée (rien envoyé, checkpoint avancé, avertissement affiché) qu'après 3 échecs avérés : Claude a répondu sans JSON exploitable, ou l'appel a échoué pendant une synchro où Claude a répondu aux autres. Si Claude ne répond plus du tout, il faut en plus 5 essais étalés sur 24 h, pour qu'une capture Screenpipe bloquée ne fige pas le poste.
- `claude -p` est toujours lancé sans mode `--bare` (ni `CLAUDE_CODE_SIMPLE`), qui ignorerait le jeton.

## Vie privée et sécurité (MVP)

- Sur le poste : liste blanche d'apps (sessions IA, terminaux, éditeurs), exclusion des contenus perso, masquage des secrets (clés API, jetons, mots de passe, clés privées), emails, téléphones, IBAN, cartes (Luhn), n° de sécu. Rien de brut n'est envoyé.
- Côté serveur : nouveau masquage à l'ingestion, lecture filtrée par zone sur **toutes** les routes (même règle que les politiques RLS SQL), jetons stockés hachés, secret de session aléatoire conservé en base et lié au jeton, protection SSRF vérifiée à la connexion sur le scraping d'onboarding.
- Activité : une zone s'allume pour tout le monde, mais le contenu d'un événement (résumé, empreinte) n'est visible que de la personne concernée, des admins, ou de qui lit **toutes** ses zones. Une recherche ne garde son texte que si elle ne touche aucune zone illisible pour la personne qui cherche et n'a rien de personnel.
- Écriture : tout le monde nourrit le cerveau, dans n'importe quelle zone existante ; seule la lecture est restreinte (`zone_access.can_write` est réservé). Doublons écartés (même auteur, même zone, même titre et même contenu sur 30 jours).
- Skills : publication réservée aux admins et aux membres autorisés, vers un cortex qu'ils lisent ; distribution limitée aux lecteurs du cortex (même règle que la politique RLS « skills par cortex ») ; fichiers texte aux chemins relatifs vérifiés, refusés s'ils contiennent un secret ; le client n'écrit que dans les dossiers qu'il a créés.
- Droit de regard : chaque personne voit et supprime les connaissances issues de son poste, y compris celles rangées dans une zone qu'elle ne peut pas lire.
- À trancher avant une vraie mise en production : consentement des salariés et information CSE, durée de conservation, hébergement UE, audit des accès.

## Tests

```bash
npm test                 # tests unitaires (core + client)
npm run typecheck
npm run smoke            # bout en bout sur le stockage courant (fichier, ou Postgres si DATABASE_URL)
```
