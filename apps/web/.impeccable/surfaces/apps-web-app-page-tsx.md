---
version: 1
slug: "apps-web-app-page-tsx"
primary_target: "apps/web/app/page.tsx"
related_targets: ["apps/web/components/landing"]
---

# Frontpage publique

Scope : `/` pour un visiteur non connecté (le dashboard reste sur `/` une fois connecté). Mode : Persuade.

- Audience : dirigeants de PME et startups, jury du hackathon Screenpipe.
- Action : « Ouvrir la démo » (vers `/login`, connexion en un clic en mode démo ; « Se connecter » sinon).
- Preuve : le cerveau de Butine (entreprise fictive de balances connectées pour ruches, 34 connaissances, 6 zones), le prompt d'installation réel, la suggestion d'automatisation réelle de la démo. Aucun client ni chiffre inventé.
- Contraintes : DESIGN.md (bone, encre, phosphore seulement quand un agent touche une zone, billes et traits, Space Grotesk). Concept imposé par le brief : le cerveau, qui passe en plein écran et tourne dès qu'on scrolle, puis la page passe à la suite.

## Direction contract

THESIS: La page est le cerveau ; scroller, c'est le lire. Elle refuse le gabarit SaaS (titre, capture, trois cartes de fonctionnalités, logos).

OWN-WORLD: Fond bone, texte encre, traits de 1 px, billes d'encre reliées par des fils, pastilles de zone de ZONE_PALETTE, phosphore uniquement quand un agent interroge une zone. Grands titres en Space Grotesk serrés, mono seulement pour le prompt d'installation.

STORY: Le visiteur voit un cerveau vivant. Au scroll, il prend tout l'écran et tourne : les connaissances arrivent des postes et s'y posent, les zones apparaissent, des agents viennent y chercher du contexte et les zones s'allument. Puis le cerveau se retire : ce que voit la dirigeante, l'installation en un message, la vie privée, et on ouvre la démo.

FIRST VIEWPORT: Canvas plein cadre. Cerveau à droite, environ 70 % de la hauteur. Barre fine en haut : nom à gauche, « Se connecter » et « Ouvrir la démo » à droite. Titre en bas à gauche sur trois lignes, de 44 à 104 px, une phrase de sous-titre, bouton principal « Ouvrir la démo » et lien « Voir comment ça marche ».

FORM: Scène épinglée en trois chapitres pilotée par le scroll (forme imposée par le brief, 1re sur la liste). Interaction signature : le cerveau avance jusqu'à remplir l'écran en faisant un demi-tour, les billes dispersées convergent sur la coque, puis les zones s'allument une à une. seed: none (direction imposée par le brief, pas de tirage)

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
