#!/bin/sh
# Postgres du cerveau en local, pour `make dev` : sans question, sans droits administrateur.
#
#   sh scripts/local-db.sh start | stop | status | reset | url
#
# Avec DATABASE_URL renseignée dans .env : base existante, rien à démarrer ici.
# Sinon, Docker s'il répond sans sudo (conteneur nos-brainer-postgres, données dans un volume Docker) ;
# sinon un Postgres privé téléchargé dans .local/postgres du dépôt (binaires officiels de Maven Central,
# empreinte SHA-1 vérifiée) : marche sur un poste sans Docker ni droits admin (école 42).
# LOCAL_DB=docker ou LOCAL_DB=private force un mode.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
PG_USER=${POSTGRES_USER:-brain}
PG_PASSWORD=${POSTGRES_PASSWORD:-brain}
PG_DB=${POSTGRES_DB:-brain}
PG_PORT=${POSTGRES_PORT:-5432}
PG_VERSION=16.15.0
CONTAINER=nos-brainer-postgres
PRIVATE=${POSTGRES_HOME:-$ROOT/.local/postgres}

say() { printf '%s\n' "$*"; }
fail() { printf '%s\n' "$*" >&2; exit 1; }

# Port déjà pris sur 127.0.0.1 ? (Node.js est requis par le projet de toute façon.)
port_busy() {
  node -e "const s=require('net').createServer();s.once('error',()=>process.exit(0));s.listen($1,'127.0.0.1',()=>s.close(()=>process.exit(1)))"
}

mode() {
  if [ -n "${DATABASE_URL:-}" ]; then echo external; return; fi
  case "${LOCAL_DB:-}" in docker | private) echo "$LOCAL_DB"; return ;; esac
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then echo docker; else echo private; fi
}

# ---------- Docker ----------
docker_running() { [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || true)" = "true" ]; }

docker_start() {
  if docker_running; then say "Postgres (Docker) tourne déjà sur le port $PG_PORT."; return; fi
  if docker inspect "$CONTAINER" >/dev/null 2>&1; then
    docker start "$CONTAINER" >/dev/null
  else
    port_busy "$PG_PORT" && fail "Le port $PG_PORT est déjà pris : choisis-en un autre avec POSTGRES_PORT dans .env, puis relance."
    say "Postgres (Docker) : création du conteneur $CONTAINER sur le port $PG_PORT…"
    docker run -d --name "$CONTAINER" \
      -e POSTGRES_USER="$PG_USER" -e POSTGRES_PASSWORD="$PG_PASSWORD" -e POSTGRES_DB="$PG_DB" \
      -p "127.0.0.1:$PG_PORT:5432" -v nos-brainer-postgres:/var/lib/postgresql/data \
      postgres:16-alpine >/dev/null
  fi
  i=0
  until docker exec "$CONTAINER" pg_isready -U "$PG_USER" -d "$PG_DB" >/dev/null 2>&1; do
    i=$((i + 1)); [ "$i" -lt 60 ] || fail "Postgres (Docker) ne répond pas : docker logs $CONTAINER"
    sleep 1
  done
  say "Postgres (Docker) prêt sur le port $PG_PORT."
}

# ---------- Postgres privé ----------
platform() {
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) echo darwin-arm64v8 ;;
    Darwin-x86_64) echo darwin-amd64 ;;
    Linux-x86_64) echo linux-amd64 ;;
    Linux-aarch64 | Linux-arm64) echo linux-arm64v8 ;;
    *) fail "Système non géré pour le Postgres privé ($(uname -s) $(uname -m)) : installe Docker, ou renseigne DATABASE_URL dans .env." ;;
  esac
}

private_install() {
  [ -x "$PRIVATE/bin/postgres" ] && return
  [ "$(id -u)" != "0" ] || fail "Postgres refuse de tourner en root : lance make avec ton utilisateur."
  p=$(platform)
  base="https://repo1.maven.org/maven2/io/zonky/test/postgres/embedded-postgres-binaries-$p/$PG_VERSION/embedded-postgres-binaries-$p-$PG_VERSION.jar"
  tmp="$PRIVATE.download"
  rm -rf "$tmp"; mkdir -p "$tmp"
  say "Postgres privé : téléchargement de Postgres $PG_VERSION ($p, ~15 Mo) dans $PRIVATE…"
  curl -fsSL --retry 3 -o "$tmp/pg.jar" "$base" || fail "Téléchargement impossible : $base"
  want=$(curl -fsSL --retry 3 "$base.sha1" | cut -c1-40) || fail "Empreinte introuvable : $base.sha1"
  if command -v sha1sum >/dev/null 2>&1; then got=$(sha1sum "$tmp/pg.jar" | cut -c1-40); else got=$(shasum -a 1 "$tmp/pg.jar" | cut -c1-40); fi
  [ "$got" = "$want" ] || { rm -rf "$tmp"; fail "Le téléchargement ne correspond pas à son empreinte officielle : arrêt."; }
  if command -v unzip >/dev/null 2>&1; then unzip -q -o "$tmp/pg.jar" -d "$tmp/jar"
  else python3 -c "import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])" "$tmp/pg.jar" "$tmp/jar"; fi
  mkdir -p "$tmp/pg"
  tar -xJf "$tmp"/jar/postgres-*.txz -C "$tmp/pg"
  rm -rf "$PRIVATE"; mkdir -p "$(dirname "$PRIVATE")"
  mv "$tmp/pg" "$PRIVATE"; rm -rf "$tmp"
}

pg_ctl_() { "$PRIVATE/bin/pg_ctl" -D "$PRIVATE/data" "$@"; }
private_running() { [ -f "$PRIVATE/data/postmaster.pid" ] && pg_ctl_ status >/dev/null 2>&1; }

private_start() {
  if private_running; then say "Postgres privé tourne déjà sur le port $PG_PORT."; return; fi
  port_busy "$PG_PORT" && fail "Le port $PG_PORT est déjà pris : choisis-en un autre avec POSTGRES_PORT dans .env, puis relance."
  private_install
  if [ ! -f "$PRIVATE/data/PG_VERSION" ]; then
    say "Postgres privé : création de la base « $PG_DB »…"
    pw="$PRIVATE/.pw"; printf '%s\n' "$PG_PASSWORD" >"$pw"; chmod 600 "$pw"
    "$PRIVATE/bin/initdb" -D "$PRIVATE/data" -U "$PG_USER" --pwfile="$pw" -E UTF8 --no-locale \
      --auth-local=trust --auth-host=scram-sha-256 >"$PRIVATE/initdb.log" 2>&1 || fail "initdb a échoué : $PRIVATE/initdb.log"
    rm -f "$pw"
    printf 'CREATE DATABASE "%s";\n' "$PG_DB" | "$PRIVATE/bin/postgres" --single -D "$PRIVATE/data" postgres >/dev/null 2>&1 \
      || fail "Création de la base « $PG_DB » impossible."
  fi
  # Connexion en TCP seulement : pas de socket Unix, dont le chemin ne doit pas dépasser 107 caractères (dossiers profonds).
  pg_ctl_ -l "$PRIVATE/postgres.log" -w -t 60 -o "-p $PG_PORT -k '' -c listen_addresses=127.0.0.1" start >/dev/null \
    || fail "Postgres privé ne démarre pas : $PRIVATE/postgres.log"
  say "Postgres privé prêt sur le port $PG_PORT (données : $PRIVATE/data)."
}

private_stop() { if private_running; then pg_ctl_ -m fast stop >/dev/null && say "Postgres privé arrêté."; else say "Postgres privé : déjà arrêté."; fi; }

# ---------- Commandes ----------
m=$(mode)
case "${1:-}" in
  start)
    case "$m" in
      external) say "Base existante (DATABASE_URL dans .env) : rien à démarrer." ;;
      docker) docker_start ;;
      private) private_start ;;
    esac ;;
  stop)
    case "$m" in
      external) say "Base existante : rien à arrêter." ;;
      docker) if docker_running; then docker stop "$CONTAINER" >/dev/null && say "Postgres (Docker) arrêté."; else say "Postgres (Docker) : déjà arrêté."; fi ;;
      private) private_stop ;;
    esac ;;
  status)
    case "$m" in
      external) say "Base : existante (DATABASE_URL)." ;;
      docker) if docker_running; then say "Base : Postgres (Docker), port $PG_PORT, en marche."; else say "Base : Postgres (Docker), arrêté."; fi ;;
      private) if private_running; then say "Base : Postgres privé, port $PG_PORT, en marche."; else say "Base : Postgres privé, arrêté."; fi ;;
    esac ;;
  reset)
    case "$m" in
      external) fail "Base existante : make db-reset ne touche pas à une base que tu as fournie." ;;
      docker) docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; docker volume rm nos-brainer-postgres >/dev/null 2>&1 || true; say "Postgres (Docker) effacé." ;;
      private) private_stop; rm -rf "$PRIVATE/data"; say "Données du Postgres privé effacées (binaires gardés)." ;;
    esac ;;
  url)
    if [ "$m" = external ]; then say "$DATABASE_URL"; else say "postgresql://$PG_USER:$PG_PASSWORD@127.0.0.1:$PG_PORT/$PG_DB"; fi ;;
  mode) say "$m" ;;
  *) fail "Usage : sh scripts/local-db.sh start|stop|status|reset|url|mode" ;;
esac
