# Direction artistique du front

Celle de screenpipe.com (monochrome « bone », phosphore réservé à l'action en cours), poussée vers encore
plus de vide. Les règles ci-dessous s'appliquent à tout `apps/web`. Elles sont codées dans
`app/globals.css` (tokens `@theme`, classes `.panel`, `.btn`, `.input`, `.chip`, `.inset`) et dans
`components/ui.tsx` (pastilles de zone, icônes, erreurs).

## Couleurs

| Rôle | Valeur | Usage |
| --- | --- | --- |
| bone | `#f6f6f3` | fond de page |
| surface | `#ffffff` | panneaux, champs, étiquettes |
| ink | `#0a0a0a` | texte, traits, bouton principal |
| signal | `#333333` | survol du bouton principal |
| trace | `#78786f` | texte secondaire |
| line / line-strong | `#e2e2dc` / `#c6c6bf` | traits de 1 px, bordures de champs |
| phosphor | `#c7ff3e` | **uniquement** une zone qu'un agent touche en direct, le témoin « en direct », les ondes |
| danger | `#b42318` | texte d'erreur, à côté de l'action |

- Le texte ne porte jamais de couleur. Une zone s'identifie par une pastille de 8 px (`<ZoneTag>`), toujours
  accompagnée de son nom.
- Les couleurs de zone viennent de `ZONE_PALETTE` (`components/ui.tsx`), palette catégorielle à ordre fixe
  validée pour le daltonisme sur fond clair ; la même liste est dans `packages/core/src/zones.ts` pour le seed.
  Les anciennes couleurs néon encore en base sont remappées par `zoneColor()`.
- Pas de dégradé, pas d'ombre au repos, pas de flou, pas de halo.

## Typographie

- Space Grotesk pour tout, IBM Plex Mono seulement pour un jeton ou du code (`.mono`).
- Phrase (sentence case) partout, pas de majuscules espacées, pas d'étiquette au-dessus d'un titre.
- Les nombres en `tabular-nums`. Titres en `text-balance`, paragraphes en `text-pretty` (par défaut dans le CSS).
- Pas d'emoji, pas de point d'exclamation, pas de « A · B · C », pas de flèche collée à un lien.

## Formes

- Rayons : 8 px panneaux, 6 px contrôles et blocs internes, 4 px étiquettes, 0 pour le canvas 3D.
- Un panneau = blanc + trait de 1 px. À l'intérieur, un bloc secondaire = `.inset` (un pas de ton, pas de trait).
- Bouton principal : fond encre, texte blanc. Un seul par vue. Bouton secondaire : blanc, trait fort.
- Icônes : SVG inline de `ui.tsx`, trait 1,5, 16 px, `aria-hidden`. Un bouton icône porte un `aria-label`.

## Mouvement

- Transform et opacité seulement, 200 ms au plus, `ease-out` à l'entrée, `prefers-reduced-motion` respecté.
- Le cerveau 3D tourne seul lentement quand on ne le touche pas ; il s'arrête hors écran et sous
  `prefers-reduced-motion`.

## Cerveau 3D (`components/Brain3D.tsx`)

- Billes = connaissances (encre), groupées par zone sur une coque ; centre de zone = bille colorée cerclée
  d'encre ; traits fins vers le centre ; arcs entre zones qui partagent des entités.
- Zone active : phosphore sur ses billes et son centre, onde phosphore, bulle blanche avec le libellé.
- Libellés = vrais boutons HTML projetés sur la scène (clavier et lecteur d'écran), glisser pour tourner,
  Ctrl + molette ou boutons pour zoomer. Sans WebGL : `BrainViz` (2D, même monochrome).
