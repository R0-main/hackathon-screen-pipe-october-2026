#!/bin/sh
# NOS Brainer : branche ce poste au cerveau d'entreprise en une commande.
#
#   sh install.sh --url https://cerveau.example.com --token cb_…
#
# 1. Trouve Node.js ≥ 20. S'il manque (macOS, Linux), installe une copie privée de Node dans ~/.company-brain/node,
#    sans droits administrateur, en vérifiant son empreinte SHA-256.
# 2. Télécharge le client du cerveau (<url>/brain.mjs) et écrit le raccourci ~/.company-brain/brain.
# 3. Lance `brain setup` avec les mêmes options : Screenpipe, autorisations macOS, MCP, hooks, synchro, néon.
#
# Le code de sortie est celui de setup : 0 = tout est branché, 3 = autorisation macOS en attente (relancer
# `~/.company-brain/brain setup` une fois cochée). 2 = mauvais appel, 4 = Node.js manquant sur un système non géré.
# Pourquoi un script et un CLI plutôt que des instructions à Claude : docs/CLI.md.

set -eu

NODE_VERSION="22.22.0"
HOME_DIR="${COMPANY_BRAIN_HOME:-$HOME/.company-brain}"

say() { printf '%s\n' "$*"; }
fail() {
  code="$1"
  shift
  printf '%s\n' "$*" >&2
  exit "$code"
}

# --url (ou --url=…) : l'adresse du cerveau, d'où vient brain.mjs. Toutes les options passent ensuite à setup.
url=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--url" ]; then url="$arg"; fi
  case "$arg" in --url=*) url="${arg#--url=}" ;; esac
  prev="$arg"
done
[ -n "$url" ] || fail 2 "Usage : sh install.sh --url <adresse du cerveau> --token <jeton personnel>"
url="${url%/}"
command -v curl >/dev/null 2>&1 || fail 4 "curl est introuvable : installe-le, puis relance ce script."

mkdir -p "$HOME_DIR"

node_ok() { "$1" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' >/dev/null 2>&1; }

# Empreintes officielles (https://nodejs.org/dist/v22.22.0/SHASUMS256.txt), figées ici avec la version.
node_sha256() {
  case "$1" in
    node-v22.22.0-darwin-arm64.tar.gz) say 5ed4db0fcf1eaf84d91ad12462631d73bf4576c1377e192d222e48026a902640 ;;
    node-v22.22.0-darwin-x64.tar.gz) say 5ea50c9d6dea3dfa3abb66b2656f7a4e1c8cef23432b558d45fb538c7b5dedce ;;
    node-v22.22.0-linux-arm64.tar.gz) say 25ba95dfb96871fa2ef977f11f95ea90818c8fa15c0f2110771db08d4ba423be ;;
    node-v22.22.0-linux-x64.tar.gz) say c33c39ed9c80deddde77c960d00119918b9e352426fd604ba41638d6526a4744 ;;
    *) return 1 ;;
  esac
}

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  else
    sha256sum "$1" | cut -d' ' -f1
  fi
}

install_private_node() {
  case "$(uname -s)" in
    Darwin) platform=darwin ;;
    Linux) platform=linux ;;
    *) fail 4 "Node.js ≥ 20 est introuvable. Installe-le (https://nodejs.org ; Windows : winget install OpenJS.NodeJS.LTS), puis relance ce script." ;;
  esac
  case "$(uname -m)" in
    arm64 | aarch64) arch=arm64 ;;
    x86_64 | amd64) arch=x64 ;;
    *) fail 4 "Node.js ≥ 20 est introuvable et ce processeur ($(uname -m)) n'est pas géré : installe Node.js (https://nodejs.org), puis relance ce script." ;;
  esac
  name="node-v$NODE_VERSION-$platform-$arch.tar.gz"
  expected="$(node_sha256 "$name")"
  say "Node.js ≥ 20 introuvable : installation d'une copie privée (v$NODE_VERSION) dans $HOME_DIR/node, sans droits administrateur."
  tmp="$HOME_DIR/node.download"
  rm -rf "$tmp"
  mkdir -p "$tmp/node"
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/$name" -o "$tmp/$name"
  [ "$(sha256_of "$tmp/$name")" = "$expected" ] || {
    rm -rf "$tmp"
    fail 1 "Le téléchargement de Node.js ne correspond pas à son empreinte officielle : installation arrêtée."
  }
  tar -xzf "$tmp/$name" -C "$tmp/node" --strip-components 1
  rm -rf "$HOME_DIR/node"
  mv "$tmp/node" "$HOME_DIR/node"
  rm -rf "$tmp"
}

NODE=""
if command -v node >/dev/null 2>&1 && node_ok "$(command -v node)"; then
  NODE="$(command -v node)"
elif [ -x "$HOME_DIR/node/bin/node" ] && node_ok "$HOME_DIR/node/bin/node"; then
  NODE="$HOME_DIR/node/bin/node"
else
  install_private_node
  NODE="$HOME_DIR/node/bin/node"
fi

# Client du cerveau : remplacé d'un bloc, pour ne jamais laisser un fichier à moitié téléchargé.
curl -fsSL "$url/brain.mjs" -o "$HOME_DIR/brain.mjs.download"
mv "$HOME_DIR/brain.mjs.download" "$HOME_DIR/brain.mjs"

# Raccourci : ~/.company-brain/brain <commande> marche même quand node n'est pas dans le PATH (copie privée).
cat >"$HOME_DIR/brain" <<EOF
#!/bin/sh
exec "$NODE" "$HOME_DIR/brain.mjs" "\$@"
EOF
chmod +x "$HOME_DIR/brain"

say "Client du cerveau installé : $HOME_DIR/brain (Node.js $("$NODE" -v))."
exec "$NODE" "$HOME_DIR/brain.mjs" setup "$@"
