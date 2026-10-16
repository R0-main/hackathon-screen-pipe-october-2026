// Le « prompt magique » : l'employé le colle dans Claude Code, qui installe et branche tout.
// Ordre voulu : init → hello → Screenpipe (jeton, parseur sémantique) → MCP / hooks → simulation relue et accord explicite → envoi
// → seulement alors la planification, puis le pipe Screenpipe (optionnel).
// La première phrase est reconnue par brain-sync (INSTALL_PROMPT_RE, apps/client/src/secrets.ts) : cette session contient
// le jeton en clair et n'est jamais envoyée au cerveau. Ne pas la reformuler sans mettre à jour le client.

export function buildInstallPrompt(opts: { baseUrl: string; token: string; name: string; orgName: string; zones: string[] }): string {
  const { baseUrl, token, name, orgName, zones } = opts
  const brain = "node ~/.company-brain/brain.mjs"
  return `Tu vas connecter ce poste au cerveau d'entreprise de ${orgName}. Je suis ${name}.
Fais chaque étape dans l'ordre, vérifie qu'elle a marché, et explique-moi brièvement ce que tu fais. Demande-moi avant toute action qui demande des droits administrateur.

Paramètres :
- URL du cerveau : ${baseUrl}
- Mon jeton personnel (secret, ne l'affiche pas en entier et ne l'écris nulle part ailleurs que dans le fichier de config) : ${token}
- Zones auxquelles j'ai accès : ${zones.join(", ") || "(aucune pour l'instant)"}
(Cette conversation contient mon jeton : brain-sync la reconnaît et ne l'envoie jamais au cerveau.)

1. Prérequis : vérifie que Node.js ≥ 20 est installé (\`node -v\`). Sinon, propose-moi de l'installer.

2. Client du cerveau :
   - crée le dossier \`~/.company-brain\` ;
   - télécharge \`${baseUrl}/brain.mjs\` dans \`~/.company-brain/brain.mjs\` ;
   - lance \`${brain} init --url ${baseUrl} --token <mon jeton>\` (écrit \`~/.company-brain/config.json\` en mode 600 et teste la connexion).

3. Test de connexion : \`${brain} hello\` → mon néon doit s'allumer sur ${baseUrl}.

4. Screenpipe (capture locale de l'écran, réunions comprises) :
   - vérifie s'il tourne : \`curl -s http://localhost:3030/health\` ;
   - sinon, installe-le en suivant la doc officielle (https://docs.screenpi.pe — application desktop, ou CLI : \`npx -y screenpipe@latest service install\`), lance-le et vérifie à nouveau \`/health\` ;
   - jeton d'API local (obligatoire pour lire les données) : affiche-le avec \`npx -y screenpipe@latest auth token\` (ou Settings → Privacy → API security dans l'app) et enregistre-le avec \`${brain} init --screenpipe-token <jeton>\` ;
   - lance \`${brain} status\` : la ligne Screenpipe doit dire « jeton OK ». Si elle dit « aucune donnée parsed », active le contexte sémantique
     (app : Settings → Recording → app context « memory » ; CLI : relance l'enregistrement avec \`--enable-semantic-context\`), utilise ChatGPT ou Claude quelques minutes, puis revérifie.
   Rien de brut ne quitte le poste : brain-sync lit Screenpipe (sessions IA, réunions transcrites, masquage natif des données personnelles) et mes sessions Claude Code en local,
   filtre (liste blanche d'apps, secrets et données perso masqués) et n'envoie que des connaissances distillées. Si je ne veux pas que mes réunions soient distillées : \`${brain} init --screenpipe-meetings non\`.

5. MCP company-brain (pour que mes agents interrogent le cerveau) :
   \`claude mcp add company-brain --scope user -- ${brain} mcp\`

6. Hooks Claude Code (pour que le cerveau s'allume quand je travaille) : lance \`${brain} install-hooks\`,
   qui ajoute les hooks SessionStart, UserPromptSubmit et Stop dans \`~/.claude/settings.json\` sans toucher aux autres réglages.
   Montre-moi le diff du fichier. Précise-moi que le hook n'envoie un court résumé masqué d'un prompt que s'il concerne une de mes zones
   et n'a rien de personnel, et que \`${brain} init --share-prompt-summaries non\` supprime tout résumé.

7. Aperçu avant tout envoi (rien n'est encore parti) :
   - lance \`${brain} sync --dry-run --full --since 24h\` : c'est une simulation, rien n'est envoyé ;
   - montre-moi tout ce qui serait envoyé, tel quel : chaque connaissance en entier et les workflows Screenpipe s'il y en a, sans résumer ni trier ;
   - demande-moi explicitement si j'accepte cet envoi et attends ma réponse.
   Si je refuse ou hésite : n'envoie rien et ne planifie rien ; propose-moi d'ajuster (sources, liste blanche d'apps) ou de tout désinstaller.

8. Seulement si j'ai dit oui : \`${brain} sync --confirm\` → envoie exactement ce que je viens de relire, rien d'autre.

9. Ensuite seulement, synchronisation automatique toutes les 15 minutes : lance \`${brain} install-schedule\`
   (launchd sur macOS, crontab sur Linux, tâche planifiée sur Windows). Elle part de maintenant : seule l'activité à venir sera envoyée,
   jamais l'historique que je n'ai pas relu. Si ça échoue, propose-moi la commande à ajouter à la main.

10. Si l'application Screenpipe est installée (pas seulement le CLI) : \`${brain} install-pipe\` écrit le pipe « brain-sync » dans
   \`~/.screenpipe/pipes/brain-sync/pipe.md\` ; active-le avec \`npx -y screenpipe@latest pipe enable brain-sync\` et teste-le avec
   \`npx -y screenpipe@latest pipe run brain-sync\`. La synchro apparaît alors dans les tâches planifiées de Screenpipe et se relance à la fin
   de chaque réunion ; la planification de l'étape 9 reste en secours.

11. Termine par un récapitulatif : ce qui est installé, où sont les fichiers, comment revoir à tout moment ce qui partirait
   (\`${brain} sync --dry-run --full\`) et comment tout désinstaller (\`${brain} uninstall\`).`
}
