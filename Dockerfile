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

VOLUME ["/data"]
EXPOSE 3838

CMD ["node", "dist/index.js"]
