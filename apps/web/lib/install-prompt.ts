// Le « prompt magique » de NOS Brainer : l'employé le colle dans Claude Code, qui lance UNE commande, lit son code de
// sortie et dépanne si besoin. Tout le travail est dans notre CLI (docs/CLI.md) : `install.sh` trouve ou installe Node.js,
// télécharge `brain.mjs` et lance `brain setup`, qui installe Screenpipe, ouvre les bons Réglages macOS, branche le MCP et
// les hooks, planifie la synchro et ouvre le cerveau déjà connecté. Aucun historique n'est envoyé : la synchro part de
// l'installation ; relire puis envoyer ses dernières 24 h reste une option proposée à la fin.
// La première phrase est reconnue par brain-sync (INSTALL_PROMPT_RE, apps/client/src/secrets.ts) : cette session contient
// le jeton en clair et n'est jamais envoyée au cerveau. Ne pas la reformuler sans mettre à jour le client.

/** Le raccourci écrit par install.sh : marche même quand Node.js est une copie privée hors du PATH. */
export const BRAIN_CLI = "~/.company-brain/brain"

/** « de Fournil », « d'Atelier Lumen » : l'élision devant une voyelle ou un h. */
export function deNom(name: string): string {
  return /^[aeiouyhàâäéèêëîïôöùûüœæ]/i.test(name.trim()) ? `d'${name.trim()}` : `de ${name.trim()}`
}

export function buildInstallPrompt(opts: { baseUrl: string; token: string; name: string; orgName: string; zones: string[] }): string {
  const { baseUrl, token, name, orgName, zones } = opts
  const brain = BRAIN_CLI
  return `Tu vas connecter ce poste à NOS Brainer, le cerveau d'entreprise ${deNom(orgName)}. Je suis ${name}, zones : ${zones.join(", ") || "aucune pour l'instant"}.
Ce message contient mon jeton personnel : ne l'affiche jamais en entier (brain-sync reconnaît cette conversation et ne l'envoie jamais au cerveau). Sois bref.

1. Préviens-moi en une phrase : sur Mac, les Réglages Système vont s'ouvrir et je devrai activer « screenpipe » dans « Enregistrement de l'écran » puis dans « Accessibilité » ; la commande attend et reprend toute seule.
2. Lance cette commande telle quelle, en un seul appel, avec un délai de 10 minutes (hors du bac à sable si elle y est bloquée) :
   curl -fsSL --create-dirs ${baseUrl}/install.sh -o ~/.company-brain/install.sh && sh ~/.company-brain/install.sh --url ${baseUrl} --token ${token}
3. Code 0 : c'est fini, le cerveau s'est ouvert dans mon navigateur. Code 3 (« EN ATTENTE ») : redis-moi où cocher, puis relance \`${brain} setup\`. Autre erreur : explique-la simplement et relance \`${brain} setup\`, qui reprend où il s'était arrêté (\`${brain} status\` donne l'état).
4. Termine en trois lignes : ce qui tourne, ce qui part (des connaissances distillées, jamais l'écran brut ; aucun historique n'est envoyé) et comment tout retirer (\`${brain} uninstall\`). Propose enfin de faire apprendre au cerveau mes dernières 24 h : montre-moi d'abord \`${brain} sync --dry-run --full --since 24h\` en entier ; rien ne part avant mon accord explicite, puis \`${brain} sync --confirm\` envoie exactement ce que j'ai relu.`
}
