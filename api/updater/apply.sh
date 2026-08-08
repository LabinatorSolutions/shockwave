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
#   1. Fetch this tag's runtime files into a staging dir (all-or-nothing).
#   2. Pull the tag's api image USING THE STAGED compose file — nothing on
#      disk changes until the image is on the box, so a failed pull can't
#      leave .env pinned to an image that doesn't exist.
#   3. mv the staged files into place (rename — never cp: this very script is
#      one of the files, and an in-place overwrite would corrupt the copy the
#      shell is still reading; rename swaps the inode, our fd keeps the old one).
#   4. Persist SHOCKWAVE_TAG=<tag> in .env, then docker compose up -d.
#
# SHOCKWAVE_RAW_BASE overrides the fetch source for testing (file:// or http),
# same hook as install.sh. Note the override ignores the tag by design.
# ============================================================================
set -eu

TAG="${1:?usage: apply.sh <tag>}"
COMPANION_DIR="${COMPANION_DIR:-/opt/shockwave-companion}"
REPO="stephengpope/shockwave"
RAW="${SHOCKWAVE_RAW_BASE:-https://raw.githubusercontent.com/$REPO/$TAG/api}"

# Second line of defense (the api validates too; watch.sh again): the tag lands
# in a URL and in .env — nothing but a plain version tag may pass.
echo "$TAG" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$' || { echo "apply: invalid tag"; exit 1; }

# Every runtime file that lives on the host. `host/shockwave` is the command on
# PATH: /usr/local/bin/shockwave is a symlink to it, made once at install, so
# replacing this file IS how a command update reaches the box — no write outside
# $COMPANION_DIR (the only thing mounted here) and no new symlink, ever.
FILES="docker-compose.yml traefik/traefik.yml updater/watch.sh updater/apply.sh host/shockwave"
# Files that are executed directly rather than via `sh <file>`, so their mode
# matters. `curl -o` writes 644 and `mv` preserves it — without this the command
# on PATH would land unrunnable.
EXECUTABLE="host/shockwave"

fetch() { # fetch <relpath> <dest>
  case "$RAW" in
    file://*) cp "${RAW#file://}/$1" "$2" ;;
    *)
      # docker:cli is alpine; busybox wget's TLS support is shaky, so use curl
      # (installed below).
      curl -fsSL "$RAW/$1" -o "$2"
      ;;
  esac
}

case "$RAW" in
  file://*) : ;;
  *) command -v curl >/dev/null 2>&1 || apk add --no-cache --quiet curl ;;
esac

echo "apply: upgrading to $TAG (source: $RAW)"

# ── 1. Stage ────────────────────────────────────────────────────────────────
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
for f in $FILES; do
  mkdir -p "$STAGE/$(dirname "$f")"
  fetch "$f" "$STAGE/$f" || { echo "apply: failed to fetch $f — aborting, nothing changed"; exit 1; }
done
echo "apply: files staged"

# ── 2. Pull the new image (staged compose — disk still untouched) ──────────
ENV_FILE="$COMPANION_DIR/.env"
[ -f "$ENV_FILE" ] || { echo "apply: no .env at $ENV_FILE — aborting"; exit 1; }
export COMPANION_DIR
SHOCKWAVE_TAG="$TAG" docker compose --project-directory "$COMPANION_DIR" -f "$STAGE/docker-compose.yml" pull api \
  || { echo "apply: image pull failed — aborting, nothing changed"; exit 1; }
echo "apply: image pulled"

# ── 3. Move files into place ────────────────────────────────────────────────
for f in $FILES; do
  mkdir -p "$COMPANION_DIR/$(dirname "$f")"
  mv "$STAGE/$f" "$COMPANION_DIR/$f"
done
for f in $EXECUTABLE; do
  chmod 755 "$COMPANION_DIR/$f"
done

# ── 4. Pin the tag in .env + restart ────────────────────────────────────────
grep -v '^SHOCKWAVE_TAG=' "$ENV_FILE" > "$ENV_FILE.tmp" || true
echo "SHOCKWAVE_TAG=$TAG" >> "$ENV_FILE.tmp"
chmod 600 "$ENV_FILE.tmp"
mv "$ENV_FILE.tmp" "$ENV_FILE"
echo "apply: SHOCKWAVE_TAG=$TAG pinned"
docker compose --project-directory "$COMPANION_DIR" -f "$COMPANION_DIR/docker-compose.yml" up -d --remove-orphans
echo "apply: done — companion is on $TAG"
