# Running the companion server

The companion is the small server behind Shockwave. It holds your settings, keys, chats and workspace list, and it runs the agent for Telegram messages and scheduled jobs — which is what lets those keep working when your laptop is shut.

You only need this page once something is set up and you want to look after it. Getting it installed is three lines in the [README](../README.md#install).

It lives in `/opt/shockwave-companion` and runs under Docker.

## Everyday commands

The installer leaves a `shockwave` command on the box:

```
shockwave status           # are the containers up
shockwave logs             # follow the api log (or: shockwave logs traefik)
shockwave check            # test the address, certificate and key the app uses
shockwave fingerprint      # print the certificate fingerprint again
shockwave rotate-cert      # replace the certificate
shockwave version          # the release this server is running
```

**`shockwave check` is the one to reach for when the app can't connect.** It tests the three things the desktop actually uses — the address, the certificate, and the API key — and says which one is broken. The installer runs it for you at the end for that reason.

## Back up two things

**The database** holds everything: your settings, chats, workspace list and encrypted secrets.

```bash
cd /opt/shockwave-companion
docker compose exec -T postgres pg_dump -U shockwave shockwave > shockwave-backup.sql
```

**`/opt/shockwave-companion/.env`** holds `MASTER_KEY`, and this is the one people lose.

Every secret in the database — your GitHub token, your model API keys, the Telegram bot token — is encrypted with that key. The database on its own cannot be decrypted without it. Restore a database backup onto a server with a fresh `.env` and everything comes back except the contents of every credential you ever stored, with nothing to recover them from.

Keep a copy of `.env` somewhere other than the box, and keep it somewhere private — it also holds the API key and the Postgres password.

## Updating

When the server falls behind the app, the app notices and offers to update it — one click, nothing to log into. It pulls the matching release and restarts.

Re-running the install command does the same thing from the server side:

```bash
curl -fsSL https://raw.githubusercontent.com/stephengpope/shockwave/main/api/install.sh | sh
```

Either way, your data stays on its Docker volumes and your `.env` is never overwritten — secrets are generated once, on the first install, and left alone after that. A re-run only changes settings you explicitly pass as flags.

The app and the server are released together under one version tag, so they are always meant to be on the same number. `shockwave version` says what the server is on.

## Certificates

**By default the certificate is self-signed**, issued for the server's public address at first boot. The desktop can't check a self-signed certificate against anyone, so it shows you the fingerprint and asks you to approve it. Compare it against `shockwave fingerprint` before you do — that comparison is the only thing standing between your connection and someone else's server, because every request carries your API key.

**Point a domain at the box** and you get a real, auto-renewing Let's Encrypt certificate instead, with no fingerprint to approve:

```bash
curl -fsSL https://raw.githubusercontent.com/stephengpope/shockwave/main/api/install.sh \
  | sh -s -- --domain=notes.example.com --cert-email=you@example.com
```

That works on an existing install, not just a fresh one.

**`shockwave rotate-cert` replaces the certificate**, and every desktop stops connecting until the new fingerprint is approved. That is the point — it's the recovery if the server's private key is ever exposed.

## Configuration

`/opt/shockwave-companion/.env`, written by the installer. Restart with `docker compose up -d` after changing anything.

| | |
|---|---|
| `POSTGRES_PASSWORD` | Generated once. The database isn't reachable from outside the box. |
| `MASTER_KEY` | Encrypts every stored secret. Back it up; see above. |
| `API_KEY` | What the desktop app sends to authenticate. |
| `COMPANION_HOST` | This server's public address. Required when there's no domain — the self-signed certificate is issued for it. |
| `COMPANION_DOMAIN` | Set only for a real domain or an ngrok host. Empty means self-signed. Not an IP. |
| `COMPANION_CERT_EMAIL` | Where Let's Encrypt sends expiry warnings. Optional. |

Tuning, rarely needed:

| | |
|---|---|
| `CRON_ENABLED` | `false` turns off scheduled jobs entirely. Default on. |
| `CRON_REFRESH_SCHEDULE` | How often the server re-reads each workspace's `cron.json`. Default every minute. |
| `REVIEW_ENABLED` | `false` turns off the background runs where the agent updates its own skills and memory. Default on. |
| `REVIEW_SCHEDULE` | How often those are considered. Default every 5 minutes. |

The rest — how long a run may take, how much scratch disk to keep, how often the agent reviews itself — are ordinary settings in the app, under **Settings → Agent Chat**, so you don't need to touch the server to change them.

## What's actually running

Six containers:

| | |
|---|---|
| **postgres** | The database. Private to the Docker network, not exposed to the host. |
| **api** | The companion itself. Bound to `127.0.0.1:8080` only — never a public surface. |
| **traefik** | The only thing listening publicly. Terminates TLS on 443, redirects 80, proxies to the api. |
| **traefik-config** | Writes Traefik's routing config at startup, then exits. Showing as stopped is correct. |
| **updater** | Performs the one-click update from the app. Holds no network port; it watches for a file. |
| **autoheal** | Restarts the api if its health check starts failing. |

## When something's wrong

**Start with `shockwave check`.** It tells you which of the three things the app needs is broken rather than making you guess.

**"Couldn't connect" in the app, and `check` fails on the HTTPS line** — most often ports 80 and 443 are still closed in your VPS provider's firewall or security group. That's separate from the box's own firewall, and it's the single most common cause.

**The app says the certificate changed** — if you didn't run `rotate-cert` or move the server, don't approve it. Compare against `shockwave fingerprint` on the box first.

**The server stops responding** — it should recover on its own. Containers restart on crash and on reboot, and autoheal restarts the api if it goes quiet. `shockwave logs` shows what happened.

**A scheduled job didn't run** — a missed moment is missed, deliberately; nothing is caught up later. Job status, last run, and a manual **Run now** are behind the clock icon in the app's left rail.

## Requirements

Any Linux box with root or sudo, and 1 GB of RAM. Docker is installed for you if it isn't already. Ports 80 and 443 need to be reachable from the internet.
