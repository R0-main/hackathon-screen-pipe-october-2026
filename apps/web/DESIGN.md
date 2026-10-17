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
  molette, pincer ou boutons pour zoomer. Sans WebGL : `BrainViz` (2D, même monochrome).

## Gabarit (`components/AppShell.tsx`)

- Barre latérale à gauche (fond bone, trait de 1 px) : le cerveau, ses pages (agents en direct, état, connaissances,
  tâches, automatisations), la configuration pour les admins (équipe et accès, onboarding), puis « voir en tant que »,
  mon contexte et la déconnexion. Sous 768 px, elle s'ouvre par le bouton menu.
- À droite, la page. La fenêtre ne défile jamais : le cerveau remplit tout l'espace (la molette zoome), les autres
  pages défilent dans leur colonne.
- L'état vivant (flux SSE, zones allumées) est dans le layout (`components/BrainLive.tsx`) : il survit à la navigation.

## Page d'accueil publique (`/`)

Adresses : `/` la page d'accueil (pour tout le monde), `/demo` l'entrée de la démo (choix d'un compte de Fournil,
mode démo seulement), `/login` la connexion par jeton, `/dashboard` le cerveau et, à côté, les autres pages
connectées. `/accueil` redirige vers `/`.

Même monde, à l'échelle d'une page (`components/landing`, bloc « Page d'accueil » de `globals.css`).

- Grands titres Space Grotesk serrés (`.landing-display`, `.landing-h2`), beaucoup de vide, une colonne de texte à gauche.
- Le cerveau (`ScrollBrain`) reprend la géométrie de `Brain3D` (`brain-geometry.ts`) et ajoute une coque en anneaux
  de contour ondulés et un brouillard bone pour la profondeur. Pas d'ombre, pas de halo.
- Mouvement : exception à la règle des 200 ms, réservée à cette page (`components/landing/motion/setup.ts`).
  - La scène du cerveau est épinglée sur 7 écrans et suit le scroll (GSAP ScrollTrigger, défilement doux Lenis) :
    le cerveau passe en plein écran et tourne, les connaissances se posent, les zones se nomment, trois agents
    allument leur zone en phosphore.
  - Ensuite, chaque section occupe un écran, contenu centré, et marque un arrêt : elle reste calée sur l'écran
    pendant 0,6 écran de scroll (`data-hold` pour allonger : 1,4 pour « Le brut reste sur le poste »). Lâché tout
    près d'un chapitre ou d'une section, le scroll s'y cale en douceur.
  - Toutes les animations des sections suivent le scroll : elles avancent quand on descend, s'arrêtent quand on
    s'arrête, se rejouent à l'envers quand on remonte. Les titres passent de pâle à encre mot par mot ; le panneau
    « Où en est Fournil » se remplit et le prompt s'écrit pendant l'arrêt ; le schéma vie privée (`PrivacyFlow`)
    attend que sa section soit calée pour se jouer.
  - Un fil encre descend le long des sections, avec une bille qui se remplit à chaque section.
  - Seule l'entrée du premier écran se joue au chargement (les mots du titre, puis le reste), et la lente rotation
    d'attente du cerveau tourne seule.
  - Boutons magnétiques (souris seulement) : ils glissent vers le pointeur, reviennent avec un léger rebond et
    s'enfoncent au clic.
- `prefers-reduced-motion` : pas d'épinglage, d'arrêt ni de défilement doux, cerveau immobile et assemblé, chapitres
  lus à la suite, toutes les sections dans leur état final.
- Le phosphore reste réservé aux zones qu'un agent interroge (ici, les trois agents de la démo).
