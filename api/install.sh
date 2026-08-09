#!/bin/sh
# ============================================================================
# Shockwave companion installer (Linux)
# ============================================================================
# One-liner install / update:
#
#   curl -fsSL https://raw.githubusercontent.com/stephengpope/shockwave/main/api/install.sh | sh
#
# Options (append: | sh -s -- --domain=notes.example.com --cert-email=you@x.com --yes):
#   --domain=HOST      COMPANION_DOMAIN (real domain or ngrok host). Empty (the
#                      default) = self-signed cert on the box's public IP.
#                      Works on a RE-RUN too, to add a domain later.
#   --cert-email=ADDR  Where Let's Encrypt sends expiry warnings (with --domain).
#   --yes              Non-interactive: no prompts, install docker if missing.
#   --no-firewall      Skip the ufw setup.
#
# What it does:
#   1. Installs docker (via get.docker.com) if missing.
#   2. Sets up ufw: deny inbound, allow SSH + 80/443 (skippable, see above).
#   3. Pulls the image and copies the host files out of it (compose file,
#      traefik config, init.sql, updater scripts, the `shockwave` command) into
#      /opt/shockwave-companion. They ship in the image, so they always match
#      the server they configure and there is no file list to go stale.
#   4. Generates .env secrets on first run (never overwritten after that), and
#      records this server's public address as COMPANION_HOST.
#   5. docker compose up -d  — pulls ghcr.io/stephengpope/shockwave-companion.
#   6. Waits for /health, then runs `shockwave check` — which tests the address,
#      certificate and API key the desktop will actually use (the wait itself
#      only proves the api container can talk to itself on a local port).
#   7. Prints the server URL, API key, and — with no domain — the certificate
#      fingerprint you approve in the desktop app.
#   8. Installs the `shockwave` command on PATH (subcommands: check, fingerprint,
#      rotate-cert, status, logs, version).
#
# Re-running is the update path AND the recovery path: it pulls `latest`,
# refreshes the host files from it, releases any SHOCKWAVE_TAG a remote upgrade
# pinned, and recreates changed containers. Data lives on named volumes.
# Secrets are never regenerated; only flags you pass are updated.
# ============================================================================

set -eu

# The image is the whole release: the server, and the host files this script
# unpacks into $DIR. Overridable for testing (point IMAGE at a locally built
# tag, DIR at a temp dir).
IMAGE="${SHOCKWAVE_IMAGE:-ghcr.io/stephengpope/shockwave-companion}"
DIR="${SHOCKWAVE_DIR:-/opt/shockwave-companion}"

# Empty = not passed. A re-run only overwrites what was actually given, so
# `--domain=` on an update adds a domain to an existing install without touching
# the generated secrets.
DOMAIN=""
DOMAIN_SET=0
CERT_EMAIL=""
CERT_EMAIL_SET=0
ASSUME_YES=0
NO_FIREWALL=0
for arg in "$@"; do
  case "$arg" in
    --domain=*)     DOMAIN="${arg#--domain=}"; DOMAIN_SET=1 ;;
    --cert-email=*) CERT_EMAIL="${arg#--cert-email=}"; CERT_EMAIL_SET=1 ;;
    --yes|-y)       ASSUME_YES=1 ;;
    --no-firewall)  NO_FIREWALL=1 ;;
    *) echo "unknown option: $arg" >&2; exit 1 ;;
  esac
done

say()  { printf '\033[0;36m→\033[0m %s\n' "$1"; }
ok()   { printf '\033[0;32m✓\033[0m %s\n' "$1"; }
fail() { printf '\033[0;31m✗\033[0m %s\n' "$1" >&2; exit 1; }

# Prompt via /dev/tty so it works under `curl | sh` (stdin is the script).
ask() { # ask "question" -> $ANSWER ('' when non-interactive)
  ANSWER=''
  if [ "$ASSUME_YES" -eq 1 ] || ! [ -r /dev/tty ]; then return 0; fi
  printf '%s' "$1" > /dev/tty
  IFS= read -r ANSWER < /dev/tty || ANSWER=''
}

[ "$(uname -s)" = "Linux" ] || fail "Linux only (got $(uname -s)). On macOS use the repo: cd api && docker compose up -d --build"
command -v curl >/dev/null 2>&1 || fail "curl is required"

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  command -v sudo >/dev/null 2>&1 || fail "run as root, or install sudo"
  SUDO="sudo"
  say "Some steps need root — sudo will prompt if needed."
fi

# ── Docker ──────────────────────────────────────────────────────────────────
if command -v docker >/dev/null 2>&1 && $SUDO docker info >/dev/null 2>&1; then
  ok "docker $(docker --version | sed 's/Docker version //;s/,.*//') found"
else
  if [ "$ASSUME_YES" -ne 1 ]; then
    ask "Docker not found — install it via get.docker.com? [Y/n] "
    case "$ANSWER" in n|N|no|NO) fail "docker is required" ;; esac
  fi
  say "Installing docker..."
  curl -fsSL https://get.docker.com | $SUDO sh
  $SUDO docker info >/dev/null 2>&1 || fail "docker installed but the daemon isn't responding"
  ok "docker installed"
fi
$SUDO docker compose version >/dev/null 2>&1 || fail "docker compose plugin missing (docker too old — get.docker.com installs it)"

# ── Firewall (ufw) ──────────────────────────────────────────────────────────
# Defense in depth for the HOST: default-deny inbound, allow SSH + 80/443.
# The companion's own surface is unchanged (traefik 80/443 allowed, api is
# localhost-bound, postgres unmapped) — this guards sshd and whatever else
# lands on the box later. Idempotent; re-runs are safe.
if [ "$NO_FIREWALL" -ne 1 ]; then
  WANT_FW=y
  if [ "$ASSUME_YES" -ne 1 ]; then
    ask "Enable ufw firewall (deny inbound; allow SSH + 80/443)? [Y/n] "
    case "$ANSWER" in n|N|no|NO) WANT_FW=n ;; esac
  fi
  if [ "$WANT_FW" = y ]; then
    if ! command -v ufw >/dev/null 2>&1; then
      if command -v apt-get >/dev/null 2>&1; then
        say "Installing ufw..."
        { $SUDO apt-get update -qq && $SUDO apt-get install -y -qq ufw; } \
          || say "ufw install failed — skipping firewall"
      else
        say "No ufw and no apt-get — skipping firewall (set up firewalld/nftables manually)"
      fi
    fi
    if command -v ufw >/dev/null 2>&1; then
      # Never lock ourselves out: allow every configured sshd port BEFORE enabling.
      SSH_PORTS=$(grep -rhsE '^[[:space:]]*Port[[:space:]]+[0-9]+' /etc/ssh/sshd_config /etc/ssh/sshd_config.d 2>/dev/null | awk '{print $2}' | sort -u)
      [ -n "$SSH_PORTS" ] || SSH_PORTS=22
      for p in $SSH_PORTS; do $SUDO ufw allow "$p/tcp" >/dev/null; done
      $SUDO ufw allow 80/tcp >/dev/null
      $SUDO ufw allow 443/tcp >/dev/null
      $SUDO ufw default deny incoming >/dev/null
      $SUDO ufw default allow outgoing >/dev/null
      $SUDO ufw --force enable >/dev/null
      ok "Firewall on (inbound allowed: SSH [$SSH_PORTS], 80, 443)"
    fi
  fi
fi

# ── Runtime files ───────────────────────────────────────────────────────────
# They come OUT OF THE IMAGE, not off GitHub. A release is one artifact, so the
# compose file, traefik config, updater scripts and `shockwave` command are
# always the ones built alongside the server they configure — and there is no
# file list anywhere for a release to outgrow. See api/Dockerfile.
#
# Always `latest`, and any SHOCKWAVE_TAG pin is cleared below: re-running this
# script is the documented update path and the recovery path, so it has to move
# a box forward rather than rebuild it at whatever tag it was stuck on.
say "Pulling companion image..."
$SUDO docker pull "$IMAGE:latest" || fail "could not pull $IMAGE:latest"

say "Extracting companion files into $DIR ..."
$SUDO mkdir -p "$DIR"
CID=$($SUDO docker create "$IMAGE:latest") || fail "could not create a container from $IMAGE:latest"
$SUDO docker cp "$CID:/host-files/." "$DIR/" || {
  $SUDO docker rm "$CID" >/dev/null 2>&1 || true
  fail "image has no /host-files — is $IMAGE:latest older than this installer?"
}
$SUDO docker rm "$CID" >/dev/null 2>&1 || true
ok "Files installed from $IMAGE:latest"

# ── Public address ──────────────────────────────────────────────────────────
# Resolved HERE, once, and written to .env. The server reads it rather than
# looking it up itself: the self-signed certificate has to be issued for the
# exact address printed below, and two independent lookups can disagree — then
# the certificate is for one address while you connect to another.
PUBLIC_IP=$(curl -fsS --max-time 10 https://api.ipify.org 2>/dev/null || true)
case "$PUBLIC_IP" in
  *[0-9].[0-9]*) ;;
  *) PUBLIC_IP="" ;;
esac

# ── .env — secrets generated once; passed flags update in place ──────────────
ENV_FILE="$DIR/.env"

# Read one key's value out of .env ('' when absent).
env_get() { $SUDO sh -c "grep '^$1=' '$ENV_FILE' 2>/dev/null" | head -1 | cut -d= -f2- || true; }
# Set or replace one key in .env, preserving everything else and the 0600 mode.
env_set() {
  $SUDO sh -c "umask 077; grep -v '^$1=' '$ENV_FILE' > '$ENV_FILE.tmp' 2>/dev/null || true; \
               printf '%s=%s\n' '$1' '$2' >> '$ENV_FILE.tmp'; \
               mv '$ENV_FILE.tmp' '$ENV_FILE'"
}

# An IP is not a domain. Let's Encrypt only issues for names, so an IP in
# COMPANION_DOMAIN leaves the server with no certificate of its own and Traefik
# serving the throwaway one it regenerates at every startup — a new fingerprint
# to approve after every restart. It can only mean self-signed, so treat it as
# the address and say so. `normalizeTlsEnv` (api) makes the same call at runtime,
# for boxes whose .env already has it.
case "$DOMAIN" in
  # Reject non-IP characters first, so a hostname that starts like an IP
  # (10.0.0.1.nip.io) keeps its Let's Encrypt certificate.
  *[!0-9.]*) ;;
  [0-9]*.[0-9]*.[0-9]*.[0-9]*)
    say "--domain is an IP address; using it as this server's address (self-signed certificate)."
    PUBLIC_IP="$DOMAIN"
    DOMAIN=""
    ;;
esac

if $SUDO test -f "$ENV_FILE"; then
  ok ".env exists — secrets kept (delete $ENV_FILE to regenerate)"
  API_KEY_SHOWN="(unchanged — see $ENV_FILE)"
  # Only overwrite what was actually passed, so an update run doesn't wipe a
  # domain that's already configured.
  [ "$DOMAIN_SET" -eq 1 ] && env_set COMPANION_DOMAIN "$DOMAIN"
  [ "$CERT_EMAIL_SET" -eq 1 ] && env_set COMPANION_CERT_EMAIL "$CERT_EMAIL"
  DOMAIN=$(env_get COMPANION_DOMAIN)
  # Refresh the recorded address if it changed (server moved / new IP).
  if [ -n "$PUBLIC_IP" ] && [ "$(env_get COMPANION_HOST)" != "$PUBLIC_IP" ]; then
    env_set COMPANION_HOST "$PUBLIC_IP"
    say "Recorded new public address: $PUBLIC_IP"
  fi
  # Release the tag a previous remote upgrade pinned. Compose reads
  # ${SHOCKWAVE_TAG:-latest}, so an empty value IS `latest` — and the files just
  # unpacked came from `latest`, so leaving an old pin would run one release's
  # server under another release's compose file. This is also what makes
  # re-running the installer a real recovery: a box whose upgrades are broken
  # gets moved forward rather than rebuilt exactly as stuck as it was.
  if [ -n "$(env_get SHOCKWAVE_TAG)" ]; then
    env_set SHOCKWAVE_TAG ""
    say "Unpinned SHOCKWAVE_TAG — this install runs latest"
  fi
else
  if [ "$DOMAIN_SET" -ne 1 ]; then
    ask "Domain for this server (Enter = none, use a self-signed certificate on the public IP): "
    DOMAIN="$ANSWER"
  fi
  if [ -n "$DOMAIN" ] && [ "$CERT_EMAIL_SET" -ne 1 ]; then
    ask "Email for Let's Encrypt expiry warnings (Enter = skip): "
    CERT_EMAIL="$ANSWER"
  fi
  [ -n "$DOMAIN" ] || [ -n "$PUBLIC_IP" ] || fail "could not determine this server's public address, and no --domain was given"
  # hex for the two values that get embedded in URLs / headers; MASTER_KEY must
  # be exactly 32 bytes base64 (the server validates at boot).
  rand_hex() { head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; }
  PG_PW=$(rand_hex 24)
  MASTER=$(head -c 32 /dev/urandom | base64)
  API_KEY_SHOWN=$(rand_hex 24)
  $SUDO sh -c "umask 077; cat > '$ENV_FILE'" <<EOF
POSTGRES_PASSWORD=$PG_PW
MASTER_KEY=$MASTER
API_KEY=$API_KEY_SHOWN
COMPANION_HOST=$PUBLIC_IP
COMPANION_DOMAIN=$DOMAIN
COMPANION_CERT_EMAIL=$CERT_EMAIL
EOF
  ok ".env created (secrets generated, chmod 600)"
fi

# ── The one command on PATH ─────────────────────────────────────────────────
# ONE symlink, to a file that ships with the release. Its target path never
# changes, so upgrades keep the command current by replacing that file — and
# never need to write outside $DIR, which they cannot do.
#
# This used to generate a script per command here and symlink each one. Those
# scripts existed only as text inside this installer, so upgrades had no way to
# deliver them: a box installed before a command existed never got it, and a
# changed command never reached any existing box. Adding a subcommand now means
# editing host/shockwave and cutting a release — nothing to install.
$SUDO chmod 755 "$DIR/host/shockwave"
$SUDO ln -sf "$DIR/host/shockwave" /usr/local/bin/shockwave
# Retire the per-command symlinks from before the dispatcher. Left in place they
# point at files this installer no longer writes, so they'd be broken commands
# on PATH that report a missing file rather than telling you the name changed.
for old in shockwave-fingerprint shockwave-rotate-cert; do
  if [ -L "/usr/local/bin/$old" ] || [ -f "$DIR/$old" ]; then
    $SUDO rm -f "/usr/local/bin/$old" "$DIR/$old"
  fi
done
ok "Installed: shockwave (try: shockwave fingerprint)"

# ── Up ──────────────────────────────────────────────────────────────────────
say "Pulling images + starting containers..."
cd "$DIR"
# Tolerate a failed pull when an image is already present locally (registry
# blip on an update run shouldn't take the install down with it).
$SUDO docker compose pull || say "pull failed — continuing with local images if present"
$SUDO docker compose up -d
ok "Containers started"

say "Waiting for the companion to come up..."
i=0
until curl -fsS http://127.0.0.1:8080/health >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -ge 45 ] && fail "companion not healthy after 90s — check: cd $DIR && $SUDO docker compose logs api"
  sleep 2
done
ok "Companion is up"

# That loop only proves the api container can talk to itself on a local port —
# not the address, certificate or key printed below, which are what the desktop
# actually uses. `shockwave check` tests those three, and it matters most right
# here: with a domain, Let's Encrypt issues AFTER `up -d` returns, so a failed
# issuance would otherwise reach the user as "✓ Install complete" followed by
# "Couldn't connect" in the app. Never fatal — a fresh install is still worth
# finishing, and the check names what to fix.
printf '\n'
say "Verifying the details you're about to type into the app..."
# COMPANION_DIR, because SHOCKWAVE_DIR (the test hook) moves the install and the
# command's own default would look in /opt for a stack that isn't there.
$SUDO env COMPANION_DIR="$DIR" shockwave check || true

# ── Done ────────────────────────────────────────────────────────────────────
# Reuse the address recorded in .env rather than looking it up a second time —
# the certificate was issued for that one, so it's what must be typed.
if [ -n "$DOMAIN" ]; then
  URL="https://$DOMAIN"
else
  HOST=$(env_get COMPANION_HOST)
  URL="https://${HOST:-YOUR-SERVER-IP}"
fi

# With no domain the certificate is self-signed, so the desktop can't check it
# against anyone — it asks you to approve it, and the fingerprint here is the only
# thing that makes that approval mean something. Read it off the certificate the
# server just created.
FINGERPRINT=""
if [ -z "$DOMAIN" ]; then
  FINGERPRINT=$($SUDO docker compose exec -T api \
    openssl x509 -in /etc/traefik/dynamic/companion.crt -noout -fingerprint -sha256 2>/dev/null \
    | cut -d= -f2- || true)
fi

printf '\n\033[0;32m✓ Install complete.\033[0m\n\n'
printf 'In the desktop app, open Settings → Companion and enter:\n\n'
printf '  Server URL:  %s\n' "$URL"
printf '  API key:     %s\n' "$API_KEY_SHOWN"
if [ -n "$FINGERPRINT" ]; then
  printf '\nThe app will show you a fingerprint before it connects. Check it matches\n'
  printf 'this, then approve it:\n\n'
  printf '  Fingerprint: %s\n' "$FINGERPRINT"
fi
printf '\nNotes:\n'
printf '  - Ports 80 + 443 must be open (cloud firewall / security group).\n'
if [ -z "$DOMAIN" ]; then
  printf '  - Show the fingerprint again any time:  shockwave fingerprint\n'
  printf '  - Replace the certificate:              shockwave rotate-cert\n'
  printf '  - Add a domain later (real certificate, no fingerprint to approve):\n'
  printf '      re-run this script with --domain=your-domain --cert-email=you@example.com\n'
fi
printf '  - Update later by re-running this script.\n'
printf '  - Logs: cd %s && %s docker compose logs -f api\n\n' "$DIR" "${SUDO:-}"
