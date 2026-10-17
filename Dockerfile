# syntax=docker/dockerfile:1
# Self-hosted company brain: Next.js dashboard + API + brain.mjs client (served on /brain.mjs), in one image.
# Run by compose.yaml behind Caddy (local HTTPS) with Postgres; see docs/LOCAL.md.

FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
# The manifests first (Docker cache), then npm ci from the monorepo root (workspaces).
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY apps/client/package.json apps/client/
COPY packages/core/package.json packages/core/
RUN npm ci --no-audit --no-fund
COPY . .
# `next build` also builds brain.mjs (prebuild of @brain/web). The Google fonts are fetched at build time.
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000
COPY --from=build /app /app
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["sh", "deploy/local/entrypoint.sh"]
