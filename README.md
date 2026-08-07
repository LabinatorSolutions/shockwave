<h1><img src="build/icon.png" width="40" align="top" alt="" />&nbsp;Shockwave</h1>

A simple notes app with a built-in AI agent that organizes everything and does work for you (with a free sync that works across all your devices).

For non-technical note-takers who want AI agents with smart features — like memory, self-improvement — but without the setup hassle.

[macOS · Windows · Linux · **Download ↓**](#install)

---

Want to learn to build apps like this? Join the **[AI Architects](https://skool.com/ai-architects)**.

---

## Why Shockwave

### 🧠 Knowledge Base — Get it out of your head. It stays organized on its own.

Get it all out of your head, ideas, projects, due dates. The agent keeps it in order for you, so you never sit down to a pile of notes that needs processing. And because everything's in one place, the agent can use it and even complete the work for you.

### 🧬 It Learns You — Memory and self-improvement, built in

Everything the power tools give you — memory, self-improvement — and it keeps learning how you work.

### 🛰 Always On — Close the laptop. It keeps working.

Create work for the agent, then close the laptop and the work keeps getting done without you. And you can also pick up where you left off on any other device, even on your phone.

### 🔄 FREE Sync — A better agent file sync (with history) that costs nothing

Most notes apps charge you to sync across devices — we use GitHub instead. It also handles file sync conflicts automatically.

---

## Install

### 1. Download the app

| Platform | Download |
|---|---|
| **macOS** (Apple Silicon) | [Shockwave-mac.dmg](https://github.com/stephengpope/shockwave/releases/latest/download/Shockwave-mac.dmg) |
| **Windows** | [Shockwave-windows.exe](https://github.com/stephengpope/shockwave/releases/latest/download/Shockwave-windows.exe) |
| **Linux** | [Shockwave-linux.AppImage](https://github.com/stephengpope/shockwave/releases/latest/download/Shockwave-linux.AppImage) |

Not signed yet, so you get one warning the first time: macOS right-click → **Open**, Windows **More info → Run anyway**, Linux `chmod +x` the AppImage.

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

Then add a workspace and you're going. Each page tells you what it wants, and a dot on the settings gear stays until all three are done.

---

## Running the server

Day to day there's nothing to do — the app updates the server for itself, and the containers restart themselves if anything falls over.

When you do need it: **[looking after the server](docs/server.md)** covers the `shockwave` command, backups, certificates and what to check when the app can't connect.

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
