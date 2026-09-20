FROM node:22-slim AS builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN corepack enable && npm ci
COPY . .
RUN npm run build

FROM node:22-slim AS runtime

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

VOLUME ["/data"]
EXPOSE 3838

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3838)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
