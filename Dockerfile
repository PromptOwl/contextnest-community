FROM node:22-slim AS builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN corepack enable && npm ci
COPY . .
RUN npm run build
# Drop the devDependencies (tsup, vite, vitest, typescript, …) before they
# reach the runtime layer. tsup bundles anything outside `dependencies` into
# dist, so only the prod deps are actually loaded at run time.
RUN npm prune --omit=dev

FROM node:22-slim AS runtime

# Published to Docker Hub — the release workflow passes VERSION.
ARG VERSION=dev
LABEL org.opencontainers.image.title="ContextNest Community" \
      org.opencontainers.image.description="Self-hosted context governance server for AI workflows" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.source="https://github.com/PromptOwl/contextnest-community" \
      org.opencontainers.image.documentation="https://github.com/PromptOwl/contextnest-community/blob/main/CONFIGURATION.md" \
      org.opencontainers.image.vendor="Promptowl LLC" \
      org.opencontainers.image.licenses="SEE LICENSE IN LICENSE.md"

WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

# Defaults for a stock deployment. Everything here is overridable with
# `docker run -e` / compose; see CONFIGURATION.md for the full reference.
ENV NODE_ENV=production \
    PORT=3838 \
    DATA_ROOT=/data \
    AUTH_MODE=key \
    TELEMETRY_ENABLED=true \
    POSTHOG_KEY= \
    POSTHOG_HOST=

# PROMPTOWL_KEY is deliberately unset — supply the license key at run time.

# Run unprivileged; `node` (uid 1000) ships with the base image. /data is
# created and chowned here so a fresh named volume inherits that ownership.
# A host bind mount keeps the host's owner instead — chown it to 1000 there,
# or the server can't write the DB, the vault, or $DATA_ROOT/.env.
RUN mkdir -p /data && chown -R node:node /data
USER node

VOLUME ["/data"]
EXPOSE 3838

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3838)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
