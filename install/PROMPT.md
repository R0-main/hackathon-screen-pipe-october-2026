# Le « prompt magique » d'installation

Généré par le dashboard (`/admin` → « Inviter quelqu'un » ou « Nouveau prompt ») pour chaque employé, avec son jeton personnel (affiché une seule fois) et l'URL du cerveau. Source : [apps/web/lib/install-prompt.ts](../apps/web/lib/install-prompt.ts).

L'employé le colle dans Claude Code, qui fait l'installation en expliquant chaque étape. Toutes les commandes appelées existent dans le client `brain.mjs` (`apps/client`). L'ordre compte : rien n'est envoyé avant que l'employé ait relu la simulation complète (`sync --dry-run --full`) et dit oui ; `sync --confirm` envoie alors exactement ce qui a été montré, et la synchro planifiée n'est installée qu'ensuite (elle part de ce moment-là).

Exemple (jeton fictif) :

```text
Tu vas connecter ce poste au cerveau d'entreprise de Fournil. Je suis Jean-Marc Dubois.
Fais chaque étape dans l'ordre, vérifie qu'elle a marché, et explique-moi brièvement ce que tu fais. Demande-moi avant toute action qui demande des droits administrateur.

Paramètres :
- URL du cerveau : https://cerveau.example.com
- Mon jeton personnel (secret, ne l'affiche pas en entier et ne l'écris nulle part ailleurs que dans le fichier de config) : cb_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
- Zones auxquelles j'ai accès : compta
(Cette conversation contient mon jeton : brain-sync la reconnaît et ne l'envoie jamais au cerveau.)

1. Prérequis : vérifie que Node.js ≥ 20 est installé (`node -v`). Sinon, propose-moi de l'installer.

2. Client du cerveau :
   - crée le dossier `~/.company-brain` ;
   - télécharge `https://cerveau.example.com/brain.mjs` dans `~/.company-brain/brain.mjs` ;
   - lance `node ~/.company-brain/brain.mjs init --url https://cerveau.example.com --token <mon jeton>` (écrit `~/.company-brain/config.json` en mode 600 et teste la connexion).

3. Test de connexion : `node ~/.company-brain/brain.mjs hello` → mon néon doit s'allumer sur https://cerveau.example.com.

4. Screenpipe (capture locale de l'écran, réunions comprises) :
   - vérifie s'il tourne : `curl -s http://localhost:3030/health` ;
   - sinon, installe-le en suivant la doc officielle (https://docs.screenpi.pe — application desktop, ou CLI : `npx -y screenpipe@latest service install`), lance-le et vérifie à nouveau `/health` ;
   - jeton d'API local (obligatoire pour lire les données) : affiche-le avec `npx -y screenpipe@latest auth token` (ou Settings → Privacy → API security dans l'app) et enregistre-le avec `node ~/.company-brain/brain.mjs init --screenpipe-token <jeton>` ;
   - lance `node ~/.company-brain/brain.mjs status` : la ligne Screenpipe doit dire « jeton OK ». Si elle dit « aucune donnée parsed », active le contexte sémantique
     (app : Settings → Recording → app context « memory » ; CLI : relance l'enregistrement avec `--enable-semantic-context`), utilise ChatGPT ou Claude quelques minutes, puis revérifie.
   Rien de brut ne quitte le poste : brain-sync lit Screenpipe (sessions IA, réunions transcrites, masquage natif des données personnelles) et mes sessions Claude Code en local,
   filtre (liste blanche d'apps, secrets et données perso masqués) et n'envoie que des connaissances distillées. Si je ne veux pas que mes réunions soient distillées : `node ~/.company-brain/brain.mjs init --screenpipe-meetings non`.

5. MCP company-brain (pour que mes agents interrogent le cerveau) :
   `claude mcp add company-brain --scope user -- node ~/.company-brain/brain.mjs mcp`

6. Hooks Claude Code (pour que le cerveau s'allume quand je travaille) : lance `node ~/.company-brain/brain.mjs install-hooks`,
   qui ajoute les hooks SessionStart, UserPromptSubmit et Stop dans `~/.claude/settings.json` sans toucher aux autres réglages.
   Montre-moi le diff du fichier. Précise-moi que le hook n'envoie un court résumé masqué d'un prompt que s'il concerne une de mes zones
   et n'a rien de personnel, et que `node ~/.company-brain/brain.mjs init --share-prompt-summaries non` supprime tout résumé.

7. Aperçu avant tout envoi (rien n'est encore parti) :
   - lance `node ~/.company-brain/brain.mjs sync --dry-run --full --since 24h` : c'est une simulation, rien n'est envoyé ;
   - montre-moi tout ce qui serait envoyé, tel quel : chaque connaissance en entier et les workflows Screenpipe s'il y en a, sans résumer ni trier ;
   - demande-moi explicitement si j'accepte cet envoi et attends ma réponse.
   Si je refuse ou hésite : n'envoie rien et ne planifie rien ; propose-moi d'ajuster (sources, liste blanche d'apps) ou de tout désinstaller.

8. Seulement si j'ai dit oui : `node ~/.company-brain/brain.mjs sync --confirm` → envoie exactement ce que je viens de relire, rien d'autre.

9. Ensuite seulement, synchronisation automatique toutes les 15 minutes : lance `node ~/.company-brain/brain.mjs install-schedule`
   (launchd sur macOS, crontab sur Linux, tâche planifiée sur Windows). Elle part de maintenant : seule l'activité à venir sera envoyée,
   jamais l'historique que je n'ai pas relu. Si ça échoue, propose-moi la commande à ajouter à la main.

10. Si l'application Screenpipe est installée (pas seulement le CLI) : `node ~/.company-brain/brain.mjs install-pipe` écrit le pipe « brain-sync » dans
   `~/.screenpipe/pipes/brain-sync/pipe.md` ; active-le avec `npx -y screenpipe@latest pipe enable brain-sync` et teste-le avec
   `npx -y screenpipe@latest pipe run brain-sync`. La synchro apparaît alors dans les tâches planifiées de Screenpipe et se relance à la fin
   de chaque réunion ; la planification de l'étape 9 reste en secours.

11. Termine par un récapitulatif : ce qui est installé, où sont les fichiers, comment revoir à tout moment ce qui partirait
   (`node ~/.company-brain/brain.mjs sync --dry-run --full`) et comment tout désinstaller (`node ~/.company-brain/brain.mjs uninstall`).
```
