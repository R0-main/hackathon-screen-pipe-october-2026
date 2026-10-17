#!/bin/sh
# Démarrage du conteneur « brain » : migrations (chacune une seule fois), puis le dashboard.
set -eu
cd /app
echo "Base de données : migrations"
npm run --silent db:migrate -w @brain/web
echo "Cerveau : démarrage sur le port ${PORT:-3000}"
cd /app/apps/web
exec node "$(node -p "require.resolve('next/dist/bin/next')")" start -p "${PORT:-3000}"
