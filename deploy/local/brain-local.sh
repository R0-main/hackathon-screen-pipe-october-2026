#!/bin/sh
# Le cerveau d'entreprise sur cette machine (Docker) : Postgres + dashboard + HTTPS local. Doc : docs/LOCAL.md
#
#   sh deploy/local/brain-local.sh up       écrit .env s'il manque (mot de passe, adresses du réseau local), construit, démarre, affiche l'adresse
#   sh deploy/local/brain-local.sh status   état des conteneurs et adresses
#   sh deploy/local/brain-local.sh ca       exporte le certificat racine (deploy/local/ca.crt), affiche son empreinte et comment l'installer ici
#   sh deploy/local/brain-local.sh logs     journaux en continu
#   sh deploy/local/brain-local.sh backup   sauvegarde Postgres dans deploy/local/backups/
#   sh deploy/local/brain-local.sh update   git pull, reconstruit et redémarre (les données restent)
#   sh deploy/local/brain-local.sh down     arrête (les données restent dans les volumes Docker)
set -eu

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
ENV_FILE="$ROOT/.env"
CA_OUT="$ROOT/deploy/local/ca.crt"
cd "$ROOT"

say() { printf '%s\n' "$*"; }
fail() { printf '%s\n' "$*" >&2; exit 1; }
compose() { docker compose -f "$ROOT/compose.yaml" "$@"; }
envval() { grep "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | sed 's/^"//; s/"$//'; }

command -v docker >/dev/null 2>&1 || fail "Docker est introuvable : installe Docker Desktop (macOS, Windows) ou Docker Engine (Linux), puis relance."
docker compose version >/dev/null 2>&1 || fail "« docker compose » est introuvable : installe Docker Compose v2, puis relance."

# Adresses IPv4 de cette machine sur le réseau local (hors boucle locale et Docker).
lan_ips() {
  if command -v ip >/dev/null 2>&1; then
    ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | grep -v '^172\.1[6-9]\.\|^172\.2[0-9]\.\|^172\.3[01]\.' || true
  elif command -v ifconfig >/dev/null 2>&1; then
    ifconfig 2>/dev/null | awk '/inet / && $2 != "127.0.0.1" {print $2}' || true
  fi
}

default_hosts() {
  h="localhost"
  for ip in $(lan_ips); do h="$h, $ip"; done
  name=$(hostname -s 2>/dev/null || hostname 2>/dev/null || true)
  [ -n "$name" ] && h="$h, $name.local"
  printf '%s' "$h"
}

ensure_env() {
  [ -f "$ENV_FILE" ] && return 0
  pw=$(openssl rand -hex 16 2>/dev/null || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
  hosts=$(default_hosts)
  first=$(printf '%s' "$hosts" | cut -d, -f2 | tr -d ' ')
  [ -n "$first" ] || first=localhost
  cat >"$ENV_FILE" <<ENV
# Cerveau auto-hébergé (lu par compose.yaml). Modifiable ; ensuite : sh deploy/local/brain-local.sh up
POSTGRES_PASSWORD=$pw
# Noms et adresses du cerveau sur le réseau local, tous dans le certificat HTTPS
BRAIN_HOSTS="$hosts"
# Celle que les postes utiliseront (prompt d'installation, liens)
BRAIN_HOST=$first
# Certificat : internal (autorité privée de Caddy) ou vos fichiers « /certs/cert.pem /certs/key.pem » (dossier deploy/local/certs)
BRAIN_TLS=internal
# Claude côté serveur (« où en est la boîte », onboarding) : facultatif, chaque poste distille avec son propre abonnement
ANTHROPIC_API_KEY=
# Entreprise fictive de démonstration : BRAIN_DEMO=1
BRAIN_DEMO=
# BRAIN_SIGNUP=0 ferme la création d'entreprise depuis la page d'accueil (sur invitation seulement)
BRAIN_SIGNUP=
BRAIN_TIMEZONE=Europe/Paris
ENV
  say "Configuration écrite dans $ENV_FILE (adresses : $hosts)."
}

trust_hint() {
  case "$(uname -s)" in
    Darwin) say "  security add-trusted-cert -r trustRoot -k \"\$HOME/Library/Keychains/login.keychain-db\" \"$CA_OUT\"" ;;
    Linux) say "  certutil -d sql:\$HOME/.pki/nssdb -A -t \"C,,\" -n \"NOS Brainer\" -i \"$CA_OUT\"   (Chrome ; Firefox : Paramètres → Certificats → Importer)" ;;
    *) say "  certutil -user -addstore Root \"$CA_OUT\"   (Windows)" ;;
  esac
}

export_ca() {
  if [ "$(envval BRAIN_TLS)" != "internal" ] && [ -n "$(envval BRAIN_TLS)" ]; then
    say "Certificat fourni par vous (BRAIN_TLS=$(envval BRAIN_TLS)) : rien à installer sur les postes si votre autorité est déjà reconnue."
    return 0
  fi
  i=0
  while ! compose exec -T caddy cat /data/caddy/pki/authorities/local/root.crt >"$CA_OUT.tmp" 2>/dev/null || [ ! -s "$CA_OUT.tmp" ]; do
    i=$((i + 1))
    [ "$i" -lt 30 ] || { rm -f "$CA_OUT.tmp"; fail "Caddy n'a pas encore créé son autorité : réessaie dans quelques secondes (sh deploy/local/brain-local.sh ca)."; }
    sleep 2
  done
  mv "$CA_OUT.tmp" "$CA_OUT"
  say "Certificat racine exporté : $CA_OUT"
  if command -v openssl >/dev/null 2>&1; then
    say "Empreinte SHA-256 : $(openssl x509 -in "$CA_OUT" -noout -fingerprint -sha256 | cut -d= -f2 | tr -d :)"
    say "(la même est épinglée dans chaque prompt d'installation généré par le dashboard)"
  fi
  say "Pour le navigateur de cette machine :"
  trust_hint
  say "Les postes des employés n'ont rien à faire : leur prompt d'installation s'en charge."
}

show_urls() {
  host=$(envval BRAIN_HOST)
  [ -n "$host" ] || host=localhost
  say ""
  say "Le cerveau : https://$host   (aussi : $(envval BRAIN_HOSTS))"
  say "Première fois : https://$host/creer crée l'entreprise et son premier compte admin."
  say "Ensuite : /admin → Inviter quelqu'un → le prompt d'installation (certificat compris) à coller dans Claude Code du poste."
}

cmd=${1:-help}
case "$cmd" in
  up)
    ensure_env
    say "Construction et démarrage (la première fois : quelques minutes)…"
    compose up -d --build --wait
    export_ca
    show_urls
    ;;
  status)
    compose ps
    show_urls
    ;;
  ca) export_ca ;;
  logs) compose logs -f --tail=100 ;;
  backup)
    mkdir -p "$ROOT/deploy/local/backups"
    out="$ROOT/deploy/local/backups/brain-$(date +%Y%m%d-%H%M%S).sql.gz"
    compose exec -T postgres pg_dump -U brain brain | gzip >"$out"
    say "Sauvegarde : $out  (restaurer : gunzip -c <fichier> | docker compose exec -T postgres psql -U brain brain)"
    ;;
  update)
    git -C "$ROOT" pull --ff-only
    compose up -d --build --wait
    say "Mis à jour et redémarré."
    show_urls
    ;;
  down) compose down ;;
  help | -h | --help) sed -n 2,10p "$0" | sed 's/^# \{0,1\}//' ;;
  *) fail "Commande inconnue : $cmd (up, status, ca, logs, backup, update, down)" ;;
esac
