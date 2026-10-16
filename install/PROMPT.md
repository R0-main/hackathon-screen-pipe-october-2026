# Le « prompt magique » d'installation

Généré par le dashboard (`/admin` → « Inviter quelqu'un » ou « Nouveau prompt ») pour chaque employé, avec son jeton personnel (affiché une seule fois) et l'URL du cerveau. Source : [apps/web/lib/install-prompt.ts](../apps/web/lib/install-prompt.ts).

L'employé le colle dans Claude Code, qui fait l'installation en expliquant chaque étape. Toutes les commandes appelées existent dans le client `brain.mjs` (`apps/client`).

Exemple (jeton fictif) :

```text
Tu vas connecter ce poste au cerveau d'entreprise de Fournil. Je suis Jean-Marc Dubois.
Fais chaque étape, vérifie qu'elle a marché, et explique-moi brièvement ce que tu fais. Demande-moi avant toute action qui demande des droits administrateur.

Paramètres :
- URL du cerveau : https://cerveau.example.com
- Mon jeton personnel (secret, ne l'affiche pas en entier et ne l'écris nulle part ailleurs que dans le fichier de config) : cb_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
- Zones auxquelles j'ai accès : compta

1. Prérequis : vérifie que Node.js ≥ 20 est installé (`node -v`). Sinon, propose-moi de l'installer.

2. Client du cerveau :
   - crée le dossier `~/.company-brain` ;
   - télécharge `https://cerveau.example.com/brain.mjs` dans `~/.company-brain/brain.mjs` ;
   - lance `node ~/.company-brain/brain.mjs init --url https://cerveau.example.com --token <mon jeton>` (écrit `~/.company-brain/config.json` en mode 600 et teste la connexion).

3. Screenpipe (capture locale de l'écran) :
   - vérifie s'il tourne : `curl -s http://localhost:3030/health` ;
   - sinon, installe-le en suivant la doc officielle (https://docs.screenpi.pe — application desktop ou CLI), lance-le et vérifie à nouveau `/health` ;
   - s'il demande un jeton d'API local, ajoute-le avec `node ~/.company-brain/brain.mjs init --screenpipe-token <jeton>`.
   Rien de brut ne quitte le poste : brain-sync lit Screenpipe et mes sessions Claude Code en local, filtre (liste blanche d'apps, secrets et données perso masqués) et n'envoie que des connaissances distillées.

4. MCP company-brain (pour que mes agents interrogent le cerveau) :
   `claude mcp add company-brain --scope user -- node ~/.company-brain/brain.mjs mcp`

5. Hooks Claude Code (pour que le cerveau s'allume quand je travaille) : lance `node ~/.company-brain/brain.mjs install-hooks`,
   qui ajoute les hooks SessionStart, UserPromptSubmit et Stop dans `~/.claude/settings.json` sans toucher aux autres réglages.
   Montre-moi le diff du fichier.

6. Synchronisation automatique toutes les 15 minutes : lance `node ~/.company-brain/brain.mjs install-schedule`
   (launchd sur macOS, crontab sur Linux, tâche planifiée sur Windows). Si ça échoue, propose-moi la commande à ajouter à la main.

7. Test de bout en bout :
   - `node ~/.company-brain/brain.mjs hello` → mon néon doit s'allumer sur https://cerveau.example.com ;
   - `node ~/.company-brain/brain.mjs sync --dry-run --since 24h` → montre-moi ce qui serait envoyé, sans rien envoyer ;
   - si ça me convient, `node ~/.company-brain/brain.mjs sync --since 24h`.

8. Termine par un récapitulatif : ce qui est installé, où sont les fichiers, et comment tout désinstaller
   (`node ~/.company-brain/brain.mjs uninstall`).
```

