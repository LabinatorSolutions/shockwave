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
# The release tag this image was built from (CI passes it; 'dev' for local
# builds). Surfaced by GET /health so clients can spot a stale companion.
ARG VERSION=dev
ENV NODE_ENV=production PORT=8080 APP_VERSION=$VERSION
WORKDIR /app
# git + CA certs: the cron runner shallow-clones workspace repos over HTTPS.
#
# openssl is named EXPLICITLY even though ca-certificates already depends on it.
# The `openssl` CLI is load-bearing twice over: selfSigned.ts shells out to it to
# create and inspect the TLS certificate, and that now happens at boot where a
# failure is fatal (settleTls in server.ts). `shockwave-fingerprint` runs it in
# this container too. Relying on it arriving transitively means a future base-image
# or dependency change turns "the server won't start" into the first symptom.
#
# The rest is for working with files the user sends. The base image is bare —
# it has tar and gzip and nothing else — so without these the agent cannot open
# a zip or read a PDF, and the attachment notes that tell it to "extract the text
# yourself" are instructions it has no way to follow.
#   unzip/zip/p7zip-full/xz-utils/bzip2 — archives (tar+gzip alone can't do .zip)
#   poppler-utils                       — pdftotext, and pdftoppm to render a page
#                                         as an image when a PDF has no text layer
#   imagemagick                         — convert and resize, including shrinking
#                                         an image that exceeds a model's limit
#   ffmpeg                              — audio and video
#   pandoc                              — docx/odt/rtf/epub to text
#   python3 + openpyxl + pil            — spreadsheets, and general scripting
#   file                                — identify an upload with no useful name
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates openssl \
      unzip zip p7zip-full xz-utils bzip2 \
      poppler-utils imagemagick ffmpeg pandoc \
      python3 python3-openpyxl python3-pil file \
  && rm -rf /var/lib/apt/lists/*
# Fail the BUILD, not the first boot, if the CLI isn't actually there.
RUN openssl version
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/init.sql ./init.sql
# Same bundled built-in skills the desktop ships, so the server agent is identical.
COPY resources/built-in-skills/ ./built-in-skills/
ENV BUILTIN_SKILLS_DIR=/app/built-in-skills
RUN chown -R node:node /app
# pi's scratch dir (AGENT_DATA_DIR). Created + owned HERE so the named volume
# mounted over it inherits this ownership on first use — a fresh volume is
# root-owned otherwise, and the server runs as `node`, so every run would fail
# with EACCES trying to create its working dir.
RUN mkdir -p /data/agent && chown -R node:node /data
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
