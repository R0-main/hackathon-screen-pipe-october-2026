#!/bin/sh
# NOS Brainer: connects this computer to the company brain in one command.
#
#   sh install.sh --url https://brain.example.com --token cb_…        (personal prompt, token handed over by an admin)
#   sh install.sh --url https://brain.example.com --join cj_… --name …  (team message: asks to join)
#   … --ca ~/.company-brain/ca.crt   (self-hosted brain on local HTTPS: certificate of its authority, already checked by
#                                     its fingerprint in the prompt; used for the download, then by the client)
#
# 1. Node.js: the private copy ~/.company-brain/node if it is at the version pinned below; otherwise a Node.js ≥ 20
#    permanently installed on the system; otherwise installs the private copy (macOS, Linux), without admin rights,
#    checking the official SHA-256 fingerprint of the archive.
# 2. Downloads the brain client (<url>/brain.mjs), checks that it really is JavaScript, then writes the shortcut
#    ~/.company-brain/brain.
# 3. Runs `brain setup` with the same options: Screenpipe, macOS permissions, MCP, hooks, sync, neon.
#    With --join <team code> (team message), runs `brain join`: the request waits for an admin to accept it, then
#    moves on to setup.
# On Windows (Git Bash), hands over to <url>/install.ps1, which does the same thing with the same contract.
#
# Exit codes (the same for install.ps1, setup and join; full table: docs/CLI.md):
#   0, 1, 3, 6, 7, 8  those of `brain setup` or `brain join`, passed through: 0 = everything is connected; 1 = failure (run
#                     `~/.company-brain/brain doctor`); 3 = macOS permission pending (run `~/.company-brain/brain
#                     setup` again once granted); 6 = connected, but without Screenpipe; 7 = request not accepted yet
#                     (run `~/.company-brain/brain join` again); 8 = request rejected.
#   2                 bad call: --url missing or not http(s), or run with sudo.
#   4                 unsupported system, or Node.js cannot be installed or run here (the message says what to install).
#   5                 download impossible (network, proxy, wrong address, error page instead of the client):
#                     run the same command again. The client and Node.js already installed stay intact.
#   9                 (prompt command only) unexpected brain certificate: fingerprint different from the prompt's.
# The token is never displayed. Why a script and a CLI rather than instructions to Claude: docs/CLI.md.
# Tests only: COMPANY_BRAIN_FORCE_PRIVATE_NODE=1 ignores the system's Node.js (CI tests the download).

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

# Temporary files suffixed with the PID (two simultaneous installs do not step on each other), deleted on exit.
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
  # Interrupted in the middle of swapping the Node.js copies: the old one goes back in place.
  if [ -n "$node_old" ] && [ -d "$node_old" ] && [ ! -e "$HOME_DIR/node" ]; then mv "$node_old" "$HOME_DIR/node" 2>/dev/null || :; fi
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# --url (or --url=…): the brain's address, where the client and install.ps1 come from. --ca: certificate (PEM) of a
# self-hosted brain, used for downloads from the brain. All options are then passed as is to
# setup, or to join with --join (team message).
url=""
ca=""
command="setup"
prev=""
for arg in "$@"; do
  if [ "$prev" = "--url" ]; then url="$arg"; fi
  if [ "$prev" = "--ca" ]; then ca="$arg"; fi
  case "$arg" in
    --url=*) url="${arg#--url=}" ;;
    --ca=*) ca="${arg#--ca=}" ;;
    --join | --join=*) command="join" ;;
  esac
  prev="$arg"
done
[ -n "$url" ] || fail 2 "Usage: sh install.sh --url <brain address> --token <personal token>  (or --join <team code>)"
while :; do
  case "$url" in */) url="${url%/}" ;; *) break ;; esac
done
# The client downloaded here runs on the computer and receives the token: HTTPS required, except on this very computer.
# The received value is not echoed back: it could be the token passed in the wrong place.
case "$url" in
  https://?*) ;;
  http://localhost | http://localhost[/:]* | http://127.0.0.1 | http://127.0.0.1[/:]* | 'http://[::1]' | 'http://[::1]'[/:]*) ;;
  http://?*) warn "Warning: $url is not HTTPS, the client and your token will travel in clear text over the network." ;;
  *) fail 2 "--url must be the brain's address, with https:// (for example --url https://brain.example.com)." ;;
esac
# With sudo, everything would go into the root account (config, Claude Code, sync) instead of the employee's session.
if [ -n "${SUDO_USER:-}" ] && [ "$(id -u)" = 0 ]; then
  fail 2 "Run the command without sudo: the install happens in your session, without admin rights."
fi
command -v curl >/dev/null 2>&1 || fail 4 "curl not found: install it (for example sudo apt install curl), then run the same command again."
if [ -n "$ca" ] && [ ! -f "$ca" ]; then fail 2 "Certificate not found: $ca (--ca option)."; fi

# Download: 3 retries on transient errors, bounded delays (never stuck for more than 15 min).
# Self-hosted brain (--ca): its certificate is only used for downloads from the brain, not for nodejs.org.
fetch() {
  f_url="$1"
  f_out="$2"
  case "$f_url" in
    "$url"/*)
      if [ -n "$ca" ]; then
        curl -fsSL --cacert "$ca" --retry 3 --retry-delay 2 --connect-timeout 20 --max-time 900 -o "$f_out" "$f_url"
        return
      fi
      ;;
  esac
  curl -fsSL --retry 3 --retry-delay 2 --connect-timeout 20 --max-time 900 -o "$f_out" "$f_url"
}

# Windows (Git Bash, MSYS2, Cygwin): install.ps1 does the work (Node.js for Windows, brain.cmd shortcut), in the
# Windows user's folder (%USERPROFILE%, the one Node.js reads), not in Git Bash's HOME.
run_windows() {
  command -v cygpath >/dev/null 2>&1 || fail 4 "Windows shell without cygpath: run install.ps1 from PowerShell (powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 --url … --token …)."
  if [ -n "${COMPANY_BRAIN_HOME:-}" ]; then
    win_home="$(cygpath -u "$COMPANY_BRAIN_HOME")"
  elif [ -n "${USERPROFILE:-}" ]; then
    win_home="$(cygpath -u "$USERPROFILE")/.company-brain"
  else
    fail 4 "USERPROFILE is not set: cannot find the Windows user's folder."
  fi
  case "$win_home" in /*) ;; *) win_home="$(pwd)/$win_home" ;; esac
  mkdir -p "$win_home" 2>/dev/null || fail 4 "Cannot create $win_home: check its permissions, then run the same command again."
  ps1="$win_home/install.ps1"
  new_ps1="$ps1.$$"
  fetch "$url/install.ps1" "$new_ps1" || fail 5 "Download failed: $url/install.ps1 (network, proxy, brain address?). Run the same command again."
  case "$(sed -n 1p "$new_ps1")" in
    "# NOS Brainer"*) ;;
    *) fail 5 "$url/install.ps1 is not the install script (error page, Wi-Fi portal, proxy?): check the address, then run the same command again." ;;
  esac
  mv -f "$new_ps1" "$ps1"
  new_ps1=""
  ps_exe="$(command -v powershell.exe 2>/dev/null || :)"
  [ -n "$ps_exe" ] || ps_exe="$(cygpath -u "${SYSTEMROOT:-C:\\Windows}")/System32/WindowsPowerShell/v1.0/powershell.exe"
  [ -x "$ps_exe" ] || fail 4 "Windows PowerShell (powershell.exe) not found: it ships with Windows 10 and 11, check that it is not blocked."
  ps1_win="$(cygpath -w "$ps1")"
  if [ -n "${COMPANY_BRAIN_HOME:-}" ]; then
    COMPANY_BRAIN_HOME="$(cygpath -w "$win_home")"
    export COMPANY_BRAIN_HOME
  fi
  # --ca: Windows path for install.ps1 and the client (Node.js does not read /c/Users/…); install.ps1 adds it to the store.
  if [ -n "$ca" ]; then
    ca_win="$(cygpath -w "$ca")"
    n=$#
    prev=""
    while [ "$n" -gt 0 ]; do
      a="$1"
      shift
      n=$((n - 1))
      if [ "$prev" = "--ca" ]; then set -- "$@" "$ca_win"
      else
        case "$a" in
          --ca=*) set -- "$@" "--ca=$ca_win" ;;
          *) set -- "$@" "$a" ;;
        esac
      fi
      prev="$a"
    done
  fi
  # Without MSYS path conversion: options reach install.ps1 exactly as received here.
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
  fail 4 "Neither HOME nor COMPANY_BRAIN_HOME is set: cannot tell where to install the client."
fi
case "$HOME_DIR" in /*) ;; *) HOME_DIR="$(pwd)/$HOME_DIR" ;; esac
{ mkdir -p "$HOME_DIR" 2>/dev/null && [ -w "$HOME_DIR" ]; } || fail 4 "Cannot write to $HOME_DIR: check its permissions (created with sudo?), then run the same command again."
HOME_DIR="$(cd "$HOME_DIR" && pwd)"
# Private folder: config, token, logs and state are readable by the employee only (mkdir and curl --create-dirs leave
# it readable by everyone or by the group).
chmod 700 "$HOME_DIR" 2>/dev/null || warn "Cannot restrict the permissions of $HOME_DIR (chmod 700)."
# setup and the shortcut receive the absolute path; an empty value must never point to the current folder.
if [ -n "${COMPANY_BRAIN_HOME:-}" ]; then
  COMPANY_BRAIN_HOME="$HOME_DIR"
  export COMPANY_BRAIN_HOME
else
  unset COMPANY_BRAIN_HOME
fi

# Brain client, downloaded first (a wrong address fails right away), checked once Node.js is found.
# The temporary name must end in .mjs: otherwise node --check reads it as CommonJS and refuses the real client.
new_mjs="$HOME_DIR/brain.new.$$.mjs"
say "Downloading the brain client: $url/brain.mjs"
fetch "$url/brain.mjs" "$new_mjs" || fail 5 "Download failed: $url/brain.mjs (network, proxy, brain address?). Run the same command again."

# Official Node.js archive for this computer (nodejs.org), or the reason why there is none.
# musl (Alpine): ldd says so; /lib/ld-musl-* only without ldd (the musl package installs it on glibc too).
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
    # hw.optional.arm64 is 1 on Apple Silicon, even under Rosetta (where uname -m says x86_64): we want the native Node.js,
    # otherwise Screenpipe would be installed as x64 and macOS would ask for its permissions again on the next run.
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
      no_dist="Node.js ≥ 20 not found and no private copy is provided for this processor ($(uname -m)): install Node.js ≥ 20 with the system's package manager, then run the same command again."
    elif is_musl; then
      if [ "$cpu" = x64 ]; then
        node_dist=linux-x64-musl
      else
        no_dist="Node.js ≥ 20 not found and nodejs.org does not publish Node.js for Linux musl (Alpine) on ARM: install it with apk add nodejs npm, then run the same command again."
      fi
    else
      node_dist="linux-$cpu"
    fi
    ;;
  *) no_dist="Node.js ≥ 20 not found and this system ($(uname -s)) is not supported: install Node.js ≥ 20 (https://nodejs.org), then run the same command again." ;;
esac

# Official fingerprints (https://nodejs.org/dist/v22.23.3/SHASUMS256.txt), pinned here with the version.
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

# Probes a node: version, architecture and real path (process.execPath resolves links and shims). Returns 1 if it does not start.
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
# Hooks, MCP and scheduled sync record Node.js's real path: that of a version manager or of a Homebrew
# Cellar disappears on the next update, and everything would break silently. The private copy is used instead.
versioned_path() {
  case "$1" in
    */Cellar/* | */.nvm/* | */fnm/* | */.fnm/* | */.volta/* | */.asdf/* | */mise/* | */.nodenv/* | */n/versions/* | */.local/share/pnpm/* | */pnpm/nodejs/* | /snap/*) return 0 ;;
  esac
  return 1
}

priv="$HOME_DIR/node/bin/node"
NODE=""
NODE_V=""
priv_ok=""       # version of a private copy that works, even old: kept if the new one cannot be installed
fallback_node="" # Node.js ≥ 20 from a version manager: last resort only
fallback_v=""

# No fresh private copy: keep what already works (the old private copy, otherwise the version manager's
# Node.js) with a warning, otherwise stop with the given code.
without_private_node() {
  wp_code="$1"
  shift
  if [ -n "$priv_ok" ]; then
    warn "$*"
    warn "Continuing with the private copy already installed (Node.js v$priv_ok)."
    NODE="$priv"
    NODE_V="$priv_ok"
  elif [ -n "$fallback_node" ]; then
    warn "$*"
    warn "Continuing with $fallback_node: if a Node.js update removes it, run the same command again."
    NODE="$fallback_node"
    NODE_V="$fallback_v"
  else
    fail "$wp_code" "$*"
  fi
}

# Installs the private copy. Each step is checked: an error gives our codes and messages, never curl's
# or tar's, and does not touch the copy in place.
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
  expected="$(node_sha256 "$name")" || fail 4 "No known fingerprint for $name: Node.js install stopped."
  if ! have_sha256; then
    without_private_node 4 "No tool to check the Node.js fingerprint (shasum, sha256sum or openssl): install one of them or Node.js ≥ 20, then run the same command again."
    return 0
  fi
  node_url="https://nodejs.org/dist/v$NODE_VERSION/$name"
  work="$HOME_DIR/node.download.$$"
  rm -rf "$work"
  mkdir -p "$work" || fail 4 "Cannot write to $HOME_DIR: check the disk space, then run the same command again."
  say "Installing Node.js v$NODE_VERSION in $HOME_DIR/node (private copy, no admin rights)…"
  if ! fetch "$node_url" "$work/$name"; then
    drop_work
    without_private_node 5 "Download failed: $node_url (network, proxy?). Run the same command again."
    return 0
  fi
  if [ "$(sha256_of "$work/$name")" != "$expected" ]; then
    drop_work
    without_private_node 5 "The Node.js download does not match its official fingerprint (cut off, or modified by a proxy?): run the same command again."
    return 0
  fi
  if ! tar -xzf "$work/$name" -C "$work" 2>"$work/tar.err"; then
    err="$(head -n 1 "$work/tar.err")"
    drop_work
    without_private_node 4 "Cannot extract Node.js ($err): check the disk space, then run the same command again."
    return 0
  fi
  new_node="$work/node-v$NODE_VERSION-$node_dist"
  # Trial before replacing anything: a copy that does not start here (macOS < 11, glibc < 2.28, 32-bit Linux
  # on a 64-bit kernel…) does not take the place of the one that works.
  if ! probe "$new_node/bin/node" || [ "$p_ver" != "$NODE_VERSION" ]; then
    err="$("$new_node/bin/node" -v 2>&1 | head -n 1)"
    drop_work
    without_private_node 4 "Node.js v$NODE_VERSION does not start on this system ($err): macOS ≥ 11 or Linux with glibc ≥ 2.28 required. Install Node.js ≥ 20 with the system's package manager, then run the same command again."
    return 0
  fi
  # Swap without ever losing Node.js: the old copy is set aside, the new one takes its place, then the old one
  # is deleted (put back if something fails in between).
  if [ -e "$HOME_DIR/node" ]; then
    node_old="$HOME_DIR/node.old.$$"
    if ! mv "$HOME_DIR/node" "$node_old"; then
      node_old=""
      drop_work
      without_private_node 4 "Cannot replace $HOME_DIR/node: check its permissions, then run the same command again."
      return 0
    fi
  fi
  if ! mv "$new_node" "$HOME_DIR/node"; then
    if [ -n "$node_old" ]; then mv "$node_old" "$HOME_DIR/node" || :; fi
    node_old=""
    drop_work
    without_private_node 4 "Cannot install Node.js in $HOME_DIR/node: check the disk space, then run the same command again."
    return 0
  fi
  if [ -n "$node_old" ]; then rm -rf "$node_old" || :; fi
  node_old=""
  drop_work
  NODE="$priv"
  NODE_V="$NODE_VERSION"
}

# 1. The private copy, if it is at the pinned version (and native on Apple Silicon).
if [ -x "$priv" ] && probe "$priv" && major_ok "$p_ver" && arch_ok "$p_arch"; then
  priv_ok="$p_ver"
  if [ "$p_ver" = "$NODE_VERSION" ]; then
    NODE="$priv"
    NODE_V="$p_ver"
  fi
fi
# 2. Otherwise a system Node.js ≥ 20, permanently installed: its real path is recorded, not the shim's.
if [ -z "$NODE" ] && [ "${COMPANY_BRAIN_FORCE_PRIVATE_NODE:-}" != 1 ]; then
  sys_node="$(command -v node 2>/dev/null || :)"
  if [ -n "$sys_node" ] && probe "$sys_node"; then
    if ! major_ok "$p_ver"; then
      say "Node.js v$p_ver ($p_path) is too old: version 20 or later is required."
    elif ! arch_ok "$p_arch"; then
      say "Node.js $p_path is $p_arch (Rosetta): this Mac needs the Apple Silicon version."
    elif versioned_path "$p_path"; then
      say "Node.js $p_path comes from a version manager: it may disappear on its next update."
      fallback_node="$p_path"
      fallback_v="$p_ver"
    else
      NODE="$p_path"
      NODE_V="$p_ver"
    fi
  fi
fi
# 3. Otherwise the private copy, downloaded and checked.
if [ -z "$NODE" ]; then
  install_private_node
fi

# The downloaded client must be valid JavaScript: an HTML page (Wi-Fi portal, proxy, SSO sign-in, error served
# with 200) does not pass. The old client stays intact until the replacement, in one go.
"$NODE" --check "$new_mjs" 2>/dev/null || fail 5 "$url/brain.mjs is not the brain client (error page, Wi-Fi portal, proxy?): check the address, then run the same command again."
mv -f "$new_mjs" "$HOME_DIR/brain.mjs"
new_mjs=""

# Shortcut: ~/.company-brain/brain <command> works even when node is not in the PATH (private copy). Paths
# between single quotes: spaces, $, ` or " in a path are never interpreted. Written alongside, then put in place in one go.
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

say "Brain client installed: $HOME_DIR/brain (Node.js v$NODE_V: $NODE)."
trap - EXIT HUP INT TERM
exec "$NODE" "$HOME_DIR/brain.mjs" "$command" "$@"
