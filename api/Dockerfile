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

# The bundled CLI tools the agent shells out to (firecrawl, playwright-cli),
# installed from the SAME pinned list the desktop ships (cli-tools/package.json)
# so a turn behaves identically in the app, from Telegram, and on a schedule.
# The desktop reaches them through generated shims because Electron ships no
# Node (src/main/cliTools.ts); here there is a real Node, so node_modules/.bin
# on PATH is the whole mechanism — no shims, no NODE_OPTIONS preload.
COPY cli-tools/package.json cli-tools/package-lock.json ./cli-tools/
RUN cd /app/cli-tools && npm ci --omit=dev --no-audit --no-fund
ENV PATH=/app/cli-tools/node_modules/.bin:$PATH

# Chromium, baked in at BUILD time so no run ever downloads a browser.
#
# The browser folder is named after the revision the bundled playwright pins —
# `<PLAYWRIGHT_BROWSERS_PATH>/chromium_headless_shell-<revision>` — and the CLI
# looks in that exact folder and nowhere else. Two consequences, both load-bearing:
#
#  1. This MUST be installed by the cli-tools tree above, never a separately
#     fetched playwright. A different playwright pins a different revision, names
#     a different folder, and every launch then fails with "Executable doesn't
#     exist" (it is a hard error, never a silently wrong browser).
#  2. Bumping @playwright/cli in cli-tools/package.json changes that folder name,
#     which makes an already-baked browser invisible. This line re-bakes on the
#     same rebuild, which is why there is ONE pinned list for both hosts.
#
# Installed in place by the real installer, never copied in: the folder carries an
# INSTALLATION_COMPLETE marker that is how the CLI knows it is really there, and
# hand-copying loses it and triggers a download. The download and the on-disk
# layout also differ per arch (linux-x64 unpacks chrome-headless-shell-linux64/,
# linux-arm64 unpacks chrome-linux/), so each arch of the multi-arch build bakes
# its own — Debian 12 has a published build for both.
#
# --with-deps installs the system libraries chromium needs (playwright verifies
# them at launch), so there is no hand-maintained apt list here to drift.
#
# NOT `--only-shell`. That installs chromium-headless-shell, which this CLI never
# launches: `playwright-cli open` resolves `chromium` to the **chrome-for-testing**
# build (the `chromium` descriptor, title "Chrome for Testing"), and with the shell
# alone it fails with `Browser "chrome-for-testing" is not installed`. The shell is
# the right choice for the playwright *library*, not for this CLI. Verified live.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN playwright-cli install-browser chromium --with-deps \
  && rm -rf /var/lib/apt/lists/* \
  && chown -R node:node /ms-playwright

# The CLI's default browser is the **chrome channel** — real Google Chrome at
# /opt/google/chrome — which is not installed and is not what we baked, so a bare
# `playwright-cli open` fails with "Chromium distribution 'chrome' is not found".
# Point the default at what is actually here, so the agent never has to pass
# `--browser chromium` and the skill never has to teach it to. The CLI reads this
# wherever `--browser` is omitted (`resolveExtensionOptions` in playwright-core).
ENV PLAYWRIGHT_MCP_BROWSER=chromium

# The runtime files that live on the HOST rather than inside a container: the
# compose file, traefik's static config, the updater scripts, the `shockwave`
# command, and init.sql. They ride in the image so that a release is ONE
# artifact — install.sh and updater/apply.sh copy this directory out of the
# tagged image instead of fetching a hardcoded file list from GitHub.
#
# The list was the problem. It lived in a script ON THE SERVER, frozen at
# whatever release that box last installed, so removing a runtime file from the
# repo made every older box fetch a 404 and abort — permanently, because the
# step that replaces the script is the one that never ran. Deleting
# traefik/gen-router.sh in v1.0.85 did exactly that to every box on v1.0.84.
#
# Copying them out of the image instead means the file set always comes from the
# release being installed, there is nothing on the server to go stale, and the
# host files cannot disagree with the image they are configuring — they were
# built from the same commit. The layout under /host-files mirrors the install
# directory exactly, so extracting is a straight copy with no mapping to keep
# in step.
COPY api/docker-compose.yml api/init.sql /host-files/
COPY api/traefik/traefik.yml /host-files/traefik/
COPY api/updater/ /host-files/updater/
COPY api/host/ /host-files/host/

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
# Traefik's dynamic config dir, for the same reason and by the same mechanism:
# the api writes the certificate + tls.yml + router.yml here and Traefik reads
# them, so a fresh root-owned volume would fail every write with EACCES — and
# settleTls treats that as fatal, so the server would not start. A one-shot
# sidecar used to chown this at runtime; owning it in the image removes the
# sidecar and the ordering it implied.
RUN mkdir -p /etc/traefik/dynamic && chown -R node:node /etc/traefik
USER node
# Fail the BUILD, not the first Telegram message, if the agent's CLIs aren't
# usable. Run AS `node` — the user the agent's shell actually runs as — so a
# permission or ownership mistake surfaces here rather than at 3am.
RUN firecrawl --version && playwright-cli --version
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
