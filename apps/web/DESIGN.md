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

## Logo

- `<LogoMark>` (`components/ui.tsx`) et le favicon `app/icon.svg`, seulement : en haut à gauche (accueil, `/creer`,
  barre latérale) et dans l'onglet. Partout ailleurs, l'icône du cerveau reste `<BrainIcon>`.
- Sa bille centrale est en phosphore : seule exception à la règle du phosphore, elle fait partie de la marque.

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
- Une rubrique à sous-pages (Équipe et accès : organigramme, accès par zone, demandes, zones ; une adresse chacune sous
  `/admin`) se déplie quand on y est, sans chevron : un fil de 1 px aligné sur l'icône, les sous-pages en texte
  secondaire, et une barre d'encre qui glisse le long du fil jusqu'à la page courante (200 ms). Pas d'onglets en haut
  de page.
- À droite, la page. La fenêtre ne défile jamais : le cerveau remplit tout l'espace (la molette zoome), les autres
  pages défilent dans leur colonne.
- L'état vivant (flux SSE, zones allumées) est dans le layout (`components/BrainLive.tsx`) : il survit à la navigation.

## Où en est l'entreprise (`/etat`, `components/StatusPanel.tsx`)

- Lu comme un point d'équipe, sans panneau : le titre de page, puis la réponse (le titre généré, 19 à 21 px), qui l'a
  rédigée et quand, et pour un admin sans Claude la commande à copier.
- Sous un trait de 1 px, deux colonnes (une sous 1024 px) : « À suivre », les prochaines étapes de toutes les zones
  (une bille vide, pleine et barrée quand la tâche correspondante est faite), et le sommaire des zones (lien vers leur
  section, nombre de connaissances, avancement).
- « Zone par zone » : chaque zone est accrochée à un fil vertical par sa bille (`ZoneBead` : sa couleur cerclée d'encre,
  comme un centre de zone dans le cerveau). Résumé, objectifs, qui a fait quoi (avec le dot de la personne), et un lien
  vers ses connaissances (`/connaissances?zone=…`).
- L'avancement se lit en billes : une par tâche lisible (`task_counts` de l'état), pleine quand elle est faite, puis
  « 1 sur 2 ». Au-delà de 10 tâches, les billes passent à l'échelle.

## Connaissances (`/connaissances`, `components/KnowledgeList.tsx`)

- Un fil chronologique, jour par jour (« Aujourd'hui », « Hier », puis la date), dans le fuseau de l'entreprise. Toutes
  les connaissances en vigueur des zones lisibles (500 au plus), plus celles qui arrivent en direct.
- Chaque connaissance : sa bille sur le fil du jour, le titre, son type et sa zone, le dot de l'auteur et l'heure.
  Dépliée, la ligne devient un panneau blanc : contenu, entités (liens), auteur, source, confiance.
- Barre de filtres collée en haut de la colonne : recherche sans accents (titre, contenu, entités, auteur), zones et
  types en puces avec leur nombre compte tenu des autres filtres. Les filtres s'écrivent dans l'adresse (`?q=`, `?zone=`,
  `?type=`), sans entrée d'historique.

## Page d'accueil publique (`/`)

Adresses : `/` la page d'accueil (pour tout le monde), `/creer` la création d'une entreprise, `/demo` l'entrée de la
démo (choix d'un compte de Butine, mode démo seulement), `/login` l'entrée (entreprises retenues, gros bouton « Créer mon entreprise », jeton replié dessous), `/dashboard` le cerveau et,
à côté, les autres pages connectées. `/accueil` redirige vers `/`.

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
    « Où en est Butine » se remplit et le prompt s'écrit pendant l'arrêt ; le schéma vie privée (`PrivacyFlow`)
    attend que sa section soit calée pour se jouer.
  - Un fil encre descend le long des sections, avec une bille qui se remplit à chaque section.
  - Seule l'entrée du premier écran se joue au chargement (les mots du titre, puis le reste), et la lente rotation
    d'attente du cerveau tourne seule.
  - Boutons magnétiques (souris seulement) : ils glissent vers le pointeur, reviennent avec un léger rebond et
    s'enfoncent au clic.
- Après « Le brut reste sur le poste », deux sections d'offre (`components/landing/Offer.tsx`) : « Chez vous, ou chez
  nous » (auto-hébergé, code ouvert, ou notre cloud) puis les tarifs (`#tarifs`, lien « Tarifs » dans l'en-tête),
  avec un choix mensuel ou annuel. Front seulement : prix indicatifs, aucun paiement branché ; les boutons cloud mènent
  à `/creer` (ou à la démo si la création est fermée). Leurs cartes (`data-reveal="cards"`) sont en place avant
  l'arrêt de la section, pour qu'on puisse comparer dès l'arrivée. Un seul bouton principal : l'offre Équipe.
- `prefers-reduced-motion` : pas d'épinglage, d'arrêt ni de défilement doux, cerveau immobile et assemblé, chapitres
  lus à la suite, toutes les sections dans leur état final.
- Le phosphore reste réservé aux zones qu'un agent interroge (ici, les trois agents de la démo).

## Créer son entreprise (`/creer`, `components/CreateCompany.tsx`)

- Une question par écran, à la manière d'une page blanche : grand titre (`.create-title`), champ sans cadre souligné
  d'un trait qui s'épaissit au focus (`.create-input`), « Continuer » ou Entrée, « Retour » discret.
- Un trait de 1 px sous l'en-tête avance d'étape en étape. Entrée de chaque écran : 8 px et opacité, 200 ms.
- À droite (≥ 1024 px), le cerveau se construit dans la langue du dashboard : un centre, une bille par zone choisie,
  les personnes autour, pleines une fois leur poste branché. Les couleurs sont celles que le serveur attribuera.
- Après la création : le prompt de son poste (`PromptActions`, partagé avec la page d'accueil), le témoin « en direct »
  qui s'allume quand le poste se branche, puis un prompt par collègue invité.

