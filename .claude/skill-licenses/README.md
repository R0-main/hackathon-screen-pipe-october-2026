# Skills Claude Code du projet

Skills copiés dans `.claude/skills/` pour que toute l'équipe ait les mêmes outils de front.

| Skills | Source | Commit | Licence |
| --- | --- | --- | --- |
| `impeccable` | [pbakaus/impeccable](https://github.com/pbakaus/impeccable) | `6af45ac` | Apache-2.0 |
| `gsap-*` (8 skills) | [greensock/gsap-skills](https://github.com/greensock/gsap-skills) | `aed9cfd` | MIT |
| `emil-design-eng`, `animate`, `review-animations`, `improve-animations`, `animation-performance`, `animation-vocabulary` | [emilkowalski/skills](https://github.com/emilkowalski/skills) | `2d22863` | MIT |
| `frontend-design` | [anthropics/skills](https://github.com/anthropics/skills) | `dbd4588` | Apache-2.0 |
| `ui-ux-pro-max` (sans ses tests) | [nextlevelbuilder/ui-ux-pro-max-skill](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill) | `56ea9cf` | MIT |
| `web-design-guidelines`, `react-best-practices` | [vercel-labs/agent-skills](https://github.com/vercel-labs/agent-skills) | `063bee9` | MIT (déclarée dans leur README, pas de fichier de licence) |

Les hooks d'Impeccable (détecteur lancé à chaque modification d'un fichier d'interface) ne sont pas activés : son
lanceur télécharge un binaire au premier usage. Pour les activer, voir `.claude/skills/impeccable/reference/hooks.md`.
Sans hook, lancer le détecteur à la main : `.claude/skills/impeccable/scripts/impeccable detect --json <fichiers>`.

`ui-ux-pro-max` cherche dans ses données locales (styles, palettes, polices, règles UX) :
`python3 .claude/skills/ui-ux-pro-max/scripts/search.py "navigation" --domain ux`. `web-design-guidelines` télécharge
ses règles à jour depuis vercel-labs/web-interface-guidelines à chaque relecture.
