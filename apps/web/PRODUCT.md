# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- Dirigeants de PME et de startups (CEO, associés) dont les équipes travaillent déjà avec Claude Code, Codex ou ChatGPT, et qui veulent que ce contexte serve à toute l'entreprise.
- Le jury du hackathon Screenpipe « Build Agents That Remember » (42 Paris, octobre 2026), qui évalue le projet en quelques minutes.
- Ensuite, chaque employé : il installe le client sur son poste avec un prompt à coller dans Claude Code, puis n'a plus rien à faire.

## Product Purpose

Le cerveau d'entreprise réunit ce que chaque employé apprend en travaillant avec ses agents IA. Screenpipe capte les sessions sur le poste, brain-sync les distille en connaissances (décisions, procédures, faits, tâches) et les envoie dans un cerveau unique, découpé en zones par métier. Les agents de chacun l'interrogent via un MCP, avec des accès par zone. Le dashboard montre le cerveau s'allumer en direct quand un agent va y chercher du contexte.

Réussite : un dirigeant comprend en une minute ce que fait le produit et ouvre la démo ; un employé l'installe sans aide.

## Positioning

Le contexte vient du travail réel avec l'IA, capté sur chaque poste par Screenpipe, et non d'une base de connaissances à remplir à la main. Le brut reste sur le PC, seul le distillé monte au cerveau.

## Operating Context

- Démo : entreprise fictive « Fournil » (6 comptes, 34 connaissances, 10 jours d'activité), connexion en un clic en mode démo (`/login`).
- Installation d'un poste : prompt généré par `/admin`, collé dans Claude Code, qui installe `brain.mjs`, Screenpipe, le MCP et les hooks.
- Onboarding de l'entreprise : interview guidée de 7 questions et lecture des liens fournis (`/onboarding`).

## Capabilities and Constraints

- Zones par défaut : Dev, Produit, Sales, Compta, Support, Direction.
- Accès par zone : un membre ne voit que ses zones ; une recherche sur une zone fermée ne renvoie rien.
- Propositions d'automatisation à partir des prompts répétitifs (empreinte, sans stocker le prompt brut).
- Passation de poste : contexte d'un poste repris par son remplaçant, l'employé peut supprimer ses items.
- Sans clé Claude, tout fonctionne avec des heuristiques locales.
- Prévu : skills de l'entreprise conservés dans le cerveau avec leurs scripts, publication réservée aux personnes autorisées, onglet Skills, attribution d'un skill à un cortex (zone) pour ne le donner qu'à qui a accès à ce contexte.
- Non décidé : prix, offre commerciale, hébergement géré.

## Brand Commitments

- Direction artistique fixée dans `DESIGN.md` : monochrome « bone », phosphore réservé à ce qui se passe en direct, billes et traits, Space Grotesk.
- Le cerveau 3D est l'image du produit.
- Ton : français, phrases simples, pas d'emoji, pas de point d'exclamation.

## Evidence on Hand

- La démo Fournil (`apps/web/scripts/demo-data.ts`), clairement fictive.
- Les captures du dashboard (`docs/captures/`).
- Aucun client, aucun chiffre d'usage, aucun témoignage : ne pas en inventer.

## Product Principles

- Le brut reste sur le poste ; seul le distillé monte.
- Rien à faire pour l'employé une fois installé.
- Chacun ne voit que ce qui le concerne.
- Montrer le cerveau au travail plutôt que le décrire.
