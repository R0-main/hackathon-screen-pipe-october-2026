# Le prompt d'installation de NOS Brainer

Le dashboard le génère pour chaque employé (`/admin` → « Inviter quelqu'un » ou « Nouveau prompt »), avec son jeton
personnel (affiché une seule fois) et l'URL du cerveau. Source : [apps/web/lib/install-prompt.ts](../apps/web/lib/install-prompt.ts).

L'employé le colle dans Claude Code. Claude prévient des autorisations à venir, lance **une seule commande** (celle de
son système : le prompt en donne une pour macOS / Linux / Git Bash et une pour Windows PowerShell), lit son code de
sortie et, en cas d'erreur, s'appuie sur `brain doctor --json`. Le prompt reste court parce que le travail est dans
notre CLI (pourquoi : [docs/CLI.md](../docs/CLI.md)) :

- `install.sh` (servi sur `/install.sh`, source `apps/web/public/install.sh`, macOS et Linux) trouve Node.js ≥ 20 ou en
  installe une copie privée dans `~/.company-brain/node` (sans droits admin, empreinte SHA-256 vérifiée, Apple Silicon
  même sous Rosetta, Alpine compris), vérifie que `brain.mjs` est bien le client avant de remplacer l'ancien, écrit le
  raccourci `~/.company-brain/brain`, puis lance `brain setup` avec les mêmes options et rend son code de sortie. Lancé
  depuis Git Bash sous Windows, il passe la main à `install.ps1` ;
- `install.ps1` (servi sur `/install.ps1`, Windows PowerShell 5.1 ou 7) fait la même chose sous Windows : copie privée
  de Node.js x64 (aussi sur ARM64, que Windows émule : Screenpipe n'existe qu'en x64), raccourcis `brain.cmd`
  (PowerShell, cmd) et `brain` (Git Bash) ;
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

`setup` est idempotent : sans paramètres, il reprend là où il s'est arrêté, et remet sur le client actuel le MCP, les
hooks et la synchro planifiée s'ils pointaient vers un ancien chemin (réinstallation, Node.js mis à jour), sans sauter
ce qui attend d'être envoyé. Screenpipe installé par npm **sans** son script post-installation (qui téléchargerait
ffmpeg depuis un site tiers, lancerait `sudo apt-get` et enverrait de la télémétrie) : Screenpipe installe ffmpeg
lui-même au premier lancement.

| Code | Sens | Ce que fait Claude |
|---|---|---|
| 0 | Tout est branché, le cerveau s'est ouvert | Résume |
| 3 | EN ATTENTE : autorisation « Enregistrement de l'écran » pas encore accordée (macOS) | Redit où cocher, relance `brain setup` |
| 5 | Téléchargement impossible (réseau, proxy, mauvaise adresse, page d'erreur au lieu du client) | Relance la même commande |
| 6 | Tout est branché **sauf Screenpipe** (pas de version pour ce poste, ou il ne démarre pas) | `brain doctor --json`, explique |
| 7 | Message d'équipe : demande pas encore acceptée par un admin | Propose de relancer `brain join` (même demande) |
| 8 | Message d'équipe : demande refusée, rien n'est installé | Le dit |
| 1, 2, 4 | Échec de setup, mauvais appel, système non géré | `brain doctor --json`, explique, lance les corrections « safe » |

## `brain doctor` : le diagnostic

`~/.company-brain/brain doctor` (Windows : `~/.company-brain/brain.cmd doctor`) vérifie tout le poste **sans rien
modifier** et donne, pour chaque point KO, la commande qui répare :

| Groupe | Ce qui est vérifié |
|---|---|
| Poste | Node.js (version, gestionnaire de versions qui cassera les chemins, Rosetta), raccourci (il démarre et lance ce client), dossier privé |
| Cerveau | Config, connexion et jeton (révoqué ?), client à jour par rapport à celui que sert le cerveau (`/brain.mjs.sha256`) |
| Screenpipe | Répond, capture l'écran (autorisation refusée, capture bloquée, économie d'énergie), Accessibilité, jeton d'API local, données « parsed » |
| Claude Code | CLI `claude`, MCP `company-brain` (enregistré et il démarre), hooks (les trois, sans doublon, sur le client actuel, lançables sans Git Bash sous Windows), erreurs récentes des hooks |
| Synchro | Planification (et ce qu'elle lance vraiment), dernière synchro, dernière erreur du journal, verrou orphelin, conversations en attente, simulation non confirmée |
| Distillation | Claude Code ou clé API, `claude` trouvable par la synchro planifiée, connexion Claude perdue (jeton expiré) |

`--json` donne le même rapport à Claude Code : `checks[]` (`id`, `status` ok / warn / fail / skip / info, `detail`, `fix`,
`command`, `safe`), `next` (le premier point à régler) et `exit_code` (1 s'il reste un KO). `safe: true` marque les
commandes qui ne font que rebrancher le poste (`setup`, `install-hooks`, réinstallation) ; jamais `sync --confirm` ni
`init --claude-token`, qui demandent l'employé. Aucun jeton n'est affiché en entier, aucune donnée du journal n'est
recopiée sans être masquée.

## Les autorisations : ce qu'on évite, ce qu'on ne peut pas éviter

| Où | Avant | Maintenant |
|---|---|---|
| Claude Code | une autorisation par étape (une dizaine de commandes) | **une seule** : la commande unique. Zéro en la collant directement dans un terminal. |
| macOS, Micro | demandé | **supprimé** : micro coupé par défaut (`setup --audio oui` pour transcrire les réunions) |
| macOS, Enregistrement de l'écran | à trouver dans les Réglages | **un clic** : panneau ouvert, chemin du binaire copié si « screenpipe » n'est pas listé, reprise automatique |
| macOS, Accessibilité | à trouver dans les Réglages | **un clic, facultatif** : améliore la lecture du texte des terminaux ; sans elle, la capture marche quand même |
| Linux, Windows | rien | rien (sous Wayland, accepter le partage d'écran s'il est proposé) |
| Windows, Claude Code | une autorisation par commande (winget, Node, réglages) | **une seule** : la ligne PowerShell (ou celle de Git Bash) |

Ce qu'on ne peut pas sauter : macOS impose que l'employé accorde lui-même l'Enregistrement de l'écran, même sur un parc
géré. En entreprise, un profil MDM (PPPC) peut pré-accorder l'Accessibilité au binaire `screenpipe` (signé Developer ID,
équipe `URFF7QHPUR`) et autoriser un utilisateur standard à cocher l'Enregistrement de l'écran sans mot de passe admin.

## Exemple (jeton fictif)

```text
Tu vas connecter ce poste à NOS Brainer, le cerveau d'entreprise de Fournil. Je suis Jean-Marc Dubois, zones : compta.
Ce message contient mon jeton personnel : ne l'affiche jamais en entier (brain-sync reconnaît cette conversation et ne l'envoie jamais au cerveau). Sois bref. Si tu ne tournes pas sur mon poste (session cloud, conteneur distant), arrête-toi et dis-moi en une phrase de recoller ce message dans Claude Code ou Codex en local (terminal `claude` ou `codex`). Action bloquée ou refusée : ne contourne rien, dis-moi en une phrase quoi faire, sans liste ni explication, puis attends.

1. Préviens-moi en une phrase : sur Mac, les Réglages Système vont s'ouvrir et je devrai activer « screenpipe » dans « Enregistrement de l'écran » puis dans « Accessibilité » ; la commande attend et reprend toute seule.
2. Lance la commande de mon système telle quelle, en un seul appel, avec un délai de 10 minutes (hors du bac à sable si elle y est bloquée) :
   macOS, Linux, Git Bash : (curl -fsSL --create-dirs https://cerveau.example.com/install.sh -o ~/.company-brain/install.sh || exit 5) && sh ~/.company-brain/install.sh --url https://cerveau.example.com --token cb_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
   Windows, PowerShell : New-Item -ItemType Directory -Force "$env:USERPROFILE\.company-brain" | Out-Null; try { Invoke-WebRequest -UseBasicParsing https://cerveau.example.com/install.ps1 -OutFile "$env:USERPROFILE\.company-brain\install.ps1" -ErrorAction Stop } catch { exit 5 }; powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\.company-brain\install.ps1" --url https://cerveau.example.com --token cb_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX; exit $LASTEXITCODE
3. Code 0 : c'est fini, le cerveau s'est ouvert dans mon navigateur. Code 3 (« EN ATTENTE ») : redis-moi où cocher, puis relance `~/.company-brain/brain setup` (même délai). Code 5 : réseau ou adresse, relance la même commande. Autre code (6 : branché sans Screenpipe) : lance `~/.company-brain/brain doctor --json` et les corrections marquées « safe » (même délai), puis dis-moi en une phrase ce qui reste à faire. Sous Windows, le client est `~/.company-brain/brain.cmd`.
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
| `--ca <pem>` | Cerveau auto-hébergé en HTTPS local : certificat de son autorité privée, auquel le client fait confiance (voir ci-dessous). |

Tout retirer : `~/.company-brain/brain uninstall` (hooks, MCP, skills de l'entreprise, synchro, service Screenpipe ; `--purge` efface aussi
`~/.company-brain`). Les enregistrements de Screenpipe restent dans `~/.screenpipe`.

## Cerveau auto-hébergé (HTTPS sur le réseau local)

Quand le cerveau tourne sur une machine de l'entreprise ([docs/LOCAL.md](../docs/LOCAL.md)), il est servi en HTTPS par une
autorité privée que les postes ne connaissent pas encore. Le prompt change alors d'une seule ligne : la commande récupère
d'abord le certificat (`/ca.crt`), vérifie son empreinte SHA-256 (épinglée dans le prompt, calculée par le serveur depuis
`BRAIN_CA_FILE`), et ne continue que si elle correspond ; `install.sh` télécharge ensuite `brain.mjs` avec ce certificat
et `setup --ca` l'enregistre pour le client (synchro, MCP, hooks) et l'installe pour les navigateurs du poste.
Un certificat public (cloud) : rien de tout cela n'apparaît.

```text
Tu vas connecter ce poste à NOS Brainer, le cerveau d'entreprise de Fournil. Je suis Jean-Marc Dubois, zones : compta.
Ce message contient mon jeton personnel : ne l'affiche jamais en entier (brain-sync reconnaît cette conversation et ne l'envoie jamais au cerveau). Sois bref. Si tu ne tournes pas sur mon poste (session cloud, conteneur distant), arrête-toi et dis-moi en une phrase de recoller ce message dans Claude Code ou Codex en local (terminal `claude` ou `codex`). Action bloquée ou refusée : ne contourne rien, dis-moi en une phrase quoi faire, sans liste ni explication, puis attends.

1. Préviens-moi en une phrase : sur Mac, les Réglages Système vont s'ouvrir et je devrai activer « screenpipe » dans « Enregistrement de l'écran » puis dans « Accessibilité » ; la commande attend et reprend toute seule.
2. Lance la commande de mon système telle quelle, en un seul appel, avec un délai de 10 minutes (hors du bac à sable si elle y est bloquée) :
   macOS, Linux, Git Bash : mkdir -p ~/.company-brain && (curl -ksSL https://192.168.1.20/ca.crt -o ~/.company-brain/ca.crt || exit 5) && ([ "$(openssl x509 -in ~/.company-brain/ca.crt -noout -fingerprint -sha256 | cut -d= -f2 | tr -d :)" = "57A3ACBF1A89EFD08B67BFA91AB261072FB73EC1C5A0102D2B6BF584C7201C49" ] || exit 9) && (curl -fsSL --cacert ~/.company-brain/ca.crt https://192.168.1.20/install.sh -o ~/.company-brain/install.sh || exit 5) && sh ~/.company-brain/install.sh --url https://192.168.1.20 --token cb_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX --ca ~/.company-brain/ca.crt
   Windows, PowerShell : New-Item -ItemType Directory -Force "$env:USERPROFILE\.company-brain" | Out-Null; $ca = "$env:USERPROFILE\.company-brain\ca.crt"; $skip = @{}; if ($PSVersionTable.PSVersion.Major -ge 6) { $skip = @{ SkipCertificateCheck = $true } } else { [Net.ServicePointManager]::ServerCertificateValidationCallback = { $true } }; try { Invoke-WebRequest -UseBasicParsing https://192.168.1.20/ca.crt -OutFile $ca -ErrorAction Stop @skip } catch { exit 5 }; [Net.ServicePointManager]::ServerCertificateValidationCallback = $null; $c = New-Object Security.Cryptography.X509Certificates.X509Certificate2 $ca; if (([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($c.RawData)) -replace '-') -ne '57A3ACBF1A89EFD08B67BFA91AB261072FB73EC1C5A0102D2B6BF584C7201C49') { exit 9 }; if (-not (Get-ChildItem Cert:\CurrentUser\Root | Where-Object Thumbprint -eq $c.Thumbprint)) { certutil -user -addstore Root $ca | Out-Null }; try { Invoke-WebRequest -UseBasicParsing https://192.168.1.20/install.ps1 -OutFile "$env:USERPROFILE\.company-brain\install.ps1" -ErrorAction Stop } catch { exit 5 }; powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\.company-brain\install.ps1" --url https://192.168.1.20 --token cb_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX --ca $ca; exit $LASTEXITCODE
   (cerveau auto-hébergé en HTTPS local : la commande récupère son certificat et vérifie son empreinte avant de s'en servir ; code 9 = empreinte différente, arrête-toi et préviens-moi. Sous Windows, une boîte de dialogue demande de confirmer l'ajout du certificat : accepter.)
3. Code 0 : c'est fini, le cerveau s'est ouvert dans mon navigateur. Code 3 (« EN ATTENTE ») : redis-moi où cocher, puis relance `~/.company-brain/brain setup` (même délai). Code 5 : réseau ou adresse, relance la même commande. Autre code (6 : branché sans Screenpipe) : lance `~/.company-brain/brain doctor --json` et les corrections marquées « safe » (même délai), puis dis-moi en une phrase ce qui reste à faire. Sous Windows, le client est `~/.company-brain/brain.cmd`.
4. Termine en trois lignes : ce qui tourne, ce qui part (des connaissances distillées, jamais l'écran brut ; aucun historique n'est envoyé) et comment tout retirer (`~/.company-brain/brain uninstall`). Propose enfin de faire apprendre au cerveau mes dernières 24 h : montre-moi d'abord `~/.company-brain/brain sync --dry-run --full --since 24h` en entier ; rien ne part avant mon accord explicite, puis `~/.company-brain/brain sync --confirm` envoie exactement ce que j'ai relu.
```

## Le message d'équipe (rejoindre sur demande)

Second moyen d'ajouter quelqu'un, à côté du prompt personnel : un message unique par entreprise (`/admin` → Demandes,
ou la dernière étape de `/creer`), source `buildJoinPrompt` dans [apps/web/lib/install-prompt.ts](../apps/web/lib/install-prompt.ts).
Il contient un code d'équipe (`cj_…`), pas de jeton : à envoyer aux collègues seulement, il ne permet que de demander.

1. Le Claude du demandeur remplit `--name`, `--title`, `--email` avec ce qu'il sait déjà (git config, mémoire, CLAUDE.md),
   sans poser de question ni rien inventer : une valeur inconnue est omise, l'admin la complétera.
2. La commande de son système (`install.sh --join` sur macOS / Linux / Git Bash, `install.ps1 --join` sous Windows) lance
   `brain join` (`apps/client/src/join.ts`) : le jeton du poste est créé localement, la demande part avec son empreinte
   seulement, puis la commande attend l'acceptation (8 min).
3. Un admin complète et accepte la demande : le compte est créé avec cette empreinte, et `join` enchaîne sur `setup`
   (mêmes codes : 0, 3, 5, 6, ou `doctor` en cas d'erreur). Code 7 : toujours en attente (`brain join` reprend la même
   demande, état dans `~/.company-brain/join.json`) ; 8 : refusée, rien n'est installé.

