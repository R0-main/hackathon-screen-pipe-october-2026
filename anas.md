# Notes d'Anas : revue du MVP contre l'API réelle de screenpipe

> Écrit le 16/10/2026 au soir, après lecture complète du dépôt `screenpipe/screenpipe` (commit `9dc0fd0`, ~490k lignes)
> et de notre branche `claude/great-euler-flq450` (commit `632e5d8`). Les chemins cités sont ceux de ces deux dépôts.
> Les points marqués *(à vérifier)* n'ont pas pu être testés sur une vraie instance.

## 0. En deux phrases

L'idée est bonne et le MVP est impressionnant. Mais tel qu'il est codé, screenpipe y est **optionnel** (les logs Claude Code et
les hooks font le vrai travail), alors que le recap du kickoff dit : *« un agent générique sans connexion screenpipe ne répond
pas à l'exigence de jugement »*. Les corrections ci-dessous rendent screenpipe **irremplaçable** (réunions, outils IA sans logs,
pipe natif, distribution par Teams) et corrigent cinq bugs qui feraient que le cerveau reste vide sur scène.

## 1. Le risque n°1 pour le jury, et comment le retourner

Ce que le jury verra dans notre README : *« les logs Claude Code locaux sont la source la plus fiable »* et les hooks rendent
les néons fiables *« sans dépendre de la capture d'écran »*. En plus, screenpipe fait déjà une partie de ce qu'on annonce :

| Ce qu'on annonce | Ce que screenpipe a déjà (dans son code) |
|---|---|
| Capter les sessions Claude Code / Codex | Connexions `claude_code.rs`, `codex.rs`, `hermes.rs` dans `screenpipe-connect`, et le changelog d'octobre : « local Claude Code, Codex and Hermes chats can contribute evidence » |
| Journal des prompts IA | Pipe intégré `ai-prompt-journal` |
| Mémoire durable | Table `memories`, `content_type=memory`, pipe `commitments` |
| Détection « même prompt, même heure, 3 jours » | Pipe `automate-my-work` + catalogue de workflows par personne (`/workflows`) |
| Pousser une config à toute l'équipe | **Teams** : configs de pipes et filtres poussés chiffrés de bout en bout |
| Cerveau multi-postes | Passerelle entreprise (`screenpipe-gateway`), crate `screenpipe-team-memory` |

La parade, par ordre d'impact :

1. **Mettre les réunions dans le cerveau** (section 2.8). « Lundi en call, Claire a décidé de reporter la clôture » : aucun log
   Claude Code ne contient ça, seul screenpipe transcrit, diarise et détecte les réunions.
2. **Démontrer les outils IA sans logs ni hooks** : ChatGPT web, Claude desktop, Cursor, Gemini. Seul `content_type=parsed` les
   structure (parseur sémantique, 49 apps couvertes). Les hooks restent pour la latence des néons, pas comme source de vérité.
3. **Livrer `brain-sync` comme un vrai pipe screenpipe** (section 2.9) et le **distribuer par screenpipe Teams** : c'est mot pour
   mot le track 3, « setup, approvals and shared tools », avec les primitives du produit.
4. **Agréger les workflows entre employés** : « ce workflow existe sur 3 postes ». Un poste seul ne peut pas le voir, le produit
   non plus. C'est leur tagline (« finds work worth automating in your company ») à l'échelle de l'entreprise.
5. **Auto-hébergement par défaut dans le pitch** (mode fichier / Postgres quelconque). Supabase et Vercel = une option.

Argument à citer tel quel : leur spec `docs/ORG_DATA_UNIFICATION_SPEC.md` dit *« sqlite does not federate, 30 employees = 30 dbs,
not one queryable org brain »* et *« ship only the ~30 frames a SOP cites, not the firehose »*. Notre principe « le brut reste
sur le PC, seul le distillé monte » est exactement ça. On construit la couche qu'ils décrivent comme manquante.

Phrase de pitch : *« screenpipe se souvient pour une personne ; sa propre spec dit que 30 employés font 30 bases. On a construit
le cerveau au-dessus, et seul le distillé y monte. »*

## 2. Ce qui casse sur de vraies données, et les correctifs

### 2.1 Le format `parsed` qu'on attend n'existe pas

`apps/client/src/sources/screenpipe.ts` → `normalizeScreenpipeItem` cherche `content.messages[{ role, text }]`. Forme réelle d'une
ligne `parsed` (`crates/screenpipe-engine/src/routes/content.rs`) :

```jsonc
{
  "type": "parsed",
  "content": {
    "frame_id": 1234, "timestamp": "2026-10-16T21:03:11.120Z",
    "app_name": "Google Chrome", "window_name": "ChatGPT", "browser_url": "https://chatgpt.com/c/...",
    "text": "…rendu compact de la conversation…",
    "parser_id": "conversation/chatgpt-web", "parser_version": "…",
    "items": [
      { "local_id": "c1", "parent_local_id": null, "kind": "conversation", "title": "Clôture mensuelle", "body": null, "actor": null, "occurred_at": null, "status": null, "metadata": {} },
      { "local_id": "m1", "parent_local_id": "c1", "kind": "message", "title": null, "body": "Comment on fait le rapprochement Qonto ?", "actor": "You", "occurred_at": "2026-10-16T21:01:00Z", "metadata": {} },
      { "local_id": "m2", "parent_local_id": "c1", "kind": "message", "body": "Voici la procédure…", "actor": "ChatGPT", "occurred_at": "2026-10-16T21:01:40Z", "metadata": {} }
    ],
    "actors": [ { "item_id": 9, "local_id": "m1", "actor_id": 3, "name": "Jean-Marc Dubois", "observed_name": "You", "assignment_source": "heuristic" } ]
  }
}
```

Valeurs de `kind` : `conversation`, `message`, `document`, `task`, `page`, `calendar_event`, `derived`, `stable`. Il n'y a **pas**
de `role`. Aujourd'hui on retombe sur `content.text` et on fabrique une fausse conversation (« Session capturée à l'écran » +
tout le blob côté assistant) : la distillation perd qui a dit quoi.

Correctif : dans le normaliseur, prendre `items` avec `kind === "message"`, regrouper par `parent_local_id`, et déduire le rôle
de `actor` : `You`/`Vous`/`Moi`/nom de l'utilisateur → `user` ; `ChatGPT`/`Claude`/`Assistant`/`Codex`/`Gemini`/`Copilot` →
`assistant`. `occurred_at` donne `at`. Garder `content.text` en repli si `items` est vide.

### 2.2 `parsed` reste vide tant que le parseur sémantique est désactivé

`enableSemanticContext` est à `false` par défaut (`crates/screenpipe-config/src/recording.rs`, ligne ~966). Notre
`install/PROMPT.md` ne l'active pas, donc `parsed` répond vide, on retombe sur `accessibility`, et on récupère tout l'historique du
chat à chaque capture, structure perdue.

Correctif : ajouter à l'étape 3 du prompt d'installation l'activation du parseur sémantique (réglage dans l'app desktop, ou flag
CLI `--enable-semantic-context` *(nom exact à vérifier dans `screenpipe record --help`)*), puis une vérification :
`GET /search?content_type=parsed&start_time=10m%20ago&end_time=now&limit=5` doit renvoyer des lignes après quelques minutes
d'activité dans ChatGPT ou Claude.

### 2.3 L'authentification est silencieusement cassée

`/health` est **sans auth**, donc `screenpipeHealth` passe. Mais `/search` renvoie 401/403 sans jeton, et `fetchScreenpipeItems`
prend un `status >= 400` en page 0 pour « aucune donnée ». Les builds actuels activent l'auth par défaut (l'extension navigateur
s'appaire justement pour obtenir le jeton).

Correctifs :
- `brain.mjs init` récupère le jeton tout seul : `npx -y screenpipe@latest auth token` (c'est aussi ce que fait leur skill), et
  le stocke dans `screenpipe_token`.
- Distinguer 401/403 dans les warnings (« jeton screenpipe requis ») au lieu de « aucune donnée (parsed, accessibility, ocr) ».
- Envoyer les en-têtes attendus : `Authorization: Bearer <token>`, `X-Screenpipe-Client: api`, `X-Screenpipe-Agent: company-brain`.

### 2.4 L'URL du navigateur n'est jamais transmise

`isAllowedApp(app, window, whitelist, browserUrl)` et `AI_HOSTS` sont bien faits, mais le normaliseur ne lit pas
`content.browser_url` (présent sur `parsed` et `ocr`) et `groupScreenpipeItems` ne le passe pas. La détection des onglets
ChatGPT / Claude repose donc uniquement sur le titre de fenêtre.

Correctif : ajouter `browserUrl: str(c.browser_url)` dans `ScreenpipeItem`, et le passer à `isAllowedApp`.

### 2.5 Pagination et checkpoint

100 lignes × 10 pages max, toutes apps confondues, filtrées côté client. L'accessibilité capture toutes les quelques secondes :
15 minutes d'activité dépassent facilement 1 000 lignes. Quand ça tronque, le checkpoint avance quand même jusqu'à la ligne la
plus récente vue. Si l'API renvoie du plus récent au plus ancien *(à vérifier)*, les lignes anciennes perdues ne sont jamais
rattrapées.

Correctifs :
- un appel par app autorisée avec le filtre serveur `app_name=` (ou `browser_url=` pour les onglets IA), au lieu de tout lire ;
- `fields=type,content.timestamp,content.app_name,content.window_name,content.browser_url,content.text,content.items,content.frame_id`
  et `max_content_length` pour alléger ;
- quand `truncated` est vrai, poser le checkpoint sur la ligne la plus **ancienne** traitée, pas la plus récente.

### 2.6 `/workflows` ne renvoie pas ce que `mapWorkflows` cherche

Forme réelle de la liste (`crates/screenpipe-engine/src/routes/workflows.rs`) :

```jsonc
{ "data": [ { "id": "…", "title": "…", "description": "…", "trigger": "…", "outcome": "…",
              "evidenceStatus": "…", "catalogStatus": "…", "stageCount": 4 } ],
  "pagination": { "total": 12, "offset": 0, "limit": 20 }, "analyzedAt": "…", "historyRestricted": false }
```

Aucun champ `occurrences`, `days`, `schedule` : nos suggestions issues de screenpipe arrivent avec 0 minute économisée et finissent
en bas de liste. Les étapes, la procédure observée, les citations, les `timingRuns` et les épisodes d'occurrence sont dans
`GET /workflows/{id}?include_automation=true`.

Correctif : lister, puis appeler le détail pour les N premiers, et dériver `occurrences` / `days` des épisodes ; afficher
`trigger` et `outcome` dans la carte. C'est aussi la base de l'agrégation entre postes (section 1, point 4).

### 2.7 Le masquage natif de screenpipe est ignoré

`/search` accepte `filter_pii=true` : redaction des données personnelles **sur le poste**, avant même notre filtre regex
(`crates/screenpipe-engine/src/routes/search.rs`, ligne ~1497). Un paramètre à ajouter, et une phrase de pitch : deux couches de
masquage, dont une signée screenpipe.

### 2.8 Les réunions, la source la plus forte, ne sont pas branchées

Endpoints (`crates/screenpipe-engine/src/server.rs`, lignes ~940-960) :

- `GET /meetings?start_time=…&end_time=…&limit=20&offset=0&q=…` →
  `[{ id, meeting_start, meeting_end, meeting_app, title, attendees, note, detection_source, created_at }]`
  (`note` contient le résumé sauvegardé par l'utilisateur ou par le pipe `meeting-summary`).
- `GET /meetings/{id}/transcript` → tableau de segments `{ speaker_name, speaker_id, transcript, captured_at, device_type, … }`.
- `GET /meetings/status` → réunion en cours.

À ajouter dans `sync.ts` : une source `meetings` qui transforme chaque réunion terminée depuis le checkpoint en `Conversation`
(un message par segment, `role` = `user` si `speaker_name` est l'employé, sinon `assistant`, ou mieux : un rendu « Prénom : texte »
dans un seul message), puis la distillation habituelle. Le prompt de distillation gagne une ligne : « pour une réunion, les
décisions et les engagements priment ». Démo : une réunion fictive de 2 minutes entre deux membres de l'équipe → 3 décisions
dans la zone concernée.

### 2.9 Livrer `brain-sync` comme un pipe screenpipe

Un pipe est un `pipe.md` dont le prompt est exécuté par un agent (Pi par défaut, ou Claude Code, Codex…) qui a un bash.
Ça rend brain-sync visible dans « Scheduled tasks », déclenchable sur la fin d'une réunion, borné par des permissions, et
**poussable à toute l'équipe par screenpipe Teams** (configs chiffrées de bout en bout). Exemple, à mettre dans
`~/.screenpipe/pipes/brain-sync/pipe.md` :

```markdown
---
schedule: every 15m
enabled: true
title: Cerveau d'entreprise, synchro
description: Distille les sessions IA et les réunions vers le cerveau partagé (rien de brut ne quitte le poste)
agent: pi
model: auto
timeout: 300
subagent: false
history: false
trigger:
  events:
    - meeting_ended
permissions:
  allow:
    - Api(GET /search)
    - Api(GET /meetings)
    - Api(GET /meetings/*)
    - Api(GET /workflows)
    - Api(GET /workflows/*)
privacy_filter: true
---

Lance `node ~/.company-brain/brain.mjs sync` avec le jeton `$SCREENPIPE_LOCAL_API_KEY` de cette tâche.
Ne lis aucune donnée toi-même, n'envoie rien ailleurs. Rapporte en une phrase le nombre de connaissances envoyées
et les avertissements éventuels. Si la commande échoue, rapporte l'erreur telle quelle.
```

Le jeton de la tâche est **scopé** par `permissions.allow` : même si brain.mjs voulait lire autre chose, l'API refuserait.
`privacy_filter: true` force `filter_pii` sur toutes les lectures du pipe. Garder notre installeur launchd / cron / schtasks
en repli pour les postes sans l'app desktop.

Bonus : `POST http://localhost:11435/notify` avec `title`, `body` (markdown), `priority` et des `actions` (`chat`, `link`,
`pipe`, `api`) → une notification native « 4 connaissances envoyées au cerveau, 1 décision à confirmer ».

## 3. Référence API screenpipe (ce qu'on utilise)

Base : `http://localhost:3030`. Jeton : `npx -y screenpipe@latest auth token` (ou Settings → Privacy → API security).
En-têtes sur chaque appel : `Authorization: Bearer <token>`, `X-Screenpipe-Client: api`, `X-Screenpipe-Agent: company-brain`.
Sans auth : `/health`, `/ws/health`, `/notify`, `/pipes/store/*`.

`GET /search` : `q`, `app_name`, `window_name`, `browser_url` (correspondance normalisée, pas une sous-chaîne : pour un domaine
utiliser `q=`), `content_type` ∈ `all | ocr | audio | input | accessibility | memory | parsed`, `start_time` / `end_time`
(ISO 8601 ou relatif `30m ago`, `24h ago`), `limit` (pas de plafond serveur, viser ≤ 100), `offset`, `fields=` (chemins pointés),
`format=json|csv|tsv`, `max_content_length`, `filter_pii=true`, `focused=true`, `frame_id` / `actor_id` (avec `parsed` seulement).
Réponse : `{ data: [ { type, content: { … } } ], pagination: { limit, offset, total } }` (`total` peut être une estimation : on
s'arrête sur une page vide, pas sur `total`). Contenu par type : `ocr` → `text`, `app_name`, `window_name`, `browser_url`,
`timestamp`, `frame_id` ; `audio` → `transcription`, `speaker`, `timestamp` ; `accessibility` → `text`, `app_name`, `window_name` ;
`input` → `event_type` (`click`, `key`, `text`, `scroll`, `app_switch`, `window_focus`, `clipboard`), `x`, `y`, `app_name`,
`window_title`, `browser_url`, `element_role`, `element_name` ; `parsed` → section 2.1.

`GET /activity-summary?start_time=…&end_time=…` : point d'entrée recommandé par leur propre skill avant `/search` :
apps, fenêtres, minutes actives par app, extraits, `data_status` ∈ `ok | empty_but_recording | no_capture_in_range | not_recording`.
Utile pour la page « passation » (zones et outils réellement utilisés par un poste).

`GET /meetings`, `GET /meetings/{id}`, `GET /meetings/{id}/transcript`, `GET /meetings/status` : section 2.8.

`GET /workflows?q=&limit=&offset=`, `GET /workflows/{id}?include_automation=true` : section 2.6.

Parseur sémantique : `enableSemanticContext` (défaut `false`), familles conversation, mail, éditeur, tâche, calendrier, page,
terminal ; 49 apps dont ChatGPT web, Claude macOS, Claude web, Codex, Cursor, Windsurf, Gemini, Slack, Teams, WhatsApp, Gmail,
Outlook. Claude Code dans un terminal passe par la famille « terminal » (transcript brut, bruité par le re-rendu de l'interface) :
pour cet outil, nos logs JSONL restent meilleurs. Il faut le dire honnêtement et démontrer les outils où screenpipe est irremplaçable.

Pipes : frontmatter `schedule` (`every 15m`, `daily`, cron, `manual`), `enabled`, `title`, `description`, `agent`, `model`,
`timeout`, `subagent`, `history`, `trigger.events` (`meeting_started`, `meeting_ended`, `pipe_completed:<nom>`), `permissions.allow`
(`Api(GET /search)`…), `privacy_filter`, `artifacts`. CLI : `npx -y screenpipe@latest pipe install|enable|run <nom>`.
Journaux : `screenpipe pipe logs <nom>`. Il n'existe pas de déclencheur « quand l'écran montre X » : seulement horaire, réunions
et fin d'un autre pipe.

MCP : `npx -y screenpipe-mcp@latest`, outils `search-content`, `activity-summary`, `list-meetings`, `get-meeting`,
`list-workflows`, `get-workflow`, `frame-context`, `get-frame-elements`, `send-notification`, `team-search`, `team-records`…
Le desktop accepte aussi des serveurs MCP personnalisés : on peut y déclarer `company-brain` pour que les tâches planifiées de
screenpipe lisent le cerveau (boucle fermée dans le produit).

## 4. Ce qui est solide dans le MVP, à ne pas toucher

- API Claude à jour : `messages.parse` + `zodOutputFormat`, `fallbacks: "default"` avec l'en-tête beta `server-side-fallback-2026-07-01`,
  `effort` par appel, pas de `tool_choice` forcé (qui ferait un 400 sur Sonnet 5.5).
- Hooks : code de sortie 0 garanti, timeout dur à 2,5 s, stdout d'une ligne sur `SessionStart`, empreinte de prompt sans texte brut.
- Synchro : verrou fichier avec détection d'orphelins, écritures atomiques, checkpoints par conversation, désinstallation complète.
- Vie privée : liste blanche par mots entiers, signaux forts et faibles, Luhn, IBAN, rejeu du masquage côté serveur, accès par
  zone dans l'API et en RLS SQL.

## 5. Ordre de priorité pour la nuit

1. 2.2 + 2.3 : activer le parseur et l'auth, vérifier `parsed` non vide sur un vrai poste (sinon tout le reste est invisible).
2. 2.1 + 2.4 : vrai mapping `items` → messages, `browser_url` dans la liste blanche.
3. 2.8 : source réunions (le gros gain jury), avec une réunion fictive enregistrée avant la démo.
4. 2.9 : `pipe.md` brain-sync + capture d'écran de « Scheduled tasks » et de Teams pour les slides.
5. 2.6 : workflows (détail) + agrégation « présent sur N postes » dans le dashboard.
6. 2.5 + 2.7 : pagination par app, `fields=`, `filter_pii=true`.
7. Pitch : track 3 annoncé, citation de la spec d'unification, auto-hébergement par défaut.
