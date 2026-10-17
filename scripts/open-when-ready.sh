#!/bin/sh
# Ouvre le navigateur sur le cerveau dès que le serveur répond (lancé en arrière-plan par `make dev`).
# BRAIN_OPEN=0 dans .env pour ne rien ouvrir.
url=$1
[ "${BRAIN_OPEN:-1}" = "0" ] && exit 0
i=0
until curl -fsS -o /dev/null --max-time 2 "$url/api/health" 2>/dev/null; do
  i=$((i + 1)); [ "$i" -lt 300 ] || exit 0
  sleep 1
done
case "$(uname -s)" in
  Darwin) open "$url" ;;
  *) command -v xdg-open >/dev/null 2>&1 && xdg-open "$url" >/dev/null 2>&1 ;;
esac || true
