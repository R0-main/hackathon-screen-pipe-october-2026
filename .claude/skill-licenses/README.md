# The project's Claude Code skills

Skills copied into `.claude/skills/` so the whole team has the same front-end and UX tools, without installing anything.

**Project rule**: the art direction of `apps/web/DESIGN.md` and the product truth of `apps/web/PRODUCT.md` take
precedence over a skill's generic advice. For example, `frontend-design` advises against some very common fonts, but
Space Grotesk is a choice of the project and stays.

## Which skill for what

| Need | Skill |
| --- | --- |
| Design or redo a page, avoid the generic look | `impeccable`, `frontend-design` |
| Look up a style, a palette, fonts or a UX rule in a local database | `ui-ux-pro-max` |
| Critique a page or a mockup (hierarchy, readability, consistency) | `design-critique`, `impeccable critique` |
| WCAG 2.1 AA accessibility audit | `accessibility-review` |
| Check interface code against a checklist (focus, forms, images, i18n…) | `web-design-guidelines` |
| Interface copy: buttons, errors, empty states | `ux-copy` |
| Animations: decide, build, review | `animate`, `review-animations`, `improve-animations`, `emil-design-eng` |
| Scroll animations, timelines | `gsap-scrolltrigger`, `gsap-timeline`, `gsap-react` and the other `gsap-*` |
| Smoothness (frames per second, properties to animate) | `animation-performance`, `gsap-performance` |
| React / Next.js performance | `react-best-practices` |

## Sources

| Skills | Source | Commit | License |
| --- | --- | --- | --- |
| `impeccable` | [pbakaus/impeccable](https://github.com/pbakaus/impeccable) | `6af45ac` | Apache-2.0 |
| `gsap-*` (8 skills) | [greensock/gsap-skills](https://github.com/greensock/gsap-skills) | `aed9cfd` | MIT |
| `emil-design-eng`, `animate`, `review-animations`, `improve-animations`, `animation-performance`, `animation-vocabulary` | [emilkowalski/skills](https://github.com/emilkowalski/skills) | `2d22863` | MIT |
| `frontend-design` | [anthropics/skills](https://github.com/anthropics/skills) (identical to `plugins/frontend-design` in [anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official)) | `dbd4588` | Apache-2.0 |
| `design-critique`, `accessibility-review`, `ux-copy` | [anthropics/knowledge-work-plugins](https://github.com/anthropics/knowledge-work-plugins) (`design`) | `33eeda1` | Apache-2.0 |
| `ui-ux-pro-max` (without its tests) | [nextlevelbuilder/ui-ux-pro-max-skill](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill) | `56ea9cf` | MIT |
| `react-best-practices` | [vercel-labs/agent-skills](https://github.com/vercel-labs/agent-skills) | `063bee9` | MIT (stated in their README, no license file) |
| `web-design-guidelines` | [vercel-labs/agent-skills](https://github.com/vercel-labs/agent-skills); rules copied from [vercel-labs/web-interface-guidelines](https://github.com/vercel-labs/web-interface-guidelines) | `063bee9` / `434b7f9` | MIT |

Local adaptations:
- `web-design-guidelines` reads its rules from `guidelines.md` (a local copy) instead of downloading them at each review.
- `design-critique`, `accessibility-review` and `ux-copy` point to `design-CONNECTORS.md` (in this folder) for the
  connected tools (Figma, project tracking).

Impeccable's hooks (a detector run on every change to an interface file) are not enabled: its launcher downloads a
binary on first use. To enable them, see `.claude/skills/impeccable/reference/hooks.md`. Without a hook, run the
detector by hand: `.claude/skills/impeccable/scripts/impeccable detect --json <files>`.

`ui-ux-pro-max` searches its local data (styles, palettes, fonts, UX rules):
`python3 .claude/skills/ui-ux-pro-max/scripts/search.py "navigation" --domain ux`.
