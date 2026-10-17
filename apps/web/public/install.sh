#!/bin/sh
# NOS Brainer : branche ce poste au cerveau d'entreprise en une commande.
#
#   sh install.sh --url https://cerveau.example.com --token cb_…
#
# 1. Node.js : la copie privée ~/.company-brain/node si elle est à la version figée ci-dessous ; sinon un Node.js ≥ 20
#    installé à demeure sur le système ; sinon installe la copie privée (macOS, Linux), sans droits administrateur, en
#    vérifiant l'empreinte SHA-256 officielle de l'archive.
# 2. Télécharge le client du cerveau (<url>/brain.mjs), vérifie que c'est bien du JavaScript, puis écrit le raccourci
#    ~/.company-brain/brain.
# 3. Lance `brain setup` avec les mêmes options : Screenpipe, autorisations macOS, MCP, hooks, synchro, néon.
# Sous Windows (Git Bash), passe la main à <url>/install.ps1, qui fait la même chose avec le même contrat.
#
# Codes de sortie (les mêmes pour install.ps1) :
#   0, 1, 3, 6… ceux de `brain setup`, rendus tels quels : 0 = tout est branché ; 1 = setup a échoué (lancer
#               `~/.company-brain/brain doctor`) ; 3 = autorisation macOS en attente (relancer `~/.company-brain/brain
#               setup` une fois cochée) ; 6 = branché, mais sans Screenpipe.
#   2           mauvais appel : --url absent ou pas en http(s), ou lancé avec sudo.
#   4           système non géré, ou Node.js impossible à installer ou à lancer ici (le message dit quoi installer).
#   5           téléchargement impossible (réseau, proxy, mauvaise adresse, page d'erreur au lieu du client) : relancer
#               la même commande. Le client et Node.js déjà installés restent intacts.
# Le jeton n'est jamais affiché. Pourquoi un script et un CLI plutôt que des instructions à Claude : docs/CLI.md.
# Tests seulement : COMPANY_BRAIN_FORCE_PRIVATE_NODE=1 ignore le Node.js du système (la CI teste le téléchargement).

set -eu

NODE_VERSION="22.23.3"

say() { printf '%s\n' "$*"; }
warn() { printf '%s\n' "$*" >&2; }
fail() {
  code="$1"
  shift
  printf '%s\n' "$*" >&2
  exit "$code"
}

# Fichiers temporaires suffixés par le PID (deux installations simultanées ne se marchent pas dessus), effacés en sortie.
new_mjs=""
new_ps1=""
shortcut_tmp=""
work=""
node_old=""
cleanup() {
  [ -z "$new_mjs" ] || rm -f "$new_mjs"
  [ -z "$new_ps1" ] || rm -f "$new_ps1"
  [ -z "$shortcut_tmp" ] || rm -f "$shortcut_tmp"
  [ -z "$work" ] || rm -rf "$work"
  # Interrompu au milieu de l'échange des copies de Node.js : l'ancienne reprend sa place.
  if [ -n "$node_old" ] && [ -d "$node_old" ] && [ ! -e "$HOME_DIR/node" ]; then mv "$node_old" "$HOME_DIR/node" 2>/dev/null || :; fi
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# --url (ou --url=…) : l'adresse du cerveau, d'où viennent le client et install.ps1. Toutes les options passent ensuite
# telles quelles à setup.
url=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--url" ]; then url="$arg"; fi
  case "$arg" in --url=*) url="${arg#--url=}" ;; esac
  prev="$arg"
done
[ -n "$url" ] || fail 2 "Usage : sh install.sh --url <adresse du cerveau> --token <jeton personnel>"
while :; do
  case "$url" in */) url="${url%/}" ;; *) break ;; esac
done
# Le client téléchargé ici s'exécute sur le poste et reçoit le jeton : HTTPS obligatoire, sauf sur ce poste même.
# La valeur reçue n'est pas réaffichée : ce pourrait être le jeton passé au mauvais endroit.
case "$url" in
  https://?*) ;;
  http://localhost | http://localhost[/:]* | http://127.0.0.1 | http://127.0.0.1[/:]* | 'http://[::1]' | 'http://[::1]'[/:]*) ;;
  http://?*) warn "Attention : $url n'est pas en HTTPS, le client et ton jeton passeront en clair sur le réseau." ;;
  *) fail 2 "--url doit être l'adresse du cerveau, en https:// (par exemple --url https://cerveau.example.com)." ;;
esac
# Avec sudo, tout irait dans le compte root (config, Claude Code, synchro) au lieu de la session de l'employé.
if [ -n "${SUDO_USER:-}" ] && [ "$(id -u)" = 0 ]; then
  fail 2 "Lance la commande sans sudo : l'installation se fait dans ta session, sans droits administrateur."
fi
command -v curl >/dev/null 2>&1 || fail 4 "curl est introuvable : installe-le (par exemple sudo apt install curl), puis relance la même commande."

# Téléchargement : 3 nouvelles tentatives sur les erreurs passagères, délais bornés (jamais bloqué plus de 15 min).
fetch() { curl -fsSL --retry 3 --retry-delay 2 --connect-timeout 20 --max-time 900 -o "$2" "$1"; }

# Windows (Git Bash, MSYS2, Cygwin) : install.ps1 fait le travail (Node.js pour Windows, raccourci brain.cmd), dans le
# dossier de l'utilisateur Windows (%USERPROFILE%, celui que lit Node.js), pas dans le HOME de Git Bash.
run_windows() {
  command -v cygpath >/dev/null 2>&1 || fail 4 "Shell Windows sans cygpath : lance install.ps1 depuis PowerShell (powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 --url … --token …)."
  if [ -n "${COMPANY_BRAIN_HOME:-}" ]; then
    win_home="$(cygpath -u "$COMPANY_BRAIN_HOME")"
  elif [ -n "${USERPROFILE:-}" ]; then
    win_home="$(cygpath -u "$USERPROFILE")/.company-brain"
  else
    fail 4 "USERPROFILE n'est pas défini : impossible de trouver le dossier de l'utilisateur Windows."
  fi
  case "$win_home" in /*) ;; *) win_home="$(pwd)/$win_home" ;; esac
  mkdir -p "$win_home" 2>/dev/null || fail 4 "Impossible de créer $win_home : vérifie ses droits, puis relance la même commande."
  ps1="$win_home/install.ps1"
  new_ps1="$ps1.$$"
  fetch "$url/install.ps1" "$new_ps1" || fail 5 "Téléchargement impossible : $url/install.ps1 (réseau, proxy, adresse du cerveau ?). Relance la même commande."
  case "$(sed -n 1p "$new_ps1")" in
    "# NOS Brainer"*) ;;
    *) fail 5 "$url/install.ps1 n'est pas le script d'installation (page d'erreur, portail Wi-Fi, proxy ?) : vérifie l'adresse puis relance la même commande." ;;
  esac
  mv -f "$new_ps1" "$ps1"
  new_ps1=""
  ps_exe="$(command -v powershell.exe 2>/dev/null || :)"
  [ -n "$ps_exe" ] || ps_exe="$(cygpath -u "${SYSTEMROOT:-C:\\Windows}")/System32/WindowsPowerShell/v1.0/powershell.exe"
  [ -x "$ps_exe" ] || fail 4 "Windows PowerShell (powershell.exe) est introuvable : il fait partie de Windows 10 et 11, vérifie qu'il n'est pas bloqué."
  ps1_win="$(cygpath -w "$ps1")"
  if [ -n "${COMPANY_BRAIN_HOME:-}" ]; then
    COMPANY_BRAIN_HOME="$(cygpath -w "$win_home")"
    export COMPANY_BRAIN_HOME
  fi
  # Sans conversion de chemins MSYS : les options arrivent à install.ps1 exactement comme reçues ici.
  MSYS_NO_PATHCONV=1
  MSYS2_ARG_CONV_EXCL='*'
  export MSYS_NO_PATHCONV MSYS2_ARG_CONV_EXCL
  trap - EXIT HUP INT TERM
  exec "$ps_exe" -NoProfile -ExecutionPolicy Bypass -File "$ps1_win" "$@"
}
case "$(uname -s)" in MINGW* | MSYS* | CYGWIN* | *_NT-*) run_windows "$@" ;; esac

if [ -n "${COMPANY_BRAIN_HOME:-}" ]; then
  HOME_DIR="$COMPANY_BRAIN_HOME"
elif [ -n "${HOME:-}" ]; then
  HOME_DIR="$HOME/.company-brain"
else
  fail 4 "Ni HOME ni COMPANY_BRAIN_HOME ne sont définis : impossible de savoir où installer le client."
fi
case "$HOME_DIR" in /*) ;; *) HOME_DIR="$(pwd)/$HOME_DIR" ;; esac
{ mkdir -p "$HOME_DIR" 2>/dev/null && [ -w "$HOME_DIR" ]; } || fail 4 "Impossible d'écrire dans $HOME_DIR : vérifie ses droits (créé avec sudo ?), puis relance la même commande."
HOME_DIR="$(cd "$HOME_DIR" && pwd)"
# Dossier privé : config, jeton, journaux et état ne sont lisibles que par l'employé (mkdir et curl --create-dirs le
# laissent lisible par tous ou par le groupe).
chmod 700 "$HOME_DIR" 2>/dev/null || warn "Impossible de restreindre les droits de $HOME_DIR (chmod 700)."
# setup et le raccourci reçoivent le chemin absolu ; une valeur vide ne doit jamais désigner le dossier courant.
if [ -n "${COMPANY_BRAIN_HOME:-}" ]; then
  COMPANY_BRAIN_HOME="$HOME_DIR"
  export COMPANY_BRAIN_HOME
else
  unset COMPANY_BRAIN_HOME
fi

# Client du cerveau, téléchargé d'abord (une adresse fausse échoue tout de suite), vérifié une fois Node.js trouvé.
# Le nom temporaire doit finir en .mjs : sinon node --check le lit comme du CommonJS et refuse le vrai client.
new_mjs="$HOME_DIR/brain.new.$$.mjs"
say "Téléchargement du client du cerveau : $url/brain.mjs"
fetch "$url/brain.mjs" "$new_mjs" || fail 5 "Téléchargement impossible : $url/brain.mjs (réseau, proxy, adresse du cerveau ?). Relance la même commande."

# Archive officielle de Node.js pour ce poste (nodejs.org), ou la raison pour laquelle il n'y en a pas.
# musl (Alpine) : ldd le dit ; /lib/ld-musl-* seulement sans ldd (le paquet musl l'installe aussi sur une glibc).
is_musl() {
  if command -v ldd >/dev/null 2>&1; then
    ldd --version 2>&1 | grep -qi musl
  else
    ls /lib/ld-musl-* >/dev/null 2>&1
  fi
}
node_dist=""
no_dist=""
apple_silicon=""
case "$(uname -s)" in
  Darwin)
    # hw.optional.arm64 vaut 1 sur Apple Silicon, même sous Rosetta (où uname -m dit x86_64) : on veut le Node.js natif,
    # sinon Screenpipe serait installé en x64 et macOS redemanderait ses autorisations au passage suivant.
    if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || :)" = 1 ]; then
      node_dist=darwin-arm64
      apple_silicon=1
    else
      node_dist=darwin-x64
    fi
    ;;
  Linux)
    case "$(uname -m)" in
      x86_64 | amd64) cpu=x64 ;;
      aarch64 | arm64) cpu=arm64 ;;
      *) cpu="" ;;
    esac
    if [ -z "$cpu" ]; then
      no_dist="Node.js ≥ 20 est introuvable et aucune copie privée n'est prévue pour ce processeur ($(uname -m)) : installe Node.js ≥ 20 avec le gestionnaire de paquets du système, puis relance la même commande."
    elif is_musl; then
      if [ "$cpu" = x64 ]; then
        node_dist=linux-x64-musl
      else
        no_dist="Node.js ≥ 20 est introuvable et nodejs.org ne publie pas Node.js pour Linux musl (Alpine) sur ARM : installe-le avec apk add nodejs npm, puis relance la même commande."
      fi
    else
      node_dist="linux-$cpu"
    fi
    ;;
  *) no_dist="Node.js ≥ 20 est introuvable et ce système ($(uname -s)) n'est pas géré : installe Node.js ≥ 20 (https://nodejs.org), puis relance la même commande." ;;
esac

# Empreintes officielles (https://nodejs.org/dist/v22.23.3/SHASUMS256.txt), figées ici avec la version.
node_sha256() {
  case "$1" in
    node-v22.23.3-darwin-arm64.tar.gz) say 23b25245dcfb9af7262f8ff142e9e2e0af025368117329e7a7458a51e5922f53 ;;
    node-v22.23.3-darwin-x64.tar.gz) say 8a677b0219178efd6eb0e475457c4afb452b521a92f6e67845a73bd85727f2a8 ;;
    node-v22.23.3-linux-arm64.tar.gz) say 5ced2d48d1d7198739b7f86804de0171aefb6823b684b12341d3321afc3cb0b2 ;;
    node-v22.23.3-linux-x64.tar.gz) say 1084aa36196bba4c3a5e69a1ee388a6e4ff729dad09445fbcd434b28fe3c24af ;;
    node-v22.23.3-linux-x64-musl.tar.gz) say 633f49a4f388c5f9564d56d9c0f5ffa394346d92ca0076fe21cf776ece1988bc ;;
    *) return 1 ;;
  esac
}

have_sha256() { command -v shasum || command -v sha256sum || command -v openssl; } >/dev/null 2>&1
sha256_of() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 -r "$1" | cut -d' ' -f1
  fi
}

# Sonde un node : version, architecture et vrai chemin (process.execPath résout liens et shims). Rend 1 s'il ne démarre pas.
probe() {
  p_out="$("$1" -p 'process.versions.node+" "+process.arch+" "+process.execPath' 2>/dev/null)" || return 1
  p_ver="${p_out%% *}"
  p_rest="${p_out#* }"
  p_arch="${p_rest%% *}"
  p_path="${p_rest#* }"
  [ -n "$p_ver" ] && [ -n "$p_arch" ] && [ -n "$p_path" ]
}
major_ok() { [ "${1%%.*}" -ge 20 ] 2>/dev/null; }
arch_ok() { [ -z "$apple_silicon" ] || [ "$1" = arm64 ]; }
# Hooks, MCP et synchro planifiée enregistrent le vrai chemin de Node.js : celui d'un gestionnaire de versions ou d'une
# Cellar Homebrew disparaît à la prochaine mise à jour, et tout casserait sans bruit. On prend alors la copie privée.
versioned_path() {
  case "$1" in
    */Cellar/* | */.nvm/* | */fnm/* | */.fnm/* | */.volta/* | */.asdf/* | */mise/* | */.nodenv/* | */n/versions/* | */.local/share/pnpm/* | */pnpm/nodejs/* | /snap/*) return 0 ;;
  esac
  return 1
}

priv="$HOME_DIR/node/bin/node"
NODE=""
NODE_V=""
priv_ok=""       # version d'une copie privée qui marche, même ancienne : gardée si la nouvelle ne peut pas s'installer
fallback_node="" # Node.js ≥ 20 d'un gestionnaire de versions : en dernier recours seulement
fallback_v=""

# Pas de copie privée neuve : on garde ce qui marche déjà (l'ancienne copie privée, sinon le Node.js du gestionnaire de
# versions) avec un avertissement, sinon on s'arrête avec le code donné.
without_private_node() {
  wp_code="$1"
  shift
  if [ -n "$priv_ok" ]; then
    warn "$*"
    warn "On continue avec la copie privée déjà installée (Node.js v$priv_ok)."
    NODE="$priv"
    NODE_V="$priv_ok"
  elif [ -n "$fallback_node" ]; then
    warn "$*"
    warn "On continue avec $fallback_node : si une mise à jour de Node.js le supprime, relance la même commande."
    NODE="$fallback_node"
    NODE_V="$fallback_v"
  else
    fail "$wp_code" "$*"
  fi
}

# Installe la copie privée. Chaque étape est vérifiée : une erreur donne nos codes et nos messages, jamais ceux de curl
# ou de tar, et ne touche pas à la copie en place.
drop_work() {
  rm -rf "$work"
  work=""
}
install_private_node() {
  if [ -z "$node_dist" ]; then
    without_private_node 4 "$no_dist"
    return 0
  fi
  name="node-v$NODE_VERSION-$node_dist.tar.gz"
  expected="$(node_sha256 "$name")" || fail 4 "Pas d'empreinte connue pour $name : installation de Node.js arrêtée."
  if ! have_sha256; then
    without_private_node 4 "Aucun outil pour vérifier l'empreinte de Node.js (shasum, sha256sum ou openssl) : installe l'un d'eux ou Node.js ≥ 20, puis relance la même commande."
    return 0
  fi
  node_url="https://nodejs.org/dist/v$NODE_VERSION/$name"
  work="$HOME_DIR/node.download.$$"
  rm -rf "$work"
  mkdir -p "$work" || fail 4 "Impossible d'écrire dans $HOME_DIR : vérifie l'espace disque, puis relance la même commande."
  say "Installation de Node.js v$NODE_VERSION dans $HOME_DIR/node (copie privée, sans droits administrateur)…"
  if ! fetch "$node_url" "$work/$name"; then
    drop_work
    without_private_node 5 "Téléchargement impossible : $node_url (réseau, proxy ?). Relance la même commande."
    return 0
  fi
  if [ "$(sha256_of "$work/$name")" != "$expected" ]; then
    drop_work
    without_private_node 5 "Le téléchargement de Node.js ne correspond pas à son empreinte officielle (coupé, ou modifié par un proxy ?) : relance la même commande."
    return 0
  fi
  if ! tar -xzf "$work/$name" -C "$work" 2>"$work/tar.err"; then
    err="$(head -n 1 "$work/tar.err")"
    drop_work
    without_private_node 4 "Impossible d'extraire Node.js ($err) : vérifie l'espace disque, puis relance la même commande."
    return 0
  fi
  new_node="$work/node-v$NODE_VERSION-$node_dist"
  # Essai avant de remplacer quoi que ce soit : une copie qui ne démarre pas ici (macOS < 11, glibc < 2.28, Linux 32 bits
  # sur noyau 64 bits…) ne prend pas la place de celle qui marche.
  if ! probe "$new_node/bin/node" || [ "$p_ver" != "$NODE_VERSION" ]; then
    err="$("$new_node/bin/node" -v 2>&1 | head -n 1)"
    drop_work
    without_private_node 4 "Node.js v$NODE_VERSION ne démarre pas sur ce système ($err) : macOS ≥ 11 ou Linux avec glibc ≥ 2.28 requis. Installe Node.js ≥ 20 avec le gestionnaire de paquets du système, puis relance la même commande."
    return 0
  fi
  # Échange sans jamais perdre Node.js : l'ancienne copie est mise de côté, la nouvelle prend sa place, puis l'ancienne
  # est effacée (remise en place si quelque chose échoue entre-temps).
  if [ -e "$HOME_DIR/node" ]; then
    node_old="$HOME_DIR/node.old.$$"
    if ! mv "$HOME_DIR/node" "$node_old"; then
      node_old=""
      drop_work
      without_private_node 4 "Impossible de remplacer $HOME_DIR/node : vérifie ses droits, puis relance la même commande."
      return 0
    fi
  fi
  if ! mv "$new_node" "$HOME_DIR/node"; then
    if [ -n "$node_old" ]; then mv "$node_old" "$HOME_DIR/node" || :; fi
    node_old=""
    drop_work
    without_private_node 4 "Impossible d'installer Node.js dans $HOME_DIR/node : vérifie l'espace disque, puis relance la même commande."
    return 0
  fi
  if [ -n "$node_old" ]; then rm -rf "$node_old" || :; fi
  node_old=""
  drop_work
  NODE="$priv"
  NODE_V="$NODE_VERSION"
}

# 1. La copie privée, si elle est à la version figée (et native sur Apple Silicon).
if [ -x "$priv" ] && probe "$priv" && major_ok "$p_ver" && arch_ok "$p_arch"; then
  priv_ok="$p_ver"
  if [ "$p_ver" = "$NODE_VERSION" ]; then
    NODE="$priv"
    NODE_V="$p_ver"
  fi
fi
# 2. Sinon un Node.js ≥ 20 du système, installé à demeure : on enregistre son vrai chemin, pas celui du shim.
if [ -z "$NODE" ] && [ "${COMPANY_BRAIN_FORCE_PRIVATE_NODE:-}" != 1 ]; then
  sys_node="$(command -v node 2>/dev/null || :)"
  if [ -n "$sys_node" ] && probe "$sys_node"; then
    if ! major_ok "$p_ver"; then
      say "Node.js v$p_ver ($p_path) est trop ancien : il faut la version 20 ou plus."
    elif ! arch_ok "$p_arch"; then
      say "Node.js $p_path est en $p_arch (Rosetta) : ce Mac a besoin de la version Apple Silicon."
    elif versioned_path "$p_path"; then
      say "Node.js $p_path vient d'un gestionnaire de versions : il peut disparaître à sa prochaine mise à jour."
      fallback_node="$p_path"
      fallback_v="$p_ver"
    else
      NODE="$p_path"
      NODE_V="$p_ver"
    fi
  fi
fi
# 3. Sinon la copie privée, téléchargée et vérifiée.
if [ -z "$NODE" ]; then
  install_private_node
fi

# Le client téléchargé doit être du JavaScript valide : une page HTML (portail Wi-Fi, proxy, connexion SSO, erreur servie
# en 200) ne passe pas. L'ancien client reste intact jusqu'au remplacement, d'un bloc.
"$NODE" --check "$new_mjs" 2>/dev/null || fail 5 "$url/brain.mjs n'est pas le client du cerveau (page d'erreur, portail Wi-Fi, proxy ?) : vérifie l'adresse puis relance la même commande."
mv -f "$new_mjs" "$HOME_DIR/brain.mjs"
new_mjs=""

# Raccourci : ~/.company-brain/brain <commande> marche même quand node n'est pas dans le PATH (copie privée). Chemins
# entre apostrophes : espaces, $, ` ou " dans un chemin ne sont jamais interprétés. Écrit à côté, puis mis en place d'un bloc.
sh_quote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
shortcut_tmp="$HOME_DIR/brain.tmp.$$"
{
  printf '#!/bin/sh\n'
  if [ -n "${COMPANY_BRAIN_HOME:-}" ]; then
    printf 'COMPANY_BRAIN_HOME=%s\nexport COMPANY_BRAIN_HOME\n' "$(sh_quote "$HOME_DIR")"
  fi
  printf 'exec %s %s "$@"\n' "$(sh_quote "$NODE")" "$(sh_quote "$HOME_DIR/brain.mjs")"
} >"$shortcut_tmp"
chmod 755 "$shortcut_tmp"
mv -f "$shortcut_tmp" "$HOME_DIR/brain"
shortcut_tmp=""

say "Client du cerveau installé : $HOME_DIR/brain (Node.js v$NODE_V : $NODE)."
trap - EXIT HUP INT TERM
exec "$NODE" "$HOME_DIR/brain.mjs" setup "$@"
