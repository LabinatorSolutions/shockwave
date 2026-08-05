<div align="center">

<h1><img src="build/icon.png" width="40" align="top" alt="" />&nbsp;Shockwave</h1>

**Shockwave is a second brain and knowledge graph with a built-in AI assistant.** A notes app that organizes itself — and does the work for you (and syncs for free across your devices).

A local, file-based notes app where your work stays as plain `.md` files in a folder you own.
It ships with a real coding agent baked right in (no separate Claude Code), and syncs through
your own GitHub repo for free.

[**Download ↓**](#install-the-app) · macOS · Windows · Linux

</div>

---

Want to learn to build apps like this? Join the **[AI Architects](https://skool.com/ai-architects)**.

---

## Why Shockwave

### 🧠 Get it out of your head. It stays organized on its own.

Get it out all out of your head, ideas, projects, due dates. The agent keeps it in order for you, so you never sit down to a pile of notes that needs processing. And because everything's in one place, the agent can use it and even work to complete your work.

### 🧬 It learns you — nothing complicated to install

Everything the power tools give you (like Hermes) — memory, self-improvement — without the complicated setup that comes with them.

### Close the laptop. It keeps working.

Create work for the agent, then close the laptop and the work keeps getting done without you. And you can also pick up where you left off on any other device, even on your phone.

### 🔄 Sync that costs nothing

Most notes apps charge you to sync across device we use github instead. Also helps manage file sync conflicts automatically.

---

## Install the app

Grab the latest build for your platform — these links always point at the newest release:

| Platform | Download |
|---|---|
| **macOS** (Apple Silicon) | [Shockwave-mac.dmg](https://github.com/stephengpope/shockwave/releases/latest/download/Shockwave-mac.dmg) |
| **Windows** | [Shockwave-windows.exe](https://github.com/stephengpope/shockwave/releases/latest/download/Shockwave-windows.exe) |
| **Linux** | [Shockwave-linux.AppImage](https://github.com/stephengpope/shockwave/releases/latest/download/Shockwave-linux.AppImage) |

> [!NOTE]
> The builds aren't code-signed yet, so each OS shows a one-time warning. Here's how to get past it:
>
> - **macOS** — "Shockwave is damaged and can't be opened" is the unsigned-app message, not real damage. Right-click the app → **Open**, or run `xattr -cr /Applications/Shockwave.app` once.
> - **Windows** — on "Windows protected your PC", click **More info → Run anyway**.
> - **Linux** — make it executable first: `chmod +x Shockwave-linux.AppImage`, then run it.

---

## Install the companion server

The desktop app stores its settings, secrets, and chats on a **companion server** you host yourself — any small Linux VPS works (1 GB RAM is plenty). It also runs the agent for Telegram and scheduled jobs, so those work even when your computer is off.

On a fresh Linux box, run:

```bash
curl -fsSL https://raw.githubusercontent.com/stephengpope/shockwave/main/api/install.sh | sh
```

It installs Docker if needed, sets up a firewall, starts the server (Postgres + API + TLS proxy), and finishes by printing the **Server URL** and **API key**. Enter those in the desktop app under **Settings → Companion** and you're connected.

### What the installer asks

| Prompt | What to answer |
|---|---|
| **Domain for this server** | A domain that points at the box (e.g. `notes.example.com`) gets a free, auto-renewing Let's Encrypt certificate. **Press Enter to skip** — the server then uses a self-signed certificate on its public IP, and the desktop will ask you to trust it on first connect. Both work; a domain just avoids the trust prompt. |
| **Email for Let's Encrypt** | Only asked when you set a domain. Used for certificate-expiry notices from Let's Encrypt. Enter to skip. |
| **Enable ufw firewall?** | Recommended **Yes**: blocks all inbound traffic except SSH and ports 80/443 (the only ones the companion needs). Your SSH port is detected and allowed automatically, so you can't lock yourself out. Say No if you manage the firewall some other way. |
| **Docker not found — install it?** | The server runs in Docker. Yes fetches it from get.docker.com. |

Non-interactive install (no prompts):

```bash
curl -fsSL https://raw.githubusercontent.com/stephengpope/shockwave/main/api/install.sh \
  | sh -s -- --yes --domain=notes.example.com --cert-email=you@example.com
```

Flags: `--yes` (accept all prompts), `--domain=`, `--cert-email=`, `--no-firewall`.

### After the install

- **Connect the desktop** — **Settings → Companion** → paste the printed Server URL + API key. Every other settings page unlocks once it connects.
- **Ports** — 80 and 443 must be reachable from the internet. On a cloud VPS that usually means opening them in the provider's firewall / security group too.
- **Update** — re-run the same one-liner. Your data lives on Docker volumes and your `.env` (secrets) is never overwritten.
- **Logs** — `cd /opt/shockwave-companion && docker compose logs -f api`
- **Self-healing** — containers restart on crash, on reboot, and (via a health check) when the API stops responding.

### Telegram (optional)

Create a bot with [@BotFather](https://t.me/BotFather), grab your numeric user id from [@userinfobot](https://t.me/userinfobot), then connect both in **Settings → Telegram**. Only your user id can talk to the bot, and it works against the workspace you pick there. In the chat, `/help` lists everything: `/new`, `/chats`, `/workspaces`, `/status`, `/btw` (ask about a running job without interrupting it). Voice notes work too (transcribed with the key from **Settings → Agent Voice**), and the agent can answer you out loud — set that per workspace on the same page, or just ask it to.

### Scheduled runs (optional)

Add a `cron.json` to a workspace root and the companion runs the agent on your schedule against a checkout of that repo:

```json
[
  { "name": "nightly-triage", "schedule": "0 6 * * *", "prompt": "Review yesterday's notes and update TODO.md." }
]
```

Each job takes `name`, `schedule` (standard cron syntax, in your configured timezone), `prompt`, and optionally `"enabled": false` to pause it.

For a job that should run once and then be gone, set `"once": true` and give `schedule` an ISO datetime (`"2026-03-14T18:50:00"`, in the same timezone). It removes its own entry from `cron.json` after it runs.

Job status (next run, last run, manual run-now) is behind the clock icon in the desktop app's left rail.
