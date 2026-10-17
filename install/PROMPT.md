# Le prompt d'installation de NOS Brainer

Le dashboard le génère pour chaque employé (`/admin` → « Inviter quelqu'un » ou « Nouveau prompt »), avec son jeton
personnel (affiché une seule fois) et l'URL du cerveau. Source : [apps/web/lib/install-prompt.ts](../apps/web/lib/install-prompt.ts).

L'employé le colle dans Claude Code. Claude prévient des autorisations à venir, lance **une seule commande**, lit la
sortie et dépanne si besoin. Toute la mécanique est dans `brain.mjs setup` (`apps/client/src/setup.ts`) :

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
Tu vas connecter ce poste à NOS Brainer, le cerveau d'entreprise de Fournil. Je suis Jean-Marc Dubois.
Tout tient en une commande : lance-la telle quelle, en un seul appel (une seule autorisation à me demander), puis lis sa sortie. Sois bref.

Paramètres :
- URL du cerveau : https://cerveau.example.com
- Mon jeton personnel (secret : ne l'affiche jamais en entier, ne l'écris nulle part ailleurs que dans la commande) : cb_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
- Zones auxquelles j'ai accès : compta
(Cette conversation contient mon jeton : brain-sync la reconnaît et ne l'envoie jamais au cerveau.)

1. Prérequis : Node.js ≥ 20 (`node -v`). S'il manque, propose-moi de l'installer (Mac : `brew install node`, sinon https://nodejs.org) et attends mon accord.

2. Préviens-moi en une phrase avant de lancer : sur Mac, les Réglages Système vont s'ouvrir et je devrai activer « screenpipe » dans
   « Enregistrement de l'écran », puis dans « Accessibilité » ; la commande attend et continue toute seule dès que c'est coché. Pas de micro.

3. Lance cette commande avec un délai de 10 minutes (elle attend mes autorisations) :
   curl -fsSL --create-dirs https://cerveau.example.com/brain.mjs -o ~/.company-brain/brain.mjs && node ~/.company-brain/brain.mjs setup --url https://cerveau.example.com --token cb_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
   Elle installe et lance Screenpipe (capture locale de l'écran, micro coupé), enregistre ma config, branche le MCP company-brain et les
   hooks Claude Code, planifie la synchro toutes les 15 minutes (seulement l'activité à venir : aucun historique n'est envoyé), allume
   mon néon et ouvre le cerveau dans mon navigateur, déjà connecté. Si le bac à sable de Claude Code la bloque (elle écrit dans
   ~/.company-brain, ~/.claude et les tâches de fond du système), relance-la hors du bac à sable.

4. Lis la sortie :
   - code 0 : c'est fini ;
   - code 3 (« EN ATTENTE ») : l'autorisation d'enregistrer l'écran manque encore ; redis-moi où cliquer, puis relance `node ~/.company-brain/brain.mjs setup`
     (sans paramètres, la config est gardée) ;
   - autre erreur : explique-la simplement, corrige ce que tu peux sans droits administrateur (demande-moi avant sinon) et relance
     `node ~/.company-brain/brain.mjs setup`, qui reprend là où ça s'est arrêté. `node ~/.company-brain/brain.mjs status` donne l'état complet.

5. Termine en quatre lignes au plus : ce qui tourne, le lien du cerveau, ce qui part (des connaissances distillées, jamais l'écran brut ;
   secrets et données perso masqués sur le poste) et comment tout retirer (`node ~/.company-brain/brain.mjs uninstall`). Propose-moi enfin, si je veux que le
   cerveau apprenne aussi de mes dernières 24 h : `node ~/.company-brain/brain.mjs sync --dry-run --full --since 24h`, que tu me montres en entier ; rien ne part
   avant mon accord explicite, puis `node ~/.company-brain/brain.mjs sync --confirm` envoie exactement ce que j'ai relu.
```

## Options de `setup`

| Option | Effet |
|---|---|
| `--url <url> --token <jeton>` | Première installation (ensuite inutiles). |
| `--audio oui\|non` | Micro et transcription des réunions (non par défaut ; macOS demande alors aussi le Micro). |
| `--wait <secondes>` | Attente des autorisations macOS (300 par défaut). |
| `--no-open` | N'ouvre pas le navigateur. |
| `--skip-screenpipe` | Sans Screenpipe : brain-sync lit seulement les sessions Claude Code et Codex. |

Tout retirer : `node ~/.company-brain/brain.mjs uninstall` (hooks, MCP, synchro, service Screenpipe ; `--purge` efface aussi
`~/.company-brain`). Les enregistrements de Screenpipe restent dans `~/.screenpipe`.
