# CLAUDE.md — bundled built-in skills

The skills every workspace gets without the user installing anything. Three today: `excalidraw`, `firecrawl-cli`, `playwright-cli`.

A skill is a folder with a `SKILL.md` — YAML frontmatter plus instructions the agent reads. The loader is pi's; the scanning, the per-workspace enable/disable, and the shadowing rules are in **`agent-core/skillLibrary.ts`** (read "Skills" in `agent-core/CLAUDE.md` first — this file is only what's special about the *bundled* kind).

## Both hosts ship the same folder

This directory is the `builtinDir` for the desktop **and** the companion, so the agent behaves the same whether a turn runs in the app, from Telegram, or on a cron schedule. Two different mechanisms get it there and both have to be kept in mind when adding a skill:

- **Desktop** — `extraResources` in `package.json` copies it to `<resources>/built-in-skills`. `builtinSkillsDir()` in `src/main/main.ts` reads `process.resourcesPath` when packaged and the repo path in dev, so a skill added here is live in `npm run dev` with no build step.
- **Companion** — `api/Dockerfile` does `COPY resources/built-in-skills/ ./built-in-skills/` and sets `BUILTIN_SKILLS_DIR`. That copy is why `companion-image.yml` builds from the **repo root** rather than `api/`.

A skill that works in dev but not in a packaged app is almost always a missing `extraResources` entry; one that works on the desktop but not from Telegram is the Dockerfile half.

## Frontmatter that the app (not pi) reads

- **`required-secrets`** (comma-separated agent-secret names) is ours. `ensureBuiltinSecretSlots()` in `main.ts` walks every installed built-in at startup and **provisions an empty agent-secret slot for each name it doesn't already have** — so the user finds `FIRECRAWL_API_KEY` waiting on Settings → Agent Secrets with a description instead of having to know to create it. It only ever ADDS; it never overwrites a slot that exists, and it ignores the per-workspace toggle because agent secrets are global while enablement is not.
- **`description`** is what the model reads to decide whether the skill applies, and pi emits it **whole** into the prompt — there is no truncation to write around (hermes' 60-character limit is deliberately not ported; see `skillValidate.ts`). Write it as trigger phrases the user would actually say, which is why the shipped ones enumerate "draw me a…", "sketch out…", "fetch this page".
- **`name`** must satisfy pi's rule (lowercase, digits, hyphens; no leading/trailing or consecutive hyphens) and must not collide with a name in any other skill root. **pi keeps exactly one skill per name and the `.agents` copy wins**, logging a collision diagnostic nothing surfaces — so a colliding name silently shadows rather than erroring. Note `firecrawl-cli/SKILL.md` declares `name: firecrawl`: the folder name and the frontmatter name are allowed to differ, and **frontmatter is what pi keys on**.

## Skills that shell out to a bundled CLI

`firecrawl-cli` and `playwright-cli` are not self-contained — they invoke commands that have to be put on `PATH` first, and **each host does that its own way**:

- **Desktop** — `src/main/cliTools.ts` generates a shim per CLI into `<userData>/pi-agent/bin/` and prepends that dir to `PATH`. The shims exist because the packaged app ships no system Node: each one runs the CLI with the app's own Electron binary in Node mode, through the `NODE_OPTIONS` preload in `cli-tools/preload.js`. The packages live in `cli-tools/` (installed by `npm run cli-tools`, `asarUnpack`ed so they're real files on disk).
- **Companion** — `api/Dockerfile` installs the same `cli-tools/package.json` into the image and puts `node_modules/.bin` on `PATH`. There is a real Node here, so none of the shim machinery applies — no shims, no preload.

So a bundled-CLI skill spans four places — this folder, `cli-tools/package.json`, `cliTools.ts`'s `CLIS` list, and `api/Dockerfile` — and adding one means all four. **`cli-tools/package.json` is the single pinned version list for both hosts**; never duplicate the dependency into `api/package.json`, or the two can drift.

That's also why `playwright-cli/SKILL.md` opens by telling the agent **not** to run `npm install` or `npx playwright`: the CLI is already on PATH and the usual setup advice would send it down a path that can't work here. A bundled-CLI skill should say so up front.

**Both CLIs work on both hosts, and chromium is baked into the image at build time** so no companion run ever downloads a browser. The version linkage is the thing to be careful with: the browser folder is named `<PLAYWRIGHT_BROWSERS_PATH>/chromium_headless_shell-<revision>`, the revision comes from the playwright inside `cli-tools/node_modules`, and the CLI looks in that exact folder and nowhere else. Bumping `@playwright/cli` therefore makes an already-baked browser invisible — which is fine only because the Dockerfile re-bakes from the same pinned list on the same rebuild. Never install the browser with a separately fetched playwright; a mismatch is a hard "Executable doesn't exist" at launch.

The desktop's browser is still lazy — it downloads on first use into `<userData>/ms-playwright` (`PLAYWRIGHT_BROWSERS_PATH`, set in `main.ts`). If a skill needs something one host doesn't have, say so in `SKILL.md` rather than leaving a Telegram run to discover a missing command.

## Enabling

Built-ins are on unless a workspace turns them off — `.shockwave/workspace.json`'s `builtinSkills` map, absent key ⇒ enabled, edited at Settings → Manage Skills. The effective list is written into pi's settings at session boot, and **pi reads `skills` only at boot**, so a toggle takes effect on the next new chat rather than the current one.
