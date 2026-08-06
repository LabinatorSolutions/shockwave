<h1><img src="build/icon.png" width="40" align="top" alt="" />&nbsp;Shockwave</h1>

A simple notes app that organizes itself and does the work for you with a built-in AI assistant. It also syncs for free across your devices.

For non-technical note-takers who want smart features — memory, self-improvement — without the setup hassle.

[**Download ↓**](#install) · macOS · Windows · Linux

---

Want to learn to build apps like this? Join the **[AI Architects](https://skool.com/ai-architects)**.

---

## Why Shockwave

### 🧠 Knowledge Base — Get it out of your head. It stays organized on its own.

Get it all out of your head, ideas, projects, due dates. The agent keeps it in order for you, so you never sit down to a pile of notes that needs processing. And because everything's in one place, the agent can use it and even complete the work for you.

### 🧬 Easy to install and use but with all the cool features

Everything the power tools give you (like Hermes) — memory, self-improvement — without the complicated setup that comes with them.

### 🛰 Close the laptop. It keeps working.

Create work for the agent, then close the laptop and the work keeps getting done without you. And you can also pick up where you left off on any other device, even on your phone.

### 🔄 FREE Sync — A better agent file sync (with history) that costs nothing

Most notes apps charge you to sync across devices — we use GitHub instead. It also handles file sync conflicts automatically.

---

## Install

Setup takes about fifteen minutes and involves standing up a small server. After that you never think about it again.

Three steps — the app, the server, your keys. The app shows a dot on the settings gear until all three are done, so you can always see what's left.

Before you start, have these ready:

- A **GitHub account** — your notes live in a repo you own. That's what makes syncing free.
- A **Linux server** — any small VPS works, 1 GB RAM is plenty.
- An **API key for an AI model** — Anthropic, OpenAI, Google, OpenRouter and a dozen others are supported. This is the one running cost, and it's billed by your provider, not by us.

### 1. The desktop app

| Platform | Download |
|---|---|
| **macOS** (Apple Silicon) | [Shockwave-mac.dmg](https://github.com/stephengpope/shockwave/releases/latest/download/Shockwave-mac.dmg) |
| **Windows** | [Shockwave-windows.exe](https://github.com/stephengpope/shockwave/releases/latest/download/Shockwave-windows.exe) |
| **Linux** | [Shockwave-linux.AppImage](https://github.com/stephengpope/shockwave/releases/latest/download/Shockwave-linux.AppImage) |

**First launch.** The builds aren't code-signed yet, so each OS shows a one-time warning:

- **macOS** — "Shockwave is damaged and can't be opened" is the unsigned-app message, not real damage. Right-click the app → **Open**, or run `xattr -cr /Applications/Shockwave.app` once.
- **Windows** — on "Windows protected your PC", click **More info → Run anyway**.
- **Linux** — make it executable first: `chmod +x Shockwave-linux.AppImage`, then run it.

**You also need `git`.** A workspace is a GitHub repo checked out on your machine, so the app can't open one without it. Most systems already have it — run `git --version` to check. If it's missing, the app detects that and shows the install command for your platform.

### 2. The companion server

Your settings, keys, and chats live on a small server you host yourself, rather than on our infrastructure. It's also what keeps working when your laptop is shut — Telegram messages and scheduled jobs run there.

On a fresh Linux box, as root or a user with sudo:

```bash
curl -fsSL https://raw.githubusercontent.com/stephengpope/shockwave/main/api/install.sh | sh
```

It installs Docker if needed, sets up a firewall, and starts the server. Four questions, all skippable:

- **Domain for this server** — a domain pointing at the box (`notes.example.com`) gets a free, auto-renewing certificate. Press Enter to skip and the server uses a self-signed certificate on its public IP instead. Both work; a domain just saves you approving a fingerprint once.
- **Email for Let's Encrypt** — only asked if you set a domain, and only used for expiry warnings.
- **Enable ufw firewall?** — recommended. Blocks everything inbound except SSH and ports 80/443. Your SSH port is detected and kept open, so you can't lock yourself out.
- **Install Docker?** — only asked if it isn't already there.

When it finishes it prints your **Server URL**, **API key**, and — if you skipped the domain — a **certificate fingerprint**. Keep that output; the next step needs all of it.

To skip the questions entirely:

```bash
curl -fsSL https://raw.githubusercontent.com/stephengpope/shockwave/main/api/install.sh \
  | sh -s -- --yes --domain=notes.example.com --cert-email=you@example.com
```

Flags: `--yes`, `--domain=`, `--cert-email=`, `--no-firewall`.

### 3. Connect it and add your keys

Open **Settings** in the desktop app and fill in three pages, in this order:

**Companion** — paste the Server URL and API key. If you skipped the domain, the app shows you a fingerprint before it connects: check it matches the one the installer printed, then approve it. That comparison is the whole security of a self-signed setup, so don't skip past it. Every other settings page stays locked until this connects.

**GitHub Sync** — a [personal access token](https://github.com/settings/personal-access-tokens) so the app can sync your notes. It needs `Contents: Read and write`, plus `Administration: Write` if you want the app to create repos for you.

**Agent Chat** — pick a provider and model, and paste that provider's API key.

Then close Settings and add a workspace. That's a GitHub repo plus a folder on this machine — the app can create a new repo or clone one you already have.

---

## Managing the companion

The installer puts a `shockwave` command on the server:

```
shockwave status         # are the containers up
shockwave logs           # follow the logs
shockwave check          # test the URL, certificate and key the app uses
shockwave fingerprint    # show the certificate fingerprint again
shockwave rotate-cert    # replace the certificate
shockwave version
```

**Updating.** When the server falls behind the app, the app notices and offers to update it for you — one click, nothing to log into. Re-running the install one-liner does the same thing from the server side. Either way your data and secrets are left alone.

**Ports.** 80 and 443 have to be reachable from the internet. On a cloud VPS that usually means opening them in the provider's firewall or security group as well as ufw.

**If something stops responding**, it should fix itself — containers restart on crash, on reboot, and when a health check notices the API has stopped answering. `shockwave check` tells you which part is unhappy.

---

## Your agent on Telegram

This is the part that makes the server worth having: your agent in your pocket, working on the same notes, whether or not your laptop is open.

Send it a message and the agent works on your workspace and pushes what it changed. Send a voice note instead of typing. Send it a photo or a document and it'll use it. Ask it for a file and it sends it back. Reply to any of its messages to pick that conversation back up — it switches to that chat, and to that chat's workspace, before answering. And while a long job is running, `/btw` asks what it's up to without interrupting it.

To set it up:

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy the token.
2. Get your numeric user id from [@userinfobot](https://t.me/userinfobot).
3. Put both in **Settings → Telegram**, along with the workspace it should work in.

Only your user id can talk to the bot. Once it's connected, `/help` in the chat lists everything it can do — including `/voice`, which makes it answer out loud.

---

## Scheduled work

The agent can put itself to work on a schedule — a morning triage of yesterday's notes, a weekly summary, a reminder tonight at 6:50.

**The easy way is to ask.** Tell the agent "every morning at 6, review yesterday's notes and update TODO.md" and it writes the schedule itself. One-off requests work the same way: "remind me to call the dentist tonight at 6:50" becomes a job that fires once and then deletes itself.

Schedules live in a `cron.json` file at the root of your workspace, so you can also read and edit them yourself:

```json
[
  { "name": "nightly-triage", "schedule": "0 6 * * *", "prompt": "Review yesterday's notes and update TODO.md." }
]
```

- `name` — unique, and stable. Each run opens its own chat named after the job.
- `schedule` — standard cron syntax, or an ISO datetime (`"2026-03-14T18:50:00"`) for a one-off. Both use the timezone from **Settings → General**.
- `prompt` — sent to a fresh chat each run, so make it self-contained.
- `enabled` — set `false` to pause a job without deleting it.
- `once` — set `true` on a one-off so it removes its own entry after running.

Jobs run on the companion against its own checkout of the repo, so they don't need your computer. Next run, last run, and a manual **Run now** are behind the clock icon in the app's left rail.

A new schedule takes about a minute to register — the file has to reach GitHub first — so don't schedule something less than a couple of minutes out.
