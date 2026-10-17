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
prompt  →  curl …/install.sh  →  sh install.sh --url … --token …
                                    ├─ Node.js ≥ 20 trouvé, sinon copie privée dans ~/.company-brain/node
                                    │  (sans droits admin, empreinte SHA-256 officielle vérifiée)
                                    ├─ télécharge …/brain.mjs, écrit le raccourci ~/.company-brain/brain
                                    └─ brain setup --url … --token …
                                         ├─ config (~/.company-brain/config.json, mode 600)
                                         ├─ Screenpipe installé et lancé en service, micro coupé
                                         ├─ autorisations macOS : bon panneau ouvert, reprise automatique
                                         ├─ MCP company-brain + hooks Claude Code
                                         ├─ synchro toutes les 15 min (activité à venir seulement)
                                         └─ néon, puis le cerveau s'ouvre dans le navigateur, déjà connecté
```

| Fichier | Rôle |
|---|---|
| `apps/web/public/install.sh` | Amorce POSIX, servie sur `/install.sh`. |
| `apps/client/src/cli.ts`, `setup.ts` | Le CLI, empaqueté en un seul fichier `brain.mjs` (servi sur `/brain.mjs`). |
| `apps/web/lib/install-prompt.ts` | Le prompt court, généré avec le jeton de chaque employé. |
| `apps/client/test/install-prompt.test.ts` | Le prompt ne cite que des commandes qui existent ; `install.sh` lance bien `setup` et rend son code. |

Codes de sortie : **0** tout est branché, **3** autorisation macOS en attente (relancer `~/.company-brain/brain setup`
une fois cochée), **2** mauvais appel de `install.sh`, **4** Node.js manquant sur un système que le script ne gère pas.

Pourquoi `sh ~/.company-brain/install.sh` plutôt que `curl … | sh` : le script reste sur le disque, Claude ou l'employé
peut le relire, et un téléchargement coupé ne s'exécute jamais à moitié.

## Limites et suite

- **Windows** : `install.sh` tourne dans le Git Bash de Claude Code, mais n'installe pas Node lui-même (code 4 avec la
  commande `winget` à lancer). Le CLI, lui, gère Windows (tâche planifiée).
- **Supprimer Node** : compiler le client en binaire autonome par plateforme (Node SEA ou `bun build --compile`) et le
  publier. `install.sh` téléchargerait alors ce binaire au lieu de Node + `brain.mjs`.
- **Signer `install.sh` et `brain.mjs`** ou publier leurs empreintes, pour qu'un poste puisse vérifier ce qu'il exécute
  même si le serveur du cerveau était compromis.
