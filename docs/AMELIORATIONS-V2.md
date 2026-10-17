# Améliorations v2 : supervision, connecteurs, langues, flux temps réel, qualité du cerveau

Branche `feat/ameliorations-v2`. Cinq chantiers, chacun utilisable seul ; tout fonctionne sans nouvelle dépendance npm.
En Postgres, les migrations s'appliquent toutes seules au déploiement de production Vercel et au démarrage du conteneur
Docker (sinon `npm run db:migrate`) : `20261017000004_sync_reports.sql`,
`20261017000005_connectors_tasks.sql`, `20261017000006_search_quality.sql`. Sans elles, le cerveau reste utilisable :
supervision sans comptes rendus, connecteurs de tâches refusés avec un message clair, recherche sans vecteurs.

## 1. Supervision (`/supervision`, admins)

- **Comptes rendus de synchro** : à la fin de chaque `brain sync` (hors simulation), le poste envoie `POST /api/sync/report`
  avec des compteurs seulement (durée, connaissances envoyées, doublons, conversations par source, distillateur, échecs,
  erreur masquée). Jamais de contenu. Historique borné à 30 par poste (`sync_reports`, ou `sync_reports` du fichier).
- **État de chaque poste** (`packages/core/src/monitoring.ts`, `posteHealth`) : `ok`, `late` (plus de 4 synchros
  manquées, ou activité sans compte rendu), `error` (dernière synchro en échec), `never` (jamais branché).
- **Incidents serveur** : toute erreur 500/503 d'une route est gardée en mémoire (100 dernières, dédoublonnées par
  route et message) et affichée sur la page, avec la route concernée.
- **Alertes** : `BRAIN_ALERT_WEBHOOK` reçoit un JSON `{ text }` (Slack, Discord `/slack`, Mattermost, n8n…) pour une
  erreur de route, une synchro en échec sur un poste, un connecteur en échec. Au plus une alerte par cause et par heure.
- **Sonde** : `GET /api/health` répond 200 avec version, uptime, stockage, mode du flux ; 503 si le stockage ne répond pas.
  En Postgres, `migrations` donne la dernière migration appliquée en base, la dernière livrée avec le code et
  `up_to_date` : de quoi vérifier de l'extérieur qu'un déploiement a bien migré la base.
- API : `GET /api/admin/monitoring`.

## 2. Connecteurs (`/connecteurs`, admins)

Notion, Linear, Todoist et un calendrier ICS (Google Agenda, Outlook). Réglages dans les réglages de l'entreprise
(clé `connectors`, lus et écrits par l'API seulement) ; le jeton n'est jamais renvoyé au navigateur.

| Outil | Ce qui entre dans le cerveau | Comment |
|---|---|---|
| Notion | les 40 pages les plus récemment modifiées → connaissances (fait, procédure ou décision selon le titre) | intégration interne, `POST /v1/search` + blocs |
| Linear | les issues ouvertes → tâches ; celles qui disparaissent passent faites | clé API, GraphQL |
| Todoist | les tâches ouvertes → tâches ; achevées côté Todoist → faites ici | jeton API, REST v2 |
| Calendrier | les réunions des 7 derniers jours et des 14 prochains → connaissances (qui, quand, de quoi) | adresse iCal privée, via le récupérateur anti-SSRF |

- La zone est celle du connecteur si réglée, sinon classée par mots-clés.
- Les tâches importées portent `external_source`, `external_id`, `external_url` (mise à jour sans doublon, lien
  « Ouvrir dans Linear »).
- Synchro à la demande (`POST /api/connectors/:id/sync`) et automatique : quand un admin consulte le dashboard, les
  connecteurs actifs dus (toutes les heures) tournent en arrière-plan.
- Parseurs purs et testés dans `packages/core/src/connectors.ts` (ICS, blocs Notion, issues Linear, tâches Todoist).

## 3. Interface en français et en anglais

- `apps/web/lib/i18n/` : dictionnaires `fr` et `en` (`dict.ts`, typés : une clé manquante en anglais casse le typecheck),
  langue résolue par le cookie `brain_lang` puis `Accept-Language` ; `<html lang>` suit.
- `components/I18n.tsx` : `useT()` côté client, `LanguageSwitch` (barre latérale et page de connexion) ;
  `lib/i18n/server.ts` : `getT()` pour les pages serveur.
- Traduits : la barre latérale, la connexion, les tâches, les connaissances, les libellés (types, verbes d'événement,
  agents), les dates relatives, et les nouvelles pages (supervision, connecteurs, entités).
- Reste en français (à migrer page par page avec le même mécanisme) : organigramme, onboarding, skills, état,
  automatisations, agents en direct, page d'accueil. Ajouter une langue : un objet `Dict` et son code dans `LOCALES`.

## 4. Flux temps réel sans relecture à 800 ms

- `BrainStore.onEvents(orgId, listener)` : émetteur local en fichier ; `LISTEN brain_events` en Postgres, prévenu par
  `pg_notify` dans la transaction d'insertion (sans déclencheur ni migration).
- `/api/stream` : relecture immédiate sur notification (regroupées à 30 ms), sinon relecture de sécurité avec backoff
  (800 ms après un événement, jusqu'à 15 s au repos ; 4 s sans notification). Une notification perdue retarde un
  événement, elle ne le fait jamais disparaître. En-tête `X-Brain-Stream: local|notify|poll`.
- Variables : `BRAIN_EVENT_NOTIFY`, `DATABASE_LISTEN_URL` (pooler en mode transaction), `BRAIN_STREAM_POLL_MS`,
  `BRAIN_STREAM_IDLE_POLL_MS`. Sur Vercel, LISTEN est coupé par défaut (une connexion par fonction).

## 5. Qualité du cerveau

- **Synonymes FR/EN** (`packages/core/src/search.ts`) : « mise en prod » trouve « déployer », « invoice » trouve
  « facture ». La requête étendue est cherchée en plus de la requête d'origine, les deux classements sont fusionnés.
- **Recherche sémantique optionnelle** (`apps/web/lib/embeddings.ts`) : Voyage AI (`VOYAGE_API_KEY`) ou tout point
  de terminaison compatible OpenAI (`BRAIN_EMBEDDING_URL`, Ollama compris pour l'auto-hébergement). Vecteurs stockés
  en `real[]` (pas de pgvector requis), cosinus côté serveur, fusion RRF avec le lexical (`hybridSearch`).
  `npm run embed` vectorise l'existant. Le MCP et le dashboard en profitent sans changement.
- **Quasi-doublons et remplacements** à l'ingestion (`likeness`) : même contenu (Jaccard ≥ 0,8) → écarté ; même sujet
  (titres proches, même type décision / procédure / fait) mais contenu différent → la nouvelle remplace l'ancienne
  (`superseded_by`), qui reste consultable par son auteur mais sort des recherches, des listes et du résumé d'état.
- **Entités** (`/entites`, `/entites/:type/:nom`) : tout ce qui concerne un client, un projet, un outil, et les
  entités citées avec lui. Les étiquettes d'entités des cartes de connaissance sont cliquables.
- **Évaluation** : `npm run eval` (après `npm run seed`) mesure précision@1, succès@3 et MRR sur 24 questions
  formulées autrement que les titres (synonymes, anglais). À relancer après tout changement de la recherche.

## Vérifications

- `npm run typecheck` et `npm test` (CI) : tests ajoutés dans `packages/core` (search, connectors, monitoring) et
  `apps/client` (report).
- `npm run smoke` : sections supervision, connecteurs (tâches externes), qualité (remplacement, entités, flux prévenu).
