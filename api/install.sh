#!/bin/sh
# ============================================================================
# Shockwave companion installer (Linux)
# ============================================================================
# One-liner install / update:
#
#   curl -fsSL https://raw.githubusercontent.com/stephengpope/shockwave/main/api/install.sh | sh
#
# Options (append: | sh -s -- --domain=notes.example.com --email=you@x.com --yes):
#   --domain=HOST   COMPANION_DOMAIN (real domain or ngrok host). Empty (the
#                   default) = self-signed cert on the box's public IP.
#   --email=ADDR    ACME_EMAIL for Let's Encrypt (used when --domain is set).
#   --yes           Non-interactive: no prompts, install docker if missing.
#   --no-firewall   Skip the ufw setup.
#
# What it does:
#   1. Installs docker (via get.docker.com) if missing.
#   2. Sets up ufw: deny inbound, allow SSH + 80/443 (skippable, see above).
#   3. Fetches the compose file + traefik config + init.sql into /opt/shockwave-companion.
#   4. Generates .env secrets on first run (never overwritten after that).
#   5. docker compose up -d  — pulls ghcr.io/stephengpope/shockwave-companion.
#   6. Waits for /health, prints the server URL + API key for the desktop app.
#
# Re-running is the update path: refreshes the compose/config files, pulls the
# newest image, recreates changed containers. Data lives on named volumes.
# ============================================================================

set -eu

REPO="stephengpope/shockwave"
REF="${SHOCKWAVE_REF:-main}"
# Overridable for testing (point RAW at a file:// checkout, DIR at a temp dir).
RAW="${SHOCKWAVE_RAW_BASE:-https://raw.githubusercontent.com/$REPO/$REF/api}"
DIR="${SHOCKWAVE_DIR:-/opt/shockwave-companion}"

DOMAIN=""
EMAIL=""
ASSUME_YES=0
NO_FIREWALL=0
for arg in "$@"; do
  case "$arg" in
    --domain=*)    DOMAIN="${arg#--domain=}" ;;
    --email=*)     EMAIL="${arg#--email=}" ;;
    --yes|-y)      ASSUME_YES=1 ;;
    --no-firewall) NO_FIREWALL=1 ;;
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
say "Fetching companion files into $DIR ..."
$SUDO mkdir -p "$DIR/traefik" "$DIR/updater"
for f in docker-compose.yml init.sql traefik/traefik.yml traefik/gen-router.sh updater/watch.sh updater/apply.sh; do
  curl -fsSL "$RAW/$f" | $SUDO tee "$DIR/$f" >/dev/null || fail "failed to fetch $f"
done
ok "Files fetched (ref: $REF)"

# ── .env — generated once, never overwritten ────────────────────────────────
ENV_FILE="$DIR/.env"
if $SUDO test -f "$ENV_FILE"; then
  ok ".env exists — keeping it (delete $ENV_FILE to regenerate)"
  API_KEY_SHOWN="(unchanged — see $ENV_FILE)"
  DOMAIN=$($SUDO sh -c "grep '^COMPANION_DOMAIN=' '$ENV_FILE'" | cut -d= -f2- || true)
else
  if [ -z "$DOMAIN" ]; then
    ask "Domain for this server (Enter = none, use self-signed cert on the public IP): "
    DOMAIN="$ANSWER"
  fi
  if [ -n "$DOMAIN" ] && [ -z "$EMAIL" ]; then
    ask "Email for Let's Encrypt (Enter = skip): "
    EMAIL="$ANSWER"
  fi
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
COMPANION_DOMAIN=$DOMAIN
ACME_EMAIL=$EMAIL
EOF
  ok ".env created (secrets generated, chmod 600)"
fi

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
VERSION=$(curl -fsS http://127.0.0.1:8080/health | sed 's/.*"version":"\([^"]*\)".*/\1/')
ok "Companion is up (version $VERSION)"

# ── Done ────────────────────────────────────────────────────────────────────
if [ -n "$DOMAIN" ]; then URL="https://$DOMAIN"; else
  IP=$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || echo "<this-server's-ip>")
  URL="https://$IP"
fi
printf '\n\033[0;32m✓ Install complete.\033[0m\n\n'
printf 'In the desktop app, open Settings → Companion and enter:\n\n'
printf '  Server URL:  %s\n' "$URL"
printf '  API key:     %s\n' "$API_KEY_SHOWN"
printf '\nNotes:\n'
printf '  - Ports 80 + 443 must be open (cloud firewall / security group).\n'
if [ -z "$DOMAIN" ]; then
  printf '  - No domain set: the server uses a self-signed certificate; the desktop will ask you to trust it on first connect.\n'
fi
printf '  - Update later by re-running this script.\n'
printf '  - Logs: cd %s && %s docker compose logs -f api\n\n' "$DIR" "${SUDO:-}"
