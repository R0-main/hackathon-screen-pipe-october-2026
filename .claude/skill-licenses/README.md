# Skills Claude Code du projet

Skills copiés dans `.claude/skills/` pour que toute l'équipe ait les mêmes outils de front et d'UX, sans rien installer.

**Règle du projet** : la direction artistique de `apps/web/DESIGN.md` et la vérité produit de `apps/web/PRODUCT.md`
priment sur les conseils génériques d'un skill. Par exemple, `frontend-design` déconseille certaines polices très
répandues, mais Space Grotesk est un choix du projet et reste.

## Quel skill pour quoi

| Besoin | Skill |
| --- | --- |
| Concevoir ou refaire une page, éviter le rendu générique | `impeccable`, `frontend-design` |
| Chercher un style, une palette, des polices ou une règle UX dans une base locale | `ui-ux-pro-max` |
| Critiquer une page ou une maquette (hiérarchie, lisibilité, cohérence) | `design-critique`, `impeccable critique` |
| Audit d'accessibilité WCAG 2.1 AA | `accessibility-review` |
| Vérifier le code d'interface contre une checklist (focus, formulaires, images, i18n…) | `web-design-guidelines` |
| Textes d'interface : boutons, erreurs, états vides | `ux-copy` |
| Animations : décider, construire, relire | `animate`, `review-animations`, `improve-animations`, `emil-design-eng` |
| Animations au scroll, timelines | `gsap-scrolltrigger`, `gsap-timeline`, `gsap-react` et les autres `gsap-*` |
| Fluidité (images par seconde, propriétés à animer) | `animation-performance`, `gsap-performance` |
| Performance React / Next.js | `react-best-practices` |

## Sources

| Skills | Source | Commit | Licence |
| --- | --- | --- | --- |
| `impeccable` | [pbakaus/impeccable](https://github.com/pbakaus/impeccable) | `6af45ac` | Apache-2.0 |
| `gsap-*` (8 skills) | [greensock/gsap-skills](https://github.com/greensock/gsap-skills) | `aed9cfd` | MIT |
| `emil-design-eng`, `animate`, `review-animations`, `improve-animations`, `animation-performance`, `animation-vocabulary` | [emilkowalski/skills](https://github.com/emilkowalski/skills) | `2d22863` | MIT |
| `frontend-design` | [anthropics/skills](https://github.com/anthropics/skills) (identique à `plugins/frontend-design` de [anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official)) | `dbd4588` | Apache-2.0 |
| `design-critique`, `accessibility-review`, `ux-copy` | [anthropics/knowledge-work-plugins](https://github.com/anthropics/knowledge-work-plugins) (`design`) | `33eeda1` | Apache-2.0 |
| `ui-ux-pro-max` (sans ses tests) | [nextlevelbuilder/ui-ux-pro-max-skill](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill) | `56ea9cf` | MIT |
| `react-best-practices` | [vercel-labs/agent-skills](https://github.com/vercel-labs/agent-skills) | `063bee9` | MIT (déclarée dans leur README, pas de fichier de licence) |
| `web-design-guidelines` | [vercel-labs/agent-skills](https://github.com/vercel-labs/agent-skills) ; règles copiées de [vercel-labs/web-interface-guidelines](https://github.com/vercel-labs/web-interface-guidelines) | `063bee9` / `434b7f9` | MIT |

Adaptations locales :
- `web-design-guidelines` lit ses règles dans `guidelines.md` (copie locale) au lieu de les télécharger à chaque revue.
- `design-critique`, `accessibility-review` et `ux-copy` renvoient vers `design-CONNECTORS.md` (dans ce dossier) pour
  les outils connectés (Figma, suivi de projet).

Les hooks d'Impeccable (détecteur lancé à chaque modification d'un fichier d'interface) ne sont pas activés : son
lanceur télécharge un binaire au premier usage. Pour les activer, voir `.claude/skills/impeccable/reference/hooks.md`.
Sans hook, lancer le détecteur à la main : `.claude/skills/impeccable/scripts/impeccable detect --json <fichiers>`.

`ui-ux-pro-max` cherche dans ses données locales (styles, palettes, polices, règles UX) :
`python3 .claude/skills/ui-ux-pro-max/scripts/search.py "navigation" --domain ux`.
