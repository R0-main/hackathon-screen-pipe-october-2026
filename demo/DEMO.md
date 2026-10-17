# Script de démo (5 minutes)

Entreprise fictive : **Fournil**, logiciel de caisse et de précommandes pour boulangeries artisanales (6 personnes).

## Avant de monter sur scène

```bash
npm run seed -- --force          # repart d'un cerveau propre (jetons affichés dans le terminal)
BRAIN_DEMO=1 npm run dev         # ou l'URL déployée
npm run simulate -- --speed 1.5  # 2e terminal, à lancer au moment voulu (Ctrl-C pour arrêter)
```

Onglets à préparer : le dashboard (`/dashboard`, entrée par `/demo`) connecté en **Claire (CEO, admin)**, `/admin`, et un terminal avec Claude Code sur un vrai projet si un poste est branché.

Version en ligne : https://cerveau-entreprise.vercel.app (mode démo, données fictives, amorcées automatiquement sur une base vide).

## Déroulé

1. **Le problème (30 s).** « Chez Fournil, tout le monde bosse avec Claude Code ou ChatGPT. Mais quand Hugo trouve comment déployer, ou que Jean-Marc met au point son rapprochement bancaire, ce savoir reste dans leur session. »

2. **Le cerveau (45 s).** Le dashboard : chaque zone (Dev, Produit, Sales, Compta, Support, Direction) est un domaine de connaissance, les points sont les clients/outils/projets les plus cités, les synapses relient les zones qui partagent des entités. Lancer `npm run simulate` : les zones s'allument au fil des sessions et des requêtes MCP, le flux « Agents en direct » défile.

3. **Comment ça arrive là (45 s).** Montrer `/admin` → « Inviter quelqu'un » → le **prompt magique** : on le colle dans Claude Code, il installe Screenpipe, brain-sync, le MCP et les hooks. « Le brut reste sur le PC : brain-sync filtre, masque les secrets et n'envoie que des connaissances distillées. »
   *Si un poste est branché :* `node ~/.company-brain/brain.mjs hello` → son néon s'allume en direct ; une question dans Claude Code allume la zone concernée.

4. **Les accès par zone (60 s).** Dans la barre du haut : « Voir en tant que : Jean-Marc Dubois ». Le cerveau se verrouille sauf la Compta. Demander « comment déployer en production ? » → rien, et le bandeau indique que la zone Dev pourrait en savoir plus mais lui est fermée. Demander « rapprochement Qonto » → la procédure, et seule la zone Compta s'allume. Revenir en admin.

5. **Où en est la boîte (45 s).** Objectifs, avancement, prochaines étapes et qui a fait quoi, par zone. Pour une version rédigée par Claude avec ton abonnement : lancer avant la démo `node ~/.company-brain/brain.mjs refresh-status` sur le poste admin (le bouton « Rafraîchir l'état » recalcule la version heuristique côté serveur). Montrer aussi « Voir en tant que : Jean-Marc » : Jean-Marc ne reçoit que la compta, avec un titre calculé sur sa zone.

6. **L'automatisation (45 s).** La carte verte : « Jean-Marc lance ce prompt presque chaque jour vers 9h07 (6 jours sur 6) → l'exécuter automatiquement à 9h02 ». Détectée à partir des empreintes de prompts envoyées par les hooks, sans stocker le texte brut. « Mettre en place ».

7. **Les skills (30 s).** Onglet « Skills » : les savoir-faire de Fournil prêts pour Claude Code, avec leurs scripts (`deployer-fournil` et son `release.sh`). « Voir en tant que : Jean-Marc » : il ne reçoit que le skill de toute l'entreprise et ceux du cortex Compta, et son poste les installe tout seul. Dans `/admin`, la colonne « Publie des skills » : pousser un skill demande une autorisation.

8. **La passation (30 s).** `/admin` → « Passation » sur Hugo : ses zones, ses outils, ses prompts récurrents et ses connaissances. « Le jour où Hugo part en congé, la personne qui remplace Hugo récupère ça. »

## Phrases clés

- « Screenpipe est le pipe entre le PC, ses agents IA et le cerveau de l'entreprise. »
- « Quelques Ko distillés par jour au lieu de 19 Go de captures. »
- « La compta n'a pas besoin du contexte code, et ses agents non plus. »

## Si quelque chose lâche

- Pas de réseau / pas de poste branché : `npm run simulate` suffit pour toute la démo.
- Capture lente : `node ~/.company-brain/brain.mjs sync --since 2h` force la synchro (source de secours : les logs Claude Code locaux).
- Données abîmées : `npm run seed -- --force`.
