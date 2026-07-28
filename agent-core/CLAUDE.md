# CLAUDE.md — shared agent runtime (`agent-core/`)

`agent-core/` is the **coding-agent runtime**, wrapping pi (`@earendil-works/pi-coding-agent` + `@earendil-works/pi-ai`). It holds **all** the turn logic — session boot/resume, running + steering a turn, the pi→row mapping, upload-then-clear ordering, resume-from-JSONL, auto-title, model resolution, system-prompt assembly, tools, skills, the model catalog.

It is esbuild-bundled into **both** hosts, so one change lands in both:
- **Desktop** — host in `src/main/codingAgent.ts`; one live session per chat, events → renderer via IPC, persistence → the companion over HTTP (`src/main/api/chats.ts`).
- **Companion** — host in `api/src/agentHost.ts` (`makeCompanionRuntime`); persistence → Postgres directly (`store.ts`), events → the SSE feed. Runs Telegram + cron turns.

Read the root `CLAUDE.md` first. Deep docs for each host: `src/main/CLAUDE.md`, `api/CLAUDE.md`.

## The host/runtime split

**`AgentHost`** (interface, `agent.ts`) is all host-specific I/O, **no logic**. Each host implements it and calls **`createAgentRuntime(host)`**, which returns `{ agentSend, agentAbort, agentDisposeSession, agentDisposeAll, agentRunningSessions }`. What the host supplies:

- `builtinDir` — path to the bundled built-in skills.
- `machine` — `os.hostname()`, stamped on chats for provenance.
- `extraTools` — host-only pi tools: desktop `[open_file]`, companion `[send_message]`.
- `dataDir(sessionId)` — the pi scratch-dir root. **Desktop** returns one global `userData` dir; **companion** returns a **per-session** dir so concurrent runs don't share one `pi-agent/settings.json`.
- Persistence (dumb I/O — the core does all mapping + ordering): `getSession`, `upsertSession`, `persistMessages`, `setSessionTitle`, `setRunning`, `getTranscript`, `putTranscript`.
- Secret getters: `getAgentSecrets()` (decrypted metadata), `getToken(name)` (a usable credential). **Both hosts route `getToken` to the companion**, so OAuth refresh lives in one place (desktop over HTTP, companion via `mintToken` in-process).

The `emit` sink is passed **per `agentSend` call**, not stored on the host — so the desktop can re-target events after a window reload. Events are stamped with `sessionId` inside the runtime.

## Files

- `agent.ts` — the runtime: `AgentHost`/`ChatRow`/`RunOpts`/`Entry` types, `createAgentRuntime`, the session lifecycle, `resolveModel`, `listThinkingLevels`.
- `agentTokens.ts` — `makeAgentTokenTools(getSecrets, getToken)` → the `list_agent_secrets` + `get_agent_secret` custom pi tools (getters closed over per-runtime, never module-global).
- `modelCatalog.ts` — the models.dev catalog: fetch/cache chain, `getCatalogModels`/`getCatalogModel`, `DEV_KEY` slug map.
- `skillLibrary.ts` — skill scanning + workspace-override resolution; writes the effective skill list into pi's settings at boot.
- `defaults/index.ts` — `assembleSystemPrompt` + re-exports.
- `defaults/tools.ts` — `TOOL_CATALOG` (the single source for the prompt list AND the pi allowlist).
- `defaults/soul.ts` — `DEFAULT_SOUL`, `AGENTS_STUB`, `readSoul`.
- `defaults/helper.ts` — `buildShockwaveHelper` (the app operating-manual section of the prompt; `UNATTENDED` override).
- `defaults/files.ts` — `DEFAULT_FILES` + `ensureWorkspaceFiles`/`missingWorkspaceFiles` (on-disk workspace scaffolding).

## Session lifecycle (`agent.ts`)

**One live pi `AgentSession` per chat**, keyed by `sessionId` in a `sessions` map; in-flight boots share a `booting` map (two managers on one JSONL corrupt it). Chat IDs are minted by the **caller** (renderer / cron / telegram) and passed to `SessionManager.create({ id })`, so events route from the first millisecond.

- **Session cache key** (`makeKey`) = `workspacePath|provider|model|apiKey|baseUrl|contextWindow|thinkingLevel`. Any change reboots the session on the next send.
- **Validation** (`agentSend`, throws before any work): no sessionId → "agentSend requires a sessionId."; no workspacePath → "Open a workspace first."; **no provider → "Coding agent provider not configured."**; no model → "Coding agent model not configured."; non-`openai-compatible` with no apiKey → "…API key not configured." These are the errors the Telegram/cron runners surface when a required setting is unset — there is **no default** for provider/model/key (see the no-defaults policy in `api/CLAUDE.md`).
- **Steer mid-turn**: if the session is running, re-point `emit` and `session.prompt(text, { streamingBehavior: 'steer' })` — pi queues it into the running turn.
- **Create vs open (resume)**: a DB row with no local JSONL is rehydrated by writing `getTranscript` to disk, then `SessionManager.open(jsonlPath)` with the row's frozen `systemPrompt`. No row → `SessionManager.create(...)` with a freshly assembled prompt.
- **Config-change reboot**: a **running** entry is reused unconditionally (mid-turn config change waits); an idle entry reboots on the same JSONL when `key`/`workspacePath` changed.
- **Upload-then-clear ordering**: on success, `persistMessages` → `putTranscript` → **then** `setRunning(null)` → best-effort auto-title. Running clears only after upload, so a cross-client viewer never sees "done" before the rows land. On throw, running clears immediately.
- **Failed-turn splice**: if the turn ended with `[user, assistant(stopReason:'error')]` (e.g. an oversized image), both are spliced out of pi's in-memory state so they don't re-poison later turns; a synthetic `agent_send_failed` event is emitted.
- **Auto-title** (`maybeGenerateTitle`): only when the row has no title; a `completeSimple` call over the first exchange, fire-and-forget.
- **pi→row mapping**: one pi message → one `ChatRow` (assistant → content/reasoning/toolCalls; toolResult → `role:'tool'`; else user).

## System prompt

`assembleSystemPrompt(workspacePath, { unattended })` returns `SOUL + helper`:
- **SOUL** = the workspace's `SOUL.md` (cwd root), else `DEFAULT_SOUL` in memory (never written). `SOUL.md` is a normal file the user edits — there is no settings UI for it.
- **helper** = `buildShockwaveHelper({ tools: TOOL_CATALOG, unattended })` — the app operating manual, sections as named consts, the tool list interpolated in.

The result is passed to pi as `systemPromptOverride`, replacing pi's built-in prompt. **pi then appends on its own at boot**: discovered `AGENTS.md`/`CLAUDE.md` (cwd→root), the enabled skills list, and `Current date`. So the final order is SOUL → helper → context files → skills → date, and agent-core deliberately does not add the last three. The assembled string is part of `makeKey`, so it's baked once per session.

**Unattended mode (cron):** `assembleSystemPrompt(ws, { unattended: true })` inserts the `UNATTENDED` section, which overrides the "ask first" boundary — a scheduled run has no user, may create/edit/move/delete freely, and its work is committed after the run. Threads through `RunOpts.unattended` → the **create branch only**; a fresh uuid per cron run guarantees that branch, so cron is always unattended.

## Tools (`defaults/tools.ts`)

**`TOOL_CATALOG` is the single source** — it is BOTH the prompt's "Available tools" list (`formatToolList`) AND the pi allowlist (`ACTIVE_TOOL_NAMES`, passed to `createAgentSession({ tools })`). One list so the prompt can't claim a tool pi lacks or miss one it has.

Catalog: builtins `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`; customs `list_agent_secrets`, `get_agent_secret`, `open_file`. **The allowlist is load-bearing:** pi's `discoverAndLoadExtensions` scans `<dataDir>/pi-agent/extensions/` unconditionally and *adds* whatever it finds; a stale extension file once made the prompt advertise 7 tools while pi ran 8. The allowlist bounds the set — a stray tool loads but is filtered out unless `TOOL_CATALOG` names it.

Custom tools are in-process (`customTools`). `list_agent_secrets`/`get_agent_secret` come from `makeAgentTokenTools(host.getAgentSecrets, host.getToken)` — built once per runtime with the host getters closed over, which is what lets the same tool code run in two hosts. `list_agent_secrets` returns **metadata only**; `get_agent_secret` calls `getToken(name)` → a usable static token or fresh OAuth access token (routed to the companion), with a guideline not to echo the credential.

## Model catalog (`modelCatalog.ts`)

Sources the Settings model dropdown from **models.dev** (`/api.json`) — fresher than pi's bundled list; pi stays the execution engine. Cache chain (10-min TTL): live fetch → memory + disk (`<userData>/model-catalog.json`) → stale memory → disk → pi's bundled `getModels()`. Concurrent callers share one in-flight fetch. The only hand-maintained bit is `DEV_KEY` (our slug → models.dev key).

`resolveModel(provider, model)` (used at boot and by `api/src/gitFixer.ts`): pi's bundled `getModel` wins; else **synthesize** a runnable pi Model from the models.dev record by cloning a sibling model's provider wiring and overlaying the metadata. `listThinkingLevels` returns `['off', ...reasoningLevels]`; `toPiThinkingLevel` translates models.dev's top tier **`max` → pi's `xhigh`** (same translation at boot, so the dropdown value is exactly what executes).

## Skills (`skillLibrary.ts`)

Two skill kinds, both fed to pi as **explicit absolute paths at boot** (pi never auto-discovers these dirs):
- **Built-in** — bundled under `host.builtinDir`; enabled/disabled **per workspace** via `.shockwave/workspace.json` `builtinSkills` (absent key ⇒ enabled).
- **Workspace/uploaded** — user folders under `<workspace>/.shockwave/skills/<skill>/SKILL.md`; git-synced; presence ⇒ enabled.

`computeEffectivePaths` merges them keyed by lowercased folder name, so an uploaded skill **shadows** a built-in of the same name. The result is written as `skills: []` into `<dataDir>/pi-agent/settings.json` (`writePiSettings`, atomic) each boot; pi reads `skills` only at boot, so Clear-chat reloads a changed set. `SKILL.md` frontmatter (`name`/`description`/`required-secrets`) is parsed by `readSkillFolder`.

## Workspace default files (`defaults/files.ts`)

`ensureWorkspaceFiles` seeds `SOUL.md`, `AGENTS.md`, `.ignore` (contains `.git/` — pi's grep runs ripgrep with a hardcoded `--hidden`, and ripgrep honors `.ignore` independently, the only lever from outside pi), and `.gitignore` (OS droppings only — deliberately NOT `.shockwave/`, which should sync). Every write is `wx` (fail-if-exists) unless `overwrite:true`. Runs on repo creation (auto) and `workspace:ensureFiles` (manual) — never on clone/adopt or workspace switch.
