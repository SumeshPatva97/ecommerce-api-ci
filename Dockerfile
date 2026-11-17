# ecommerce-api — Dockerfile (B0-c scaffold)
# NOTE: This is an infrastructure scaffold prepared during Phase 4. Validate image build,
# runtime env injection, healthchecks, and DB/provider connectivity in the target environment
# before any deployment claim. Do not bake secrets into the image.

FROM node:22-alpine AS base
WORKDIR /app
ENV NODE_ENV=production

FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev=false

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Prisma client generation may require DATABASE_URL at build-time in some setups; provide a
# placeholder only if needed for offline-safe generate in CI/build contexts. Runtime must use
# real env-injected configuration.
RUN npm run build

FROM base AS runtime
# Run as non-root
RUN addgroup -S app && adduser -S app -G app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# Prisma schema/config and any runtime assets required by adapters/migrations tooling (review before deploy)
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/prisma.config.ts ./prisma.config.ts
USER app
EXPOSE 4000
# Liveness endpoint; readiness (/health/ready) should be used by orchestrators once DB checks are wired.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD wget -qO- http://127.0.0.1:4000/health/live || exit 1
CMD ["node", "dist/server.js"]
