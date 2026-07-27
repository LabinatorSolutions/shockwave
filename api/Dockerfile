# syntax=docker/dockerfile:1
# Build context is the REPO ROOT (see docker-compose.yml) so we can pull in
# ../agent-core, the shared agent runtime the companion bundles.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY api/package*.json ./
RUN npm install --no-audit --no-fund
COPY api/ ./
# agent-core must sit where ../../agent-core resolves from /app/src (i.e. /agent-core).
COPY agent-core/ /agent-core/
RUN npm run build          # esbuild bundles src + agent-core -> dist/server.js
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=8080
WORKDIR /app
# git + CA certs: the cron runner shallow-clones workspace repos over HTTPS.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/init.sql ./init.sql
RUN chown -R node:node /app
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
