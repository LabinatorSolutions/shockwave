#!/bin/sh
# ============================================================================
# Updater helper — performs one companion upgrade to the given release tag.
# Runs in a detached one-shot docker:27-cli container spawned by watch.sh,
# with the docker socket and $COMPANION_DIR (the install dir) mounted at the
# SAME path as on the host — compose hands bind-mount paths to dockerd, which
# resolves them on the host, so the paths must be identical.
#
#   sh apply.sh v1.2.3
#
# Steps (each aborts the upgrade and leaves the running stack untouched):
#   1. Pull the tag's image. Nothing on disk changes until it is on the box, so
#      a failed pull can't leave .env pinned to an image that doesn't exist.
#   2. Copy the host files OUT of that image into a staging dir.
#   3. mv them into place (rename — never cp: this very script is one of the
#      files, and an in-place overwrite would corrupt the copy the shell is
#      still reading; rename swaps the inode, our fd keeps the old one).
#   4. Persist SHOCKWAVE_TAG=<tag> in .env, then docker compose up -d.
#
# THERE IS NO FILE LIST HERE, and that is the point. It used to fetch a fixed
# set of paths from raw.githubusercontent — a list baked into whatever copy of
# this script the box happened to be holding, which is the release it LAST
# installed. So deleting a runtime file from the repo made every older box 404
# and abort forever: the step that would have replaced this script (3) is
# downstream of the fetch that fails. Removing traefik/gen-router.sh in v1.0.85
# jammed every box still on v1.0.84, with the desktop reporting success.
#
# Taking the files from the image inverts that. The set comes from the release
# being INSTALLED rather than the one already installed, so adding or removing
# a runtime file is no longer a breaking change; there is nothing on the server
# that can be stale; the host files can never disagree with the image they
# configure; and upgrading no longer depends on GitHub being reachable.
#
# SHOCKWAVE_IMAGE overrides the image for testing (e.g. a locally built tag).
# ============================================================================
set -eu

TAG="${1:?usage: apply.sh <tag>}"
COMPANION_DIR="${COMPANION_DIR:-/opt/shockwave-companion}"
IMAGE="${SHOCKWAVE_IMAGE:-ghcr.io/stephengpope/shockwave-companion}"
# Where the image keeps the host files (api/Dockerfile). Mirrors the install
# directory's layout, so extraction is a straight copy.
IMAGE_HOST_DIR=/host-files

# Second line of defense (the api validates too; watch.sh again): the tag lands
# in an image reference and in .env — nothing but a plain version tag may pass.
echo "$TAG" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$' || { echo "apply: invalid tag"; exit 1; }

ENV_FILE="$COMPANION_DIR/.env"
[ -f "$ENV_FILE" ] || { echo "apply: no .env at $ENV_FILE — aborting"; exit 1; }

echo "apply: upgrading to $TAG (image: $IMAGE:$TAG)"

# ── 1. Pull the new image (disk still untouched) ────────────────────────────
docker pull "$IMAGE:$TAG" \
  || { echo "apply: image pull failed — aborting, nothing changed"; exit 1; }
echo "apply: image pulled"

# ── 2. Copy the host files out of it ────────────────────────────────────────
# The staging dir sits INSIDE the install dir on purpose: step 3 has to be a
# rename to avoid rewriting this running script in place, and rename only works
# within one filesystem. $COMPANION_DIR is a bind mount, so a staging dir in the
# container's own /tmp would make every `mv` a cross-device copy — which opens
# the destination and truncates it, exactly the corruption the rename avoids.
STAGE=$(mktemp -d "$COMPANION_DIR/.upgrade-XXXXXX")
CID=""
cleanup() {
  [ -n "$CID" ] && docker rm -f "$CID" >/dev/null 2>&1
  rm -rf "$STAGE"
}
trap cleanup EXIT

CID=$(docker create "$IMAGE:$TAG") \
  || { echo "apply: could not create a container from the image — aborting, nothing changed"; exit 1; }
docker cp "$CID:$IMAGE_HOST_DIR/." "$STAGE/" \
  || { echo "apply: image has no $IMAGE_HOST_DIR (released before this mechanism?) — aborting, nothing changed"; exit 1; }
echo "apply: host files extracted"

# ── 3. Move them into place ─────────────────────────────────────────────────
# Discovered from what the image actually shipped, never from a list here.
STAGED=$(cd "$STAGE" && find . -type f | sed 's|^\./||')
[ -n "$STAGED" ] || { echo "apply: $IMAGE_HOST_DIR is empty — aborting, nothing changed"; exit 1; }
for rel in $STAGED; do
  mkdir -p "$COMPANION_DIR/$(dirname "$rel")"
  mv "$STAGE/$rel" "$COMPANION_DIR/$rel"
done
# `docker cp` preserves the mode it was built with, so the dispatcher arrives
# executable already. Asserted anyway — /usr/local/bin/shockwave is a symlink to
# it, and a file that lands 644 is a command that reports "permission denied"
# with nothing to say why.
chmod 755 "$COMPANION_DIR/host/shockwave"

# ── 4. Pin the tag in .env + restart ────────────────────────────────────────
grep -v '^SHOCKWAVE_TAG=' "$ENV_FILE" > "$ENV_FILE.tmp" || true
echo "SHOCKWAVE_TAG=$TAG" >> "$ENV_FILE.tmp"
chmod 600 "$ENV_FILE.tmp"
mv "$ENV_FILE.tmp" "$ENV_FILE"
echo "apply: SHOCKWAVE_TAG=$TAG pinned"
docker compose --project-directory "$COMPANION_DIR" -f "$COMPANION_DIR/docker-compose.yml" up -d --remove-orphans
echo "apply: done — companion is on $TAG"
