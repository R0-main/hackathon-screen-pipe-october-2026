# Le prompt d'installation de NOS Brainer

Le dashboard le génère pour chaque employé (`/admin` → « Inviter quelqu'un » ou « Nouveau prompt »), avec son jeton
personnel (affiché une seule fois) et l'URL du cerveau. Source : [apps/web/lib/install-prompt.ts](../apps/web/lib/install-prompt.ts).

L'employé le colle dans Claude Code. Claude prévient des autorisations à venir, lance **une seule commande**, lit son
code de sortie et dépanne si besoin. Le prompt reste court parce que le travail est dans notre CLI (pourquoi : [docs/CLI.md](../docs/CLI.md)) :

- `install.sh` (servi sur `/install.sh`, source `apps/web/public/install.sh`) trouve Node.js ≥ 20 ou en installe une copie
  privée dans `~/.company-brain/node` (sans droits admin, empreinte SHA-256 vérifiée), télécharge `brain.mjs`, écrit le
  raccourci `~/.company-brain/brain`, puis lance `brain setup` avec les mêmes options et rend son code de sortie ;
- `brain setup` (`apps/client/src/setup.ts`) fait le reste :

1. **Cerveau** : enregistre l'URL et le jeton (`~/.company-brain/config.json`, mode 600) et teste la connexion.
2. **Screenpipe** : s'il tourne déjà (application ou CLI), on le garde. Sinon l'application si elle est installée, sinon le
   CLI officiel (paquet npm `screenpipe`, version figée dans `SCREENPIPE_VERSION`) installé dans `~/.company-brain/screenpipe`
   et lancé en service (`screenpipe service install` : launchd sur macOS, systemd sous Linux ; en arrière-plan à défaut).
   Options d'enregistrement : micro coupé, contexte d'app « memory » (les données `parsed` que lit brain-sync), vidéos et
   captures effacées après 14 jours (le texte reste). Le jeton d'API local est lu et enregistré tout seul.
3. **Autorisations** (macOS) : ouvre le bon panneau des Réglages, puis surveille `GET /health` et continue dès que la
   capture démarre. Personne n'a à revenir dans le terminal pour dire « c'est fait ».
4. **Claude Code** : MCP `company-brain` (portée utilisateur) et hooks `SessionStart` / `UserPromptSubmit` / `Stop`.
5. **Synchro** toutes les 15 minutes, à partir de maintenant : seule l'activité à venir part, jamais l'historique.
6. **Néon et navigateur** : `hello` allume les zones de la personne, puis le cerveau s'ouvre **déjà connecté** grâce à un
   lien de connexion valable 2 minutes (`POST /api/session/link`, sans le jeton dans l'URL), avec un bandeau de bienvenue.
   Elle voit le cerveau s'allumer à chaque session Claude Code, et les connaissances arriver au fil des synchros.

`setup` est idempotent : sans paramètres, il reprend là où il s'est arrêté. Code de sortie 3 : tout est branché sauf
l'autorisation d'enregistrer l'écran.

## Les autorisations : ce qu'on évite, ce qu'on ne peut pas éviter

| Où | Avant | Maintenant |
|---|---|---|
| Claude Code | une autorisation par étape (une dizaine de commandes) | **une seule** : la commande unique. Zéro en la collant directement dans un terminal. |
| macOS, Micro | demandé | **supprimé** : micro coupé par défaut (`setup --audio oui` pour transcrire les réunions) |
| macOS, Enregistrement de l'écran | à trouver dans les Réglages | **un clic** : panneau ouvert, chemin du binaire copié si « screenpipe » n'est pas listé, reprise automatique |
| macOS, Accessibilité | à trouver dans les Réglages | **un clic, facultatif** : améliore la lecture du texte des terminaux ; sans elle, la capture marche quand même |
| Linux, Windows | rien | rien (sous Wayland, accepter le partage d'écran s'il est proposé) |

Ce qu'on ne peut pas sauter : macOS impose que l'employé accorde lui-même l'Enregistrement de l'écran, même sur un parc
géré. En entreprise, un profil MDM (PPPC) peut pré-accorder l'Accessibilité au binaire `screenpipe` (signé Developer ID,
équipe `URFF7QHPUR`) et autoriser un utilisateur standard à cocher l'Enregistrement de l'écran sans mot de passe admin.

## Exemple (jeton fictif)

```text
Tu vas connecter ce poste à NOS Brainer, le cerveau d'entreprise de Fournil. Je suis Jean-Marc Dubois, zones : compta.
Ce message contient mon jeton personnel : ne l'affiche jamais en entier (brain-sync reconnaît cette conversation et ne l'envoie jamais au cerveau). Sois bref. Si tu ne tournes pas sur mon poste (session cloud, conteneur distant), arrête-toi et dis-moi de recoller ce message dans Claude Code ou Codex en local (terminal `claude` ou `codex`).

1. Préviens-moi en une phrase : sur Mac, les Réglages Système vont s'ouvrir et je devrai activer « screenpipe » dans « Enregistrement de l'écran » puis dans « Accessibilité » ; la commande attend et reprend toute seule.
2. Lance cette commande telle quelle, en un seul appel, avec un délai de 10 minutes (hors du bac à sable si elle y est bloquée) :
   curl -fsSL --create-dirs https://cerveau.example.com/install.sh -o ~/.company-brain/install.sh && sh ~/.company-brain/install.sh --url https://cerveau.example.com --token cb_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
3. Code 0 : c'est fini, le cerveau s'est ouvert dans mon navigateur. Code 3 (« EN ATTENTE ») : redis-moi où cocher, puis relance `~/.company-brain/brain setup`. Autre erreur : explique-la simplement et relance `~/.company-brain/brain setup`, qui reprend où il s'était arrêté (`~/.company-brain/brain status` donne l'état).
4. Termine en trois lignes : ce qui tourne, ce qui part (des connaissances distillées, jamais l'écran brut ; aucun historique n'est envoyé) et comment tout retirer (`~/.company-brain/brain uninstall`). Propose enfin de faire apprendre au cerveau mes dernières 24 h : montre-moi d'abord `~/.company-brain/brain sync --dry-run --full --since 24h` en entier ; rien ne part avant mon accord explicite, puis `~/.company-brain/brain sync --confirm` envoie exactement ce que j'ai relu.
```

## Options de `setup`

| Option | Effet |
|---|---|
| `--url <url> --token <jeton>` | Première installation (ensuite inutiles). |
| `--audio oui\|non` | Micro et transcription des réunions (non par défaut ; macOS demande alors aussi le Micro). |
| `--wait <secondes>` | Attente des autorisations macOS (300 par défaut). |
| `--no-open` | N'ouvre pas le navigateur. |
| `--skip-screenpipe` | Sans Screenpipe : brain-sync lit seulement les sessions Claude Code et Codex. |

Tout retirer : `node ~/.company-brain/brain.mjs uninstall` (hooks, MCP, skills de l'entreprise, synchro, service Screenpipe ; `--purge` efface aussi
`~/.company-brain`). Les enregistrements de Screenpipe restent dans `~/.screenpipe`.

## Le message d'équipe (rejoindre sur demande)

Second moyen d'ajouter quelqu'un, à côté du prompt personnel : un message unique par entreprise (`/admin` → Demandes,
ou la dernière étape de `/creer`), source `buildJoinPrompt` dans [apps/web/lib/install-prompt.ts](../apps/web/lib/install-prompt.ts).
Il contient un code d'équipe (`cj_…`), pas de jeton : à envoyer aux collègues seulement, il ne permet que de demander.

1. Le Claude du demandeur remplit `--name`, `--title`, `--email` avec ce qu'il sait déjà (git config, mémoire, CLAUDE.md),
   sans poser de question ni rien inventer : une valeur inconnue est omise, l'admin la complétera.
2. `install.sh --join` lance `brain join` (`apps/client/src/join.ts`) : le jeton du poste est créé localement, la demande
   part avec son empreinte seulement, puis la commande attend l'acceptation (8 min).
3. Un admin complète et accepte la demande : le compte est créé avec cette empreinte, et `join` enchaîne sur `setup`.
   Code 5 : toujours en attente (`brain join` reprend la même demande, état dans `~/.company-brain/join.json`) ; 6 : refusée.

