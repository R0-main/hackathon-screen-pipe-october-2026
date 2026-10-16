# Cerveau d'entreprise — le « brain » numérique de ta boîte

> Hackathon Screenpipe — « Build Agents That Remember », 42 Paris, octobre 2026

## Le pitch

Chaque employé utilise déjà l'IA (Claude Code, Codex, ChatGPT…), mais tout ce contexte reste enfermé dans des sessions individuelles et se perd.
On branche **Screenpipe** sur le poste de chaque utilisateur pour capter ces sessions, et on les fait converger vers **un cerveau unique de l'entreprise** : toute sa connaissance, visualisée sur un dashboard, avec des accès par équipe.

Screenpipe devient le **pipe** entre le PC de l'utilisateur, ses agents IA et le cerveau de l'entreprise.

## Comment ça marche

### 1. Onboarding de l'entreprise (première création du cerveau)
- **Interview de 5-10 min** pour présenter l'entreprise : activité, équipes, objectifs, liens utiles.
- **Scraping** des liens fournis (site, docs, etc.).
- **Connecteurs** : Notion, Calendar, et toutes les sources de données possibles.
- Résultat : une première version du cerveau, avant même que quelqu'un ait utilisé l'outil.

### 2. Onboarding de chaque utilisateur
- On fournit **un prompt à coller dans Claude Code** qui installe Screenpipe et configure tout (connexion au cerveau, MCP, permissions).
- Ensuite, rien à faire : **en utilisant simplement Claude / Codex au quotidien**, l'utilisateur alimente le cerveau.

### 3. Le dashboard
- **Un gros cerveau visuel** : chaque zone = un domaine de connaissance de l'entreprise (dev, compta, sales, produit…).
- **Agents en direct** : quand un agent démarre et va chercher du contexte, la zone concernée **s'allume comme un néon**.
- **Gestion des comptes et des accès** : l'admin crée les comptes et choisit quelles zones chaque personne peut voir (ex. la compta n'a pas besoin du contexte code).
- **État de l'entreprise** : résumé de où en est la boîte — tâches, objectifs, prochaines étapes, et **qui a fait quoi**.
- **To-do** : brancher l'outil de to-do existant (Todoist, Notion, Linear…) ou en proposer une intégrée au dashboard.

### 4. Propositions d'automatisation
On détecte les tâches répétitives à partir de l'activité enregistrée et on les propose aux dirigeants.
> Ex. : tous les jours à 9h, Jean-Marc de la compta lance le même prompt → on propose une automatisation qui le fait à sa place, et il récupère son début de journée.

### 5. Passation de poste / remplacement
Quand quelqu'un part ou s'absente, son remplaçant récupère **le contexte que ce poste utilisait le plus** (pas forcément toutes les conversations, voir la partie légale).

## Points à trancher

- **Légal / RGPD** : consentement des salariés, filtrage des contenus perso, ce qui remonte au cerveau ou non (texte distillé plutôt que les captures brutes ?), droit de regard de l'employé.
- **Volume de données** : Screenpipe produit environ 19 Go en 2 semaines par poste. Le cerveau doit **distiller** (faits, décisions, entités, liens) et garder ça de façon persistante, pas stocker le brut.
- **Structure du cerveau** : graphe de connaissance (personnes, projets, décisions, documents) ? Et comment découpe-t-on les zones ?
- **Local vs cloud** : Screenpipe est local par défaut. Qu'est-ce qui part vers le cerveau partagé, et quand (en continu, toutes les heures) ?

## Ce qu'on montre au hackathon (proposition de MVP)

1. Le prompt d'installation qui configure Screenpipe et le connecte au cerveau.
2. Un pipe qui extrait les sessions IA (Claude Code…) et les distille dans le cerveau.
3. Le dashboard : le cerveau avec ses zones, les néons quand un agent travaille, et le résumé de l'état de l'entreprise.
4. Une suggestion d'automatisation détectée à partir de l'activité réelle.
