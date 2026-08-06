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

Three steps, about fifteen minutes.

### 1. Download the app

| Platform | Download |
|---|---|
| **macOS** (Apple Silicon) | [Shockwave-mac.dmg](https://github.com/stephengpope/shockwave/releases/latest/download/Shockwave-mac.dmg) |
| **Windows** | [Shockwave-windows.exe](https://github.com/stephengpope/shockwave/releases/latest/download/Shockwave-windows.exe) |
| **Linux** | [Shockwave-linux.AppImage](https://github.com/stephengpope/shockwave/releases/latest/download/Shockwave-linux.AppImage) |

### 2. Start your server

Your notes, keys and chats live on a small server you own — any cheap Linux VPS will do. It's also what keeps working when your laptop is shut.

```bash
curl -fsSL https://raw.githubusercontent.com/stephengpope/shockwave/main/api/install.sh | sh
```

It asks a few questions. Press Enter through them if you're not sure — the defaults work. When it finishes it prints a **Server URL**, an **API key**, and a **fingerprint**. Keep them.

### 3. Fill in three settings pages

| Page | What goes in it |
|---|---|
| **Companion** | the Server URL and API key from step 2 |
| **GitHub Sync** | a [GitHub token](https://github.com/settings/personal-access-tokens) — this is what makes syncing free |
| **Agent Chat** | a model provider, and that provider's API key |

Then add a workspace and you're going. The app shows a dot on the settings gear until all three pages are done, so you can always see what's left.

### Notes

- **First launch** — the builds aren't signed yet, so you get a one-time warning. macOS: right-click → **Open**, or `xattr -cr /Applications/Shockwave.app`. Windows: **More info → Run anyway**. Linux: `chmod +x` the AppImage first.
- **git** — a workspace is a GitHub repo checked out locally, so the app needs `git` on your PATH. Most systems have it. If not, the app shows you how to get it.
- **The fingerprint** — if you skipped the domain, the app asks you to approve the server's certificate. Check it matches what the installer printed. That one comparison is what makes the connection yours and not someone else's.
- **GitHub token** — needs `Contents: Read and write`, plus `Administration: Write` if you want the app to create repos for you.
- **Ports** — 80 and 443 have to be reachable, which usually means opening them in your VPS provider's firewall too.
- **Installer options** — `--yes` skips the questions, `--domain=` gives you a real certificate and no fingerprint to approve, plus `--cert-email=` and `--no-firewall`.

---

## Running the server

The installer leaves a `shockwave` command on the box:

```
shockwave status         # are the containers up
shockwave logs           # follow the logs
shockwave check          # test the URL, certificate and key the app uses
shockwave fingerprint    # show the certificate fingerprint again
shockwave rotate-cert    # replace the certificate
```

When the server falls behind the app, the app offers to update it for you — one click, nothing to log into. Re-running the install command does the same from the server side. Either way your data and secrets are left alone.

If it stops responding it should recover on its own: containers restart on crash, on reboot, and when a health check notices the API has gone quiet. `shockwave check` says which part is unhappy.

---

## Your agent on Telegram

Your agent in your pocket, on the same notes, whether or not your laptop is open.

Message it and the agent works on your workspace and pushes what it changed. Send a voice note instead of typing. Send a photo or a document and it'll use it. Ask for a file and it sends it back. Reply to any of its messages to pick that conversation back up. While a long job runs, `/btw` asks what it's doing without interrupting it.

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy the token.
2. Get your numeric user id from [@userinfobot](https://t.me/userinfobot).
3. Put both in **Settings → Telegram**, with the workspace it should work in.

Only your user id can talk to the bot. `/help` lists the rest — including `/voice`, which makes it answer out loud.

---

## Scheduled work

Ask the agent to do something on a schedule and it sets that up itself:

> *"every morning at 6, review yesterday's notes and update TODO.md"*
>
> *"remind me to call the dentist tonight at 6:50"*

One-offs delete themselves once they've run. Everything runs on the server, so your laptop can be shut. Next run, last run and a manual **Run now** live behind the clock icon in the left rail.

Schedules are stored in `cron.json` at the root of your workspace, so you can also edit them yourself:

```json
[
  {
    "name": "nightly-triage",
    "schedule": "0 6 * * *",
    "prompt": "Review yesterday's notes and update TODO.md."
  }
]
```

| Field | |
|---|---|
| `name` | Unique and stable. Each run opens a chat named after it. |
| `schedule` | Cron syntax, or an ISO datetime like `2026-03-14T18:50:00` for a one-off. |
| `prompt` | Sent to a fresh chat each run, so make it self-contained. |
| `enabled` | Set `false` to pause a job without deleting it. |
| `once` | Set `true` on a one-off so it removes its own entry after running. |

Times use the timezone from **Settings → General**. A new schedule takes a minute or so to register, so don't set one for less than a couple of minutes out.
