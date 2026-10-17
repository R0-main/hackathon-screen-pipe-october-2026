# Skills Claude Code du projet

Skills copiés dans `.claude/skills/` pour que toute l'équipe ait les mêmes outils de front.

| Skills | Source | Commit | Licence |
| --- | --- | --- | --- |
| `impeccable` | [pbakaus/impeccable](https://github.com/pbakaus/impeccable) | `6af45ac` | Apache-2.0 |
| `gsap-*` (8 skills) | [greensock/gsap-skills](https://github.com/greensock/gsap-skills) | `aed9cfd` | MIT |
| `emil-design-eng`, `animate`, `review-animations`, `improve-animations`, `animation-performance`, `animation-vocabulary` | [emilkowalski/skills](https://github.com/emilkowalski/skills) | `2d22863` | MIT |

Les hooks d'Impeccable (détecteur lancé à chaque modification d'un fichier d'interface) ne sont pas activés : son
lanceur télécharge un binaire au premier usage. Pour les activer, voir `.claude/skills/impeccable/reference/hooks.md`.
Sans hook, lancer le détecteur à la main : `.claude/skills/impeccable/scripts/impeccable detect --json <fichiers>`.
