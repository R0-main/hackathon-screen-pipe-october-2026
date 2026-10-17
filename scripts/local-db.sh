#!/bin/sh
# The brain's local Postgres, for `make dev`: no questions, no administrator rights.
#
#   sh scripts/local-db.sh start | stop | status | reset | url
#
# With DATABASE_URL set in .env: existing database, nothing to start here.
# Otherwise, Docker if it answers without sudo (container nos-brainer-postgres, data in a Docker volume);
# otherwise a private Postgres downloaded into the repository's .local/postgres (official Maven Central binaries,
# SHA-1 checksum verified): works on a computer without Docker or admin rights (42 school).
# LOCAL_DB=docker or LOCAL_DB=private forces a mode.
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

# Port already taken on 127.0.0.1? (Node.js is required by the project anyway.)
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
  if docker_running; then say "Postgres (Docker) is already running on port $PG_PORT."; return; fi
  if docker inspect "$CONTAINER" >/dev/null 2>&1; then
    docker start "$CONTAINER" >/dev/null
  else
    port_busy "$PG_PORT" && fail "Port $PG_PORT is already taken: pick another one with POSTGRES_PORT in .env, then run again."
    say "Postgres (Docker): creating container $CONTAINER on port $PG_PORT…"
    docker run -d --name "$CONTAINER" \
      -e POSTGRES_USER="$PG_USER" -e POSTGRES_PASSWORD="$PG_PASSWORD" -e POSTGRES_DB="$PG_DB" \
      -p "127.0.0.1:$PG_PORT:5432" -v nos-brainer-postgres:/var/lib/postgresql/data \
      postgres:16-alpine >/dev/null
  fi
  i=0
  until docker exec "$CONTAINER" pg_isready -U "$PG_USER" -d "$PG_DB" >/dev/null 2>&1; do
    i=$((i + 1)); [ "$i" -lt 60 ] || fail "Postgres (Docker) does not answer: docker logs $CONTAINER"
    sleep 1
  done
  say "Postgres (Docker) ready on port $PG_PORT."
}

# ---------- Private Postgres ----------
platform() {
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) echo darwin-arm64v8 ;;
    Darwin-x86_64) echo darwin-amd64 ;;
    Linux-x86_64) echo linux-amd64 ;;
    Linux-aarch64 | Linux-arm64) echo linux-arm64v8 ;;
    *) fail "System not supported for the private Postgres ($(uname -s) $(uname -m)): install Docker, or set DATABASE_URL in .env." ;;
  esac
}

private_install() {
  [ -x "$PRIVATE/bin/postgres" ] && return
  [ "$(id -u)" != "0" ] || fail "Postgres refuses to run as root: run make as your own user."
  p=$(platform)
  base="https://repo1.maven.org/maven2/io/zonky/test/postgres/embedded-postgres-binaries-$p/$PG_VERSION/embedded-postgres-binaries-$p-$PG_VERSION.jar"
  tmp="$PRIVATE.download"
  rm -rf "$tmp"; mkdir -p "$tmp"
  say "Private Postgres: downloading Postgres $PG_VERSION ($p, ~15 MB) into $PRIVATE…"
  curl -fsSL --retry 3 -o "$tmp/pg.jar" "$base" || fail "Download failed: $base"
  want=$(curl -fsSL --retry 3 "$base.sha1" | cut -c1-40) || fail "Checksum not found: $base.sha1"
  if command -v sha1sum >/dev/null 2>&1; then got=$(sha1sum "$tmp/pg.jar" | cut -c1-40); else got=$(shasum -a 1 "$tmp/pg.jar" | cut -c1-40); fi
  [ "$got" = "$want" ] || { rm -rf "$tmp"; fail "The download does not match its official checksum: stopping."; }
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
  if private_running; then say "Private Postgres is already running on port $PG_PORT."; return; fi
  port_busy "$PG_PORT" && fail "Port $PG_PORT is already taken: pick another one with POSTGRES_PORT in .env, then run again."
  private_install
  if [ ! -f "$PRIVATE/data/PG_VERSION" ]; then
    say "Private Postgres: creating database \"$PG_DB\"…"
    pw="$PRIVATE/.pw"; printf '%s\n' "$PG_PASSWORD" >"$pw"; chmod 600 "$pw"
    "$PRIVATE/bin/initdb" -D "$PRIVATE/data" -U "$PG_USER" --pwfile="$pw" -E UTF8 --no-locale \
      --auth-local=trust --auth-host=scram-sha-256 >"$PRIVATE/initdb.log" 2>&1 || fail "initdb failed: $PRIVATE/initdb.log"
    rm -f "$pw"
    printf 'CREATE DATABASE "%s";\n' "$PG_DB" | "$PRIVATE/bin/postgres" --single -D "$PRIVATE/data" postgres >/dev/null 2>&1 \
      || fail "Could not create database \"$PG_DB\"."
  fi
  # TCP connection only: no Unix socket, whose path must not exceed 107 characters (deep folders).
  pg_ctl_ -l "$PRIVATE/postgres.log" -w -t 60 -o "-p $PG_PORT -k '' -c listen_addresses=127.0.0.1" start >/dev/null \
    || fail "Private Postgres does not start: $PRIVATE/postgres.log"
  say "Private Postgres ready on port $PG_PORT (data: $PRIVATE/data)."
}

private_stop() { if private_running; then pg_ctl_ -m fast stop >/dev/null && say "Private Postgres stopped."; else say "Private Postgres: already stopped."; fi; }

# ---------- Commands ----------
m=$(mode)
case "${1:-}" in
  start)
    case "$m" in
      external) say "Existing database (DATABASE_URL in .env): nothing to start." ;;
      docker) docker_start ;;
      private) private_start ;;
    esac ;;
  stop)
    case "$m" in
      external) say "Existing database: nothing to stop." ;;
      docker) if docker_running; then docker stop "$CONTAINER" >/dev/null && say "Postgres (Docker) stopped."; else say "Postgres (Docker): already stopped."; fi ;;
      private) private_stop ;;
    esac ;;
  status)
    case "$m" in
      external) say "Database: existing (DATABASE_URL)." ;;
      docker) if docker_running; then say "Database: Postgres (Docker), port $PG_PORT, running."; else say "Database: Postgres (Docker), stopped."; fi ;;
      private) if private_running; then say "Database: private Postgres, port $PG_PORT, running."; else say "Database: private Postgres, stopped."; fi ;;
    esac ;;
  reset)
    case "$m" in
      external) fail "Existing database: make db-reset does not touch a database you provided." ;;
      docker) docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; docker volume rm nos-brainer-postgres >/dev/null 2>&1 || true; say "Postgres (Docker) erased." ;;
      private) private_stop; rm -rf "$PRIVATE/data"; say "Private Postgres data erased (binaries kept)." ;;
    esac ;;
  url)
    if [ "$m" = external ]; then say "$DATABASE_URL"; else say "postgresql://$PG_USER:$PG_PASSWORD@127.0.0.1:$PG_PORT/$PG_DB"; fi ;;
  mode) say "$m" ;;
  *) fail "Usage: sh scripts/local-db.sh start|stop|status|reset|url|mode" ;;
esac
