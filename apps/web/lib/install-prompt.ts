// Le « prompt magique » de NOS Brainer : l'employé le colle dans Claude Code, qui lance UNE commande, lit son code de
// sortie et dépanne si besoin. Tout le travail est dans notre CLI (docs/CLI.md) : `install.sh` trouve ou installe Node.js,
// télécharge `brain.mjs` et lance `brain setup`, qui installe Screenpipe, ouvre les bons Réglages macOS, branche le MCP et
// les hooks, planifie la synchro et ouvre le cerveau déjà connecté. Aucun historique n'est envoyé : la synchro part de
// l'installation ; relire puis envoyer ses dernières 24 h reste une option proposée à la fin.
// La première phrase est reconnue par brain-sync (INSTALL_PROMPT_RE, apps/client/src/secrets.ts) : cette session contient
// le jeton en clair et n'est jamais envoyée au cerveau. Ne pas la reformuler sans mettre à jour le client.

/**
 * Nos prompts n'ont de sens que sur le poste de la personne (installer le client, lire son historique). Une session
 * Claude Code dans le cloud (app de bureau en environnement distant) s'arrête au lieu d'installer dans un conteneur.
 */
export const LOCAL_ONLY = "Si tu ne tournes pas sur mon poste (session cloud, conteneur distant), arrête-toi et dis-moi de recoller ce message dans Claude Code ou Codex en local (terminal `claude` ou `codex`)."

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
Ce message contient mon jeton personnel : ne l'affiche jamais en entier (brain-sync reconnaît cette conversation et ne l'envoie jamais au cerveau). Sois bref. ${LOCAL_ONLY}

1. Préviens-moi en une phrase : sur Mac, les Réglages Système vont s'ouvrir et je devrai activer « screenpipe » dans « Enregistrement de l'écran » puis dans « Accessibilité » ; la commande attend et reprend toute seule.
2. Lance cette commande telle quelle, en un seul appel, avec un délai de 10 minutes (hors du bac à sable si elle y est bloquée) :
   curl -fsSL --create-dirs ${baseUrl}/install.sh -o ~/.company-brain/install.sh && sh ~/.company-brain/install.sh --url ${baseUrl} --token ${token}
3. Code 0 : c'est fini, le cerveau s'est ouvert dans mon navigateur. Code 3 (« EN ATTENTE ») : redis-moi où cocher, puis relance \`${brain} setup\`. Autre erreur : explique-la simplement et relance \`${brain} setup\`, qui reprend où il s'était arrêté (\`${brain} status\` donne l'état).
4. Termine en trois lignes : ce qui tourne, ce qui part (des connaissances distillées, jamais l'écran brut ; aucun historique n'est envoyé) et comment tout retirer (\`${brain} uninstall\`). Propose enfin de faire apprendre au cerveau mes dernières 24 h : montre-moi d'abord \`${brain} sync --dry-run --full --since 24h\` en entier ; rien ne part avant mon accord explicite, puis \`${brain} sync --confirm\` envoie exactement ce que j'ai relu.`
}

// Le message d'équipe : le même pour toute l'entreprise, à envoyer à ses collègues (jamais publiquement). Il ne donne
// accès à rien : la commande crée une demande, préremplie par le Claude du demandeur, qu'un admin accepte ou refuse.
// Le jeton est généré sur le poste et seule son empreinte part avec la demande ; une fois acceptée, `brain join`
// enchaîne sur `setup`. Première phrase reconnue par brain-sync (INSTALL_PROMPT_RE) : ne pas la reformuler seule.

/** Codes de sortie de `brain join` (apps/client/src/join.ts). */
export const JOIN_EXIT = { pending: 5, rejected: 6 } as const

export function buildJoinPrompt(opts: { baseUrl: string; code: string; orgName: string }): string {
  const { baseUrl, code, orgName } = opts
  const org = deNom(orgName)
  const brain = BRAIN_CLI
  return `Tu vas demander à rejoindre NOS Brainer, le cerveau d'entreprise ${org}. Ce message d'équipe contient le code d'accès ${org} : ne l'affiche jamais en entier et ne le transmets pas hors de l'entreprise (brain-sync reconnaît cette conversation et ne l'envoie jamais au cerveau). Sois bref. ${LOCAL_ONLY}

1. Sans me poser de question, prépare ma demande avec ce que tu sais déjà de moi : prénom et nom (\`git config user.name\`, nom du compte de la machine), poste ou métier (ta mémoire, CLAUDE.md, nos échanges), email pro (\`git config user.email\`). N'invente rien : une valeur que tu n'as pas, retire son option, un admin la complétera.
2. Préviens-moi en une phrase : un admin ${org} doit accepter ma demande ; la commande l'attend, puis installe tout (sur Mac, il faudra activer « screenpipe » dans « Enregistrement de l'écran » puis dans « Accessibilité »).
3. Lance cette commande en un seul appel, avec un délai de 10 minutes (hors du bac à sable si elle y est bloquée), en remplaçant les valeurs entre chevrons :
   curl -fsSL --create-dirs ${baseUrl}/install.sh -o ~/.company-brain/install.sh && sh ~/.company-brain/install.sh --url ${baseUrl} --join ${code} --name "<prénom nom>" --title "<poste>" --email "<email>"
4. Code 0 : demande acceptée et poste branché, le cerveau s'est ouvert dans mon navigateur. Code ${JOIN_EXIT.pending} (« EN ATTENTE D'ACCEPTATION ») : dis-moi que ma demande attend un admin et propose de relancer \`${brain} join\`, qui reprend la même demande. Code ${JOIN_EXIT.rejected} : la demande a été refusée. Code 3 : redis-moi où cocher, puis relance \`${brain} setup\`. Autre erreur : explique-la simplement et relance \`${brain} join\`.
5. Termine en trois lignes : ce qui tourne, ce qui part (des connaissances distillées, jamais l'écran brut ; aucun historique n'est envoyé) et comment tout retirer (\`${brain} uninstall\`).`
}
