#!/bin/sh
# Generates the Traefik dynamic router for the api service, picking the cert mode
# from $COMPANION_DOMAIN. Runs once as a sidecar before Traefik starts and writes
# into the shared dynamic-config volume (Traefik file provider watches it).
#
#   no domain  -> catch-all router, tls:{} -> Traefik's default self-signed cert
#   domain set -> Host(domain) router, certResolver:le -> Let's Encrypt real cert
set -eu

OUT="${OUT:-/out/router.yml}"
BACKEND="http://api:8080"
DIR="$(dirname "$OUT")"

# The api (uid 1000, non-root) writes the self-signed cert + tls.yml into this
# shared dir on connect, so it must be writable by that uid. Traefik (root) reads.
chown 1000:1000 "$DIR" 2>/dev/null || chmod 777 "$DIR" 2>/dev/null || true

# An IP in COMPANION_DOMAIN means self-signed, not Let's Encrypt — ACME cannot
# issue for a bare IP, and pointing the router at a resolver that can never
# succeed leaves Traefik serving the throwaway certificate it regenerates at
# every startup (a new fingerprint for every desktop to approve, every restart).
# The api normalizes the same way in `normalizeTlsEnv` (server.ts); it is a
# different container and cannot tell us, so the two checks must agree.
# The first branch is load-bearing: it rejects anything containing a character
# an IP cannot have, so a real hostname that merely STARTS like one — nip.io
# addresses such as 10.0.0.1.nip.io — isn't mistaken for an IP and denied its
# Let's Encrypt certificate.
case "${COMPANION_DOMAIN:-}" in
  *[!0-9.]*) ;;
  [0-9]*.[0-9]*.[0-9]*.[0-9]*)
    echo "gen-router: COMPANION_DOMAIN is an IP -> self-signed (Let's Encrypt cannot issue for an IP)"
    COMPANION_DOMAIN=''
    ;;
esac

if [ -n "${COMPANION_DOMAIN:-}" ]; then
  echo "gen-router: domain '$COMPANION_DOMAIN' -> Let's Encrypt (real cert)"
  cat > "$OUT" <<EOF
http:
  routers:
    api:
      rule: "Host(\`$COMPANION_DOMAIN\`)"
      entryPoints: ["websecure"]
      service: api
      tls:
        certResolver: le
  services:
    api:
      loadBalancer:
        servers:
          - url: "$BACKEND"
EOF
else
  echo "gen-router: no COMPANION_DOMAIN -> Traefik default self-signed cert"
  cat > "$OUT" <<EOF
http:
  routers:
    api:
      rule: "PathPrefix(\`/\`)"
      entryPoints: ["websecure"]
      service: api
      tls: {}
  services:
    api:
      loadBalancer:
        servers:
          - url: "$BACKEND"
EOF
fi

echo "gen-router: wrote $OUT"
cat "$OUT"
