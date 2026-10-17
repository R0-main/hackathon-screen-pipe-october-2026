# Installer un poste : notre CLI plutôt que des instructions à Claude

> Décision prise le 17/10/2026. Le prompt d'installation lance **notre** CLI ; il ne décrit pas à Claude comment tout
> installer. Détail du prompt : [install/PROMPT.md](../install/PROMPT.md).

## Le problème

Pour brancher un poste au cerveau, il faut Node.js, Screenpipe (installé, lancé, avec les autorisations macOS), notre
client, le MCP `company-brain`, les hooks Claude Code et une synchro planifiée. L'employé colle un prompt dans Claude
Code ; reste à choisir qui fait le travail.

## Les deux options

**A. Donner les liens à Claude et le laisser se débrouiller.** Le prompt liste Screenpipe, Node, la doc du MCP, les
hooks à écrire ; Claude Code installe à sa façon.

**B. Notre propre CLI.** Le prompt télécharge un script avec `curl` et lance une commande ; le CLI fait tout et rend un
code de sortie. Claude ne fait que lancer, lire le résultat et expliquer une erreur.

## Le choix : B

| | A. Claude improvise | B. Notre CLI |
|---|---|---|
| Résultat | Varie d'un poste à l'autre : app ou CLI de Screenpipe, version, chemin, options | Le même partout : versions figées, chemins fixes |
| Autorisations dans Claude Code | Une par commande (`brew`, `npm`, édition de `~/.claude/settings.json`…) | **Une seule** |
| Durée et coût | Long, beaucoup de tokens, dépend du modèle | Quelques minutes, presque rien à raisonner |
| En cas d'échec | À refaire à la main, on ne sait pas où ça s'est arrêté | `brain setup` reprend où il s'était arrêté |
| Tests | Impossibles | En CI (`apps/client/test`) |
| Sécurité | Le jeton circule dans plusieurs commandes ; on ne maîtrise pas ce qui est installé | Le jeton n'apparaît qu'une fois ; on choisit exactement quoi installer et d'où |
| Prompt | Long, à maintenir à chaque changement d'outil | Court (~1 600 caractères), stable |

Pour une démo devant un jury comme pour un vrai parc, il faut que l'installation marche **pareil à chaque fois**. Claude
reste utile là où il est bon : prévenir des autorisations, lire un code de sortie, expliquer une erreur et relancer.

## Comment c'est fait

```
prompt  →  macOS, Linux, Git Bash : curl …/install.sh  →  sh install.sh --url … --token …
           Windows (PowerShell)   : Invoke-WebRequest …/install.ps1  →  powershell -File install.ps1 --url … --token …
                                    ├─ Node.js ≥ 20 trouvé (hors gestionnaire de versions), sinon copie privée figée
                                    │  dans ~/.company-brain/node (sans droits admin, empreinte SHA-256 officielle vérifiée)
                                    ├─ télécharge …/brain.mjs, vérifie que c'est bien le client (pas une page d'erreur),
                                    │  écrit le raccourci ~/.company-brain/brain (Windows : brain.cmd)
                                    └─ brain setup --url … --token …
                                         ├─ config (~/.company-brain/config.json, mode 600)
                                         ├─ Screenpipe installé et lancé en service, micro coupé
                                         ├─ autorisations macOS : bon panneau ouvert, reprise automatique
                                         ├─ MCP company-brain + hooks Claude Code + skills de l'entreprise (~/.claude/skills)
                                         ├─ synchro toutes les 15 min (activité à venir seulement)
                                         └─ néon, puis le cerveau s'ouvre dans le navigateur, déjà connecté
```

| Fichier | Rôle |
|---|---|
| `apps/web/public/install.sh` | Amorce POSIX (macOS, Linux ; sous Git Bash, passe la main à `install.ps1`), servie sur `/install.sh`. |
| `apps/web/public/install.ps1` | Amorce Windows (PowerShell 5.1 et 7), servie sur `/install.ps1`. |
| `apps/client/src/cli.ts`, `setup.ts` | Le CLI, empaqueté en un seul fichier `brain.mjs` (servi sur `/brain.mjs`, empreinte sur `/brain.mjs.sha256`). |
| `apps/client/src/doctor.ts` | `brain doctor` : diagnostic en lecture seule, avec la commande qui répare chaque point KO (`--json` pour Claude). |
| `apps/web/lib/install-prompt.ts` | Le prompt court, généré avec le jeton de chaque employé. |
| `apps/client/test/install-prompt.test.ts` | Le prompt ne cite que des commandes et des codes qui existent. |
| `apps/client/test/install-script.test.ts` | `install.sh` / `install.ps1` : téléchargements, page d'erreur refusée, raccourcis, codes ; en CI sous Linux et Windows. |

Codes de sortie (scripts et `setup`) :

| Code | Sens | Suite |
|---|---|---|
| 0 | Tout est branché | — |
| 1 | `setup` a échoué | `brain doctor` dit quoi, avec la commande qui répare |
| 2 | Mauvais appel (`--url` absent ou invalide, lancé avec `sudo`) | Relancer la commande du prompt telle quelle |
| 3 | Autorisation macOS « Enregistrement de l'écran » en attente | La cocher, puis `~/.company-brain/brain setup` |
| 4 | Système non géré, ou Node.js impossible à installer ici | Le message dit quoi installer |
| 5 | Téléchargement impossible (réseau, proxy, adresse, page d'erreur) | Relancer la même commande ; l'ancien client reste intact |
| 6 | Tout est branché sauf Screenpipe (pas de version pour ce poste, ou il ne démarre pas) | `brain doctor` dit pourquoi |

## `brain doctor`

Quand quelque chose coince, Claude n'a pas à deviner : `brain doctor --json` passe le poste en revue (Node.js et
raccourci, connexion au cerveau et version du client, Screenpipe et ses autorisations, MCP et hooks de Claude Code,
synchro planifiée et son journal, distillation) **sans rien modifier**, et donne pour chaque point KO la commande qui
répare. Il lance vraiment ce que lancent le raccourci, les hooks, le MCP et la synchro planifiée (`_probe`) : un
chemin resté sur un ancien Node.js ou un ancien client se voit tout de suite. Les commandes marquées `safe` ne font que
rebrancher le poste ; Claude les lance sans redemander. Détail : [install/PROMPT.md](../install/PROMPT.md#brain-doctor--le-diagnostic).

Pas de commande pour interroger le cerveau depuis le terminal : c'est le rôle du MCP `company-brain`, dans Claude Code.

Pourquoi `sh ~/.company-brain/install.sh` plutôt que `curl … | sh` : le script reste sur le disque, Claude ou l'employé
peut le relire, et un téléchargement coupé ne s'exécute jamais à moitié.

## Limites et suite

- **Windows** : installation, raccourcis, MCP, hooks (lancés sans shell, donc aussi sans Git Bash) et synchro planifiée
  sont gérés, mais pas encore essayés sur un vrai poste (seulement en CI `windows-latest`). Screenpipe y tourne en
  arrière-plan, sans service : après un redémarrage, `brain doctor` le signale et `brain setup` le relance. La tâche
  planifiée ouvre une console toutes les 15 min et ne tourne pas sur batterie (réglages par défaut de `schtasks`) :
  à passer en tâche XML masquée.
- **Linux** : Screenpipe 0.4.52 demande glibc ≥ 2.39 (Ubuntu 24.04 et plus) et pipewire / pulseaudio ; sans eux,
  `setup` branche le reste et sort en 6. Rien pour linux-arm64 ni Windows sur ARM sans émulation x64.
- **Supprimer Node** : compiler le client en binaire autonome par plateforme (Node SEA ou `bun build --compile`) et le
  publier. `install.sh` téléchargerait alors ce binaire au lieu de Node + `brain.mjs`.
- **Signer `install.sh` et `brain.mjs`** ou publier leurs empreintes, pour qu'un poste puisse vérifier ce qu'il exécute
  même si le serveur du cerveau était compromis.
