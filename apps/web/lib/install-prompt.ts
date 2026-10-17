// Le « prompt magique » de NOS Brainer : l'employé le colle dans Claude Code, qui lance UNE commande (celle de son
// système), lit son code de sortie et dépanne avec `brain doctor` si besoin. Tout le travail est dans notre CLI
// (docs/CLI.md) : `install.sh` (macOS, Linux, Git Bash) ou `install.ps1` (Windows) trouve ou installe Node.js, télécharge
// `brain.mjs` et lance `brain setup`, qui installe Screenpipe, ouvre les bons Réglages macOS, branche le MCP et les hooks,
// planifie la synchro et ouvre le cerveau déjà connecté. Aucun historique n'est envoyé : la synchro part de
// l'installation ; relire puis envoyer ses dernières 24 h reste une option proposée à la fin.
// La première phrase est reconnue par brain-sync (INSTALL_PROMPT_RE, apps/client/src/secrets.ts) : cette session contient
// le jeton en clair et n'est jamais envoyée au cerveau. Ne pas la reformuler sans mettre à jour le client.

/** Le raccourci écrit par install.sh : marche même quand Node.js est une copie privée hors du PATH. */
export const BRAIN_CLI = "~/.company-brain/brain"
/** Sous Windows (PowerShell comme Git Bash) : le raccourci écrit par install.ps1. */
export const BRAIN_CLI_WINDOWS = "~/.company-brain/brain.cmd"

/** La commande unique de chaque système (le jeton n'apparaît que là). */
export function installCommands(baseUrl: string, token: string): { posix: string; windows: string } {
  const dir = '"$env:USERPROFILE\\.company-brain'
  return {
    posix: `curl -fsSL --create-dirs ${baseUrl}/install.sh -o ~/.company-brain/install.sh && sh ~/.company-brain/install.sh --url ${baseUrl} --token ${token}`,
    windows:
      `New-Item -ItemType Directory -Force ${dir}" | Out-Null; Invoke-WebRequest -UseBasicParsing ${baseUrl}/install.ps1 -OutFile ${dir}\\install.ps1"; ` +
      `powershell -NoProfile -ExecutionPolicy Bypass -File ${dir}\\install.ps1" --url ${baseUrl} --token ${token}`,
  }
}

export function buildInstallPrompt(opts: { baseUrl: string; token: string; name: string; orgName: string; zones: string[] }): string {
  const { baseUrl, token, name, orgName, zones } = opts
  const brain = BRAIN_CLI
  const cmd = installCommands(baseUrl, token)
  return `Tu vas connecter ce poste à NOS Brainer, le cerveau d'entreprise de ${orgName}. Je suis ${name}, zones : ${zones.join(", ") || "aucune pour l'instant"}.
Ce message contient mon jeton personnel : ne l'affiche jamais en entier (brain-sync reconnaît cette conversation et ne l'envoie jamais au cerveau). Sois bref.

1. Préviens-moi en une phrase : sur Mac, les Réglages Système vont s'ouvrir et je devrai activer « screenpipe » dans « Enregistrement de l'écran » puis dans « Accessibilité » ; la commande attend et reprend toute seule.
2. Lance la commande de mon système telle quelle, en un seul appel, avec un délai de 10 minutes (hors du bac à sable si elle y est bloquée) :
   macOS, Linux, Git Bash : ${cmd.posix}
   Windows, PowerShell : ${cmd.windows}
3. Code 0 : c'est fini, le cerveau s'est ouvert dans mon navigateur. Code 3 (« EN ATTENTE ») : redis-moi où cocher, puis relance \`${brain} setup\`. Code 5 : réseau ou adresse, relance la même commande. Autre code (6 : branché sans Screenpipe) : lance \`${brain} doctor --json\`, explique simplement chaque point KO et lance les corrections marquées « safe ». Sous Windows, le client est \`${BRAIN_CLI_WINDOWS}\`.
4. Termine en trois lignes : ce qui tourne, ce qui part (des connaissances distillées, jamais l'écran brut ; aucun historique n'est envoyé) et comment tout retirer (\`${brain} uninstall\`). Propose enfin de faire apprendre au cerveau mes dernières 24 h : montre-moi d'abord \`${brain} sync --dry-run --full --since 24h\` en entier ; rien ne part avant mon accord explicite, puis \`${brain} sync --confirm\` envoie exactement ce que j'ai relu.`
}
