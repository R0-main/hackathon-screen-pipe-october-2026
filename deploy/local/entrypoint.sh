#!/bin/sh
# Start of the "brain" container: migrations (each one only once), then the dashboard.
set -eu
cd /app
echo "Database: migrations"
npm run --silent db:migrate -w @brain/web
echo "Brain: starting on port ${PORT:-3000}"
cd /app/apps/web
exec node "$(node -p "require.resolve('next/dist/bin/next')")" start -p "${PORT:-3000}"
