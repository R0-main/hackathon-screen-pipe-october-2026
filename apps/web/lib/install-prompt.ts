// Le « prompt magique » de NOS Brainer : l'employé le colle dans Claude Code, qui branche tout en UNE commande
// (`brain.mjs setup`), donc une seule autorisation à donner dans Claude Code. setup installe et lance Screenpipe, ouvre
// les bons Réglages macOS et reprend tout seul dès que les autorisations sont accordées, puis ouvre le cerveau déjà
// connecté. Aucun historique n'est envoyé : la synchro part de l'installation ; relire puis envoyer ses dernières 24 h
// reste une option proposée à la fin.
// La première phrase est reconnue par brain-sync (INSTALL_PROMPT_RE, apps/client/src/secrets.ts) : cette session contient
// le jeton en clair et n'est jamais envoyée au cerveau. Ne pas la reformuler sans mettre à jour le client.

export function buildInstallPrompt(opts: { baseUrl: string; token: string; name: string; orgName: string; zones: string[] }): string {
  const { baseUrl, token, name, orgName, zones } = opts
  const brain = "node ~/.company-brain/brain.mjs"
  return `Tu vas connecter ce poste à NOS Brainer, le cerveau d'entreprise de ${orgName}. Je suis ${name}.
Tout tient en une commande : lance-la telle quelle, en un seul appel (une seule autorisation à me demander), puis lis sa sortie. Sois bref.

Paramètres :
- URL du cerveau : ${baseUrl}
- Mon jeton personnel (secret : ne l'affiche jamais en entier, ne l'écris nulle part ailleurs que dans la commande) : ${token}
- Zones auxquelles j'ai accès : ${zones.join(", ") || "(aucune pour l'instant)"}
(Cette conversation contient mon jeton : brain-sync la reconnaît et ne l'envoie jamais au cerveau.)

1. Prérequis : Node.js ≥ 20 (\`node -v\`). S'il manque, propose-moi de l'installer (Mac : \`brew install node\`, sinon https://nodejs.org) et attends mon accord.

2. Préviens-moi en une phrase avant de lancer : sur Mac, les Réglages Système vont s'ouvrir et je devrai activer « screenpipe » dans
   « Enregistrement de l'écran », puis dans « Accessibilité » ; la commande attend et continue toute seule dès que c'est coché. Pas de micro.

3. Lance cette commande avec un délai de 10 minutes (elle attend mes autorisations) :
   curl -fsSL --create-dirs ${baseUrl}/brain.mjs -o ~/.company-brain/brain.mjs && ${brain} setup --url ${baseUrl} --token ${token}
   Elle installe et lance Screenpipe (capture locale de l'écran, micro coupé), enregistre ma config, branche le MCP company-brain et les
   hooks Claude Code, planifie la synchro toutes les 15 minutes (seulement l'activité à venir : aucun historique n'est envoyé), allume
   mon néon et ouvre le cerveau dans mon navigateur, déjà connecté. Si le bac à sable de Claude Code la bloque (elle écrit dans
   ~/.company-brain, ~/.claude et les tâches de fond du système), relance-la hors du bac à sable.

4. Lis la sortie :
   - code 0 : c'est fini ;
   - code 3 (« EN ATTENTE ») : l'autorisation d'enregistrer l'écran manque encore ; redis-moi où cliquer, puis relance \`${brain} setup\`
     (sans paramètres, la config est gardée) ;
   - autre erreur : explique-la simplement, corrige ce que tu peux sans droits administrateur (demande-moi avant sinon) et relance
     \`${brain} setup\`, qui reprend là où ça s'est arrêté. \`${brain} status\` donne l'état complet.

5. Termine en quatre lignes au plus : ce qui tourne, le lien du cerveau, ce qui part (des connaissances distillées, jamais l'écran brut ;
   secrets et données perso masqués sur le poste) et comment tout retirer (\`${brain} uninstall\`). Propose-moi enfin, si je veux que le
   cerveau apprenne aussi de mes dernières 24 h : \`${brain} sync --dry-run --full --since 24h\`, que tu me montres en entier ; rien ne part
   avant mon accord explicite, puis \`${brain} sync --confirm\` envoie exactement ce que j'ai relu.`
}
