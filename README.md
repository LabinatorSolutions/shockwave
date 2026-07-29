<div align="center">

<h1><img src="build/icon.png" width="40" align="top" alt="" />&nbsp;Shockwave</h1>

**An Obsidian-style markdown editor with a built-in AI agent — and free sync.**

A local, file-based notes app where your work stays as plain `.md` files in a folder you own.
It ships with a real coding agent baked right in (no separate Claude Code), and syncs through
your own GitHub repo for free.

[**Download ↓**](#install-the-app) · macOS · Windows · Linux

</div>

---

Want to learn to build apps like this? Join the <a href="https://skool.com/ai-architects">AI Architects</a>.

---

## Why Shockwave

### 🤖 Integrated AI Agent

A full coding agent lives in the right-hand sidebar — it reads and edits your notes directly, so you don't need a separate tool open.

- **Bring your own key** — Anthropic or OpenAI; pick the model and customize the system prompt.
- **Skills** — drop in reusable `SKILL.md` skill folders and enable them globally or per-workspace.
- **Secrets** — store named API tokens (encrypted at rest) the agent can use.
- **Voice input** — dictate to the agent with the mic, transcribed in real time.
- **Send context** — attach images and code/text files, or "Message Agent" to hand it the current file and your selection.

### 🔄 Free GitHub Sync

Sync any workspace to **your own GitHub repo** — no subscription, no third-party server, your history stays yours.

- **One token, set once** — a GitHub PAT, encrypted at rest, used across all workspaces.
- **Flexible setup** — clone an existing repo, create a brand-new one, or adopt a folder that's already a git repo.
- **Hands-off** — auto-syncs on an interval, with a status icon showing idle / syncing / paused.
- **Conflicts handled in-app** — when two machines edit the same file, a red badge shows what clashed. Resolve each file (keep yours, take theirs, or merge by hand) or reset the whole workspace either way — no terminal, no git knowledge needed.

### 🛰 Your Own Companion Server

A small self-hosted server that is the home base for everything that should outlive one machine.

- **Settings, secrets, and chats live there** — every desktop you sign in from sees the same workspaces, agent config, and full chat history. Credentials are encrypted at rest; the desktop keeps none of them.
- **Telegram** — message your agent from your phone. Text or voice notes; replies stream back, and the finished work is committed and pushed to your repo.
- **Scheduled runs** — define jobs in a `cron.json` at the workspace root and the companion runs the agent on a schedule (nightly triage, weekly summaries, whatever you script).
- **Watch it live** — a turn started from Telegram or cron streams into the desktop chat sidebar in real time.

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
  | sh -s -- --yes --domain=notes.example.com --email=you@example.com
```

Flags: `--yes` (accept all prompts), `--domain=`, `--email=`, `--no-firewall`.

### After the install

- **Connect the desktop** — Settings → Companion → paste the printed Server URL + API key. Every other settings page unlocks once it connects.
- **Ports** — 80 and 443 must be reachable from the internet. On a cloud VPS that usually means opening them in the provider's firewall / security group too.
- **Update** — re-run the same one-liner. Your data lives on Docker volumes and your `.env` (secrets) is never overwritten.
- **Logs** — `cd /opt/shockwave-companion && docker compose logs -f api`
- **Self-healing** — containers restart on crash, on reboot, and (via a health check) when the API stops responding.

### Telegram (optional)

Create a bot with [@BotFather](https://t.me/BotFather), grab your numeric user id from [@userinfobot](https://t.me/userinfobot), then connect both in **Settings → Telegram**. Only your user id can talk to the bot, and it works against the workspace you pick there. In the chat, `/help` lists everything: `/new`, `/chats`, `/workspaces`, `/status`, `/btw` (ask about a running job without interrupting it). Voice notes work too (transcribed with the AssemblyAI key from Settings → Transcription).

### Scheduled runs (optional)

Add a `cron.json` to a workspace root and the companion runs the agent on your schedule against a checkout of that repo:

```json
[
  { "name": "nightly-triage", "schedule": "0 6 * * *", "prompt": "Review yesterday's notes and update TODO.md." }
]
```

Each job takes `name`, `schedule` (standard cron syntax, in your configured timezone), `prompt`, and optionally `"enabled": false` to pause it.

Job status (next run, last run, manual run-now) is in **Settings → Cron** in the desktop app.

---

## Development

```bash
npm install
npm run dev     # electron + vite, hot reload
npm run dist    # build installers into dist/
npm test        # run the test suite
```

Companion server (in `api/`): `cd api && docker compose up -d --build` — see [`api/CLAUDE.md`](api/CLAUDE.md).

> **Note:** prebuilt companion images are published to [`ghcr.io/stephengpope/shockwave-companion`](https://github.com/stephengpope/shockwave/pkgs/container/shockwave-companion) (multi-arch, tagged per release + `latest`).

See [`CLAUDE.md`](CLAUDE.md) for architecture notes.
