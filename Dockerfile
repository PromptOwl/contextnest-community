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

ENV PORT=3838
# Route outbound fetch through HTTPS_PROXY / HTTP_PROXY (honouring NO_PROXY) when
# they are set; a no-op otherwise. See CONFIGURATION.md → Corporate egress proxy.
ENV NODE_USE_ENV_PROXY=1
ENV DATA_ROOT=/data

# Run as the image's built-in non-root `node` user (uid/gid 1000), which owns
# /data. The ownership must be set before VOLUME: changes to a volume path
# after it is declared are discarded. The numeric USER lets Kubernetes verify
# `runAsNonRoot` without a separate runAsUser. A bind mount or a volume created
# by an older root image may hold root-owned files: `chown -R 1000:1000` it once.
RUN mkdir -p /data && chown 1000:1000 /data
USER 1000:1000

VOLUME ["/data"]
EXPOSE 3838

CMD ["node", "dist/index.js"]
