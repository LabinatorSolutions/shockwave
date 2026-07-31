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
- `extraTools` — the pi tools this host implements: desktop `[open_file, send_message]`, companion `[send_message]`. Every one must also be named in `TOOL_CATALOG` or it is silently dropped (see "Tools" below).
- `dataDir(chatId)` — the pi scratch-dir root. **Desktop** returns one global `userData` dir; **companion** returns a **per-session** dir so concurrent runs don't share one `pi-agent/settings.json`.
- Persistence (dumb I/O — the core does all mapping): `getSession`, `upsertSession`, `appendMessages` (must be idempotent by `entryId` and assign ordering itself), `setSessionTitle`, `setRunning`, `getTranscript`, `putTranscript`, optional `onError`.
- Secret getters: `getAgentSecrets()` (decrypted metadata), `getToken(name)` (a usable credential). **Both hosts route `getToken` to the companion**, so OAuth refresh lives in one place (desktop over HTTP, companion via `mintToken` in-process).

The `emit` sink is passed **per `agentSend` call**, not stored on the host — so the desktop can re-target events after a window reload. Events are stamped with `chatId` inside the runtime.

## Files

- `agent.ts` — the runtime: `AgentHost`/`ChatRow`/`RunOpts`/`Entry` types, `createAgentRuntime`, the session lifecycle, `resolveModel`, `listThinkingLevels`.
- `agentTokens.ts` — `makeAgentTokenTools(getSecrets, getToken)` → the `list_agent_secrets` + `get_agent_secret` custom pi tools (getters closed over per-runtime, never module-global).
- `chatSearch.ts` — `search_chats`, the agent's memory of earlier chats in the workspace. ONE tool with three uses picked from the arguments: `query` searches, `chatId`+`around` reads a window, nothing lists recent. No model calls — every shape returns stored messages. Search returns whole CONVERSATIONS (deduped, so N results are N distinct chats), each with the hit, the messages either side, and the chat's opening and closing — a mid-conversation match is meaningless without them. Tool output is not indexed (one directory listing outweighs a whole conversation) and the current chat is excluded. Backed by `host.chatSearch`: the companion queries Postgres directly, the desktop over HTTP — same split as every other chat read.
- `sendMessage.ts` — `makeSendMessageTool(send)` → the `send_message` custom pi tool. One tool definition, two deliveries: the companion passes an in-process `sendTelegramMessage`, the desktop passes a `POST /telegram/send`. Same factory-closed-over-host-I/O shape as `agentTokens.ts`.
- `credentials.js` — **THE declaration of which settings fields are credentials**, and the path helpers its consumers share (`getPath`/`deletePath`/`setPathCopy`/`isSet`/`isDeletableCredential`). Nothing to do with the agent runtime; it lives here because `agent-core` is the only code bundled into **both** builds (the desktop's electron-vite build and the companion's esbuild — see `api/Dockerfile`). Plain `.js` so `node --test` loads it directly and both TypeScript builds import it without ceremony, same as `keys.js` and `linkParser.js`. Three consumers derive from it: the companion's `api/src/keys.js` (what to encrypt), `src/main/settingsStore.ts` (what to strip before the renderer), `src/renderer/settingsDiff.js` (what not to send back). It used to be written out three times, and a mismatch is not cosmetic — miss a field in the strip and it leaks to the screen, miss it in the send guard and an unrelated save deletes it. **Adding a credential is one edit, here.** Pinned by `tests/credentials.test.js`.
- `modelCatalog.ts` — the models.dev catalog: fetch/cache chain, `getCatalogModels`/`getCatalogModel`, `DEV_KEY` slug map.
- `skillLibrary.ts` — skill scanning + workspace-override resolution; writes the effective skill list into pi's settings at boot.
- `defaults/index.ts` — `assembleSystemPrompt` / `rebuildSystemPrompt` + re-exports.
- `defaults/tools.ts` — `TOOL_CATALOG` (the single source for the prompt list AND the pi allowlist), `only` scoping, `toolsForSource` / `activeToolNames`.
- `defaults/soul.ts` — `DEFAULT_SOUL`, `AGENTS_STUB`, `readSoul`.
- `defaults/helper.ts` — `buildShockwaveHelper` (the app operating-manual section of the prompt; `UNATTENDED` override) + `HELPER_MARK`, the seam `rebuildSystemPrompt` cuts on. Two sections carry policy rather than description: `SCHEDULED_RUNS` documents `cron.json` including one-time jobs (`"once": true` + an ISO datetime — see `api/CLAUDE.md`), and `REACHING_THE_USER` maps "send me / notify me / remind me / let me know / ping me" onto `send_message`, because on an unattended run a reply nobody reads is not a delivery. That section is included **only when `send_message` survives the tool filter** — telling the agent to call a tool it doesn't have is worse than saying nothing.
- `defaults/files.ts` — `DEFAULT_FILES` + `ensureWorkspaceFiles`/`missingWorkspaceFiles` (on-disk workspace scaffolding).

## Session lifecycle (`agent.ts`)

**One live pi `AgentSession` per chat**, keyed by `chatId` in a `sessions` map; in-flight boots share a `booting` map (two managers on one JSONL corrupt it). Chat IDs are minted by the **caller** (renderer / cron / telegram) and passed to `SessionManager.create({ id })`, so events route from the first millisecond.

- **Session cache key** (`makeKey`) = `workspacePath|provider|model|apiKey|baseUrl|contextWindow|thinkingLevel`. Any change reboots the session on the next send.
- **Validation** (`agentSend`, throws before any work): no chatId → "agentSend requires a chatId."; no workspacePath → "Open a workspace first."; **no provider → "Coding agent provider not configured."**; no model → "Coding agent model not configured."; non-`openai-compatible` with no apiKey → "…API key not configured." These are the errors the Telegram/cron runners surface when a required setting is unset — there is **no default** for provider/model/key (see the no-defaults policy in `api/CLAUDE.md`).
- **Steer mid-turn**: if the session is running, `session.prompt(text, { streamingBehavior: 'steer' })` — pi delivers it at the next step of the running turn.
  - Checked **before** the provider/model/apiKey validation: a steer joins an already-booted session, so the caller has nothing to supply (the Telegram relay passes no workspace or model at all).
  - `emit` is **not** re-pointed. It used to be, which handed the running turn's event stream to the second caller's sink — on Telegram that froze the first reply half-written and drew the remainder under the wrong message.
- **Create vs open (resume) — the stored transcript ALWAYS wins.** For an existing row, `bootSession` downloads `getTranscript` and overwrites the local file unconditionally, then opens it with the row's frozen `systemPrompt`. No row → `SessionManager.create(...)` with a freshly assembled prompt. **A row with no recoverable transcript throws** — silently starting a real conversation from an empty session is how a whole turn vanishes.
  - The local JSONL is only THIS machine's working copy. It goes stale the instant any other client (desktop, Telegram, cron, a second machine) takes a turn in the same chat, because that client uploads its own transcript and ours knows nothing about it. Anything present only on our disk is by definition something no other client has seen.
  - **Don't add a "keep the local file if it looks newer" test.** Line counts only imply ahead-ness on a shared lineage; once both sides diverge, that test picks the stale local copy — precisely the bug. The only loss from always-copying is pi's context from a turn whose transcript upload failed, and that self-heals (the whole file is re-uploaded every turn), the messages are already stored row-by-row, and the failure is reported via `host.onError`.
  - `findSessionFile` still LOOKS UP pi's file rather than reconstructing the name (pi writes `<timestamp>_<chatId>.jsonl`; the old hand-built `<chatId>.jsonl` never matched).
- **A live session is re-checked before reuse.** `ensureSession` returns the cached entry only after `transcriptMovedOn` confirms the row's `transcriptUpdatedAt` hasn't advanced past the value we last booted from / uploaded (`Entry.transcriptAt`). Without this, a long-lived host — the companion holds one session across Telegram messages — would skip boot entirely and never notice a turn another client took in between. That is exactly how a Telegram reply came back not knowing about a message sent from the desktop.
- **Config-change reboot**: a **running** entry is reused unconditionally (mid-turn config change waits); an idle entry reboots on the same JSONL when `key`/`workspacePath` changed.
- **Messages are stored AS THEY HAPPEN, not in a batch at the end.** `syncEntries` reads `sessionManager.getEntries()` — pi's own append-only log, where each entry already carries a stable unique id — on every `message_end` (and again after the turn), and appends anything not yet sent. So tool calls appear while the turn runs, and a turn that errors, is aborted, or times out keeps everything it managed to do.
  - Identity is pi's `entry.id`, never a position. `seq` used to be the message's index in `session.state.messages` — the RESOLVED LLM context, which legitimately shrinks (compaction), rewinds (branching), and gets spliced on a failed turn — inserted `ON CONFLICT DO NOTHING`. A later message could land on a slot a different earlier message already held and be silently discarded. Keyed by entry id, a conflict means "same message, already stored", so retries and bulk re-sends are safe.
  - **`entry_appended` is NOT a message hook** — don't reach for it. It's declared in `AgentSessionEvent`, but there is exactly one emit site (`dist/core/agent-session.js`): the *extension* API's `appendEntry(customType, data)`, which appends a **custom** entry. Conversation messages go through `sessionManager.appendMessage`, which emits nothing. The session events that actually fire during a turn are `agent_start`, `turn_start`, `message_start`, `message_end`, `message_update`, `turn_end`, `agent_end`, `agent_settled` — hence `message_end` plus a read of `getEntries()` for the ids.
  - Writes are chained per session (`writeChain`) so rows arrive in pi's order; a failed append stays in `pending` and is retried by `flushPending` after the turn.
- **End of turn**: `flushPending` → `uploadTranscript` → **then** `setRunning(null)` → best-effort auto-title. Running clears only after upload, so a cross-client viewer never sees "done" before the rows land. On throw, running clears immediately.
- **Failed-turn splice**: if the turn ended with `[user, assistant(stopReason:'error')]` (e.g. an oversized image), both are spliced out of pi's in-memory state so they don't re-poison later turns; a synthetic `agent_send_failed` event is emitted.
- **Auto-title** (`maybeGenerateTitle`): only when the row has no title; a `completeSimple` call over the first exchange, fire-and-forget.
- **pi→row mapping**: one pi message → one `ChatRow` (assistant → content/reasoning/toolCalls; toolResult → `role:'tool'`; else user).

## System prompt

`assembleSystemPrompt(workspacePath, { unattended, source })` returns `SOUL + helper`:
- **SOUL** = the workspace's `SOUL.md` (cwd root), else `DEFAULT_SOUL` in memory (never written). `SOUL.md` is a normal file the user edits — there is no settings UI for it.
- **helper** = `buildShockwaveHelper({ tools: toolsForSource(source), unattended })` — the app operating manual, sections as named consts, the tool list interpolated in.

The result is passed to pi as `systemPromptOverride`, replacing pi's built-in prompt. **pi then appends on its own at boot**: discovered `AGENTS.md`/`CLAUDE.md` (cwd→root), the enabled skills list, and `Current date`. So the final order is SOUL → helper → context files → skills → date, and agent-core deliberately does not add the last three.

**SOUL is frozen per chat; the helper is rebuilt every run.** The stored `systemPrompt` opens with `HELPER_MARK` at the helper's first line, and the resume branch runs `rebuildSystemPrompt(row.systemPrompt, { unattended, source })` — keep everything before the mark, regenerate everything after. The tool list is why: a chat created from Telegram and continued on the desktop would otherwise advertise its creator's tools, while the allowlist pi enforces is recomputed at every boot. SOUL stays frozen so a mid-conversation `SOUL.md` edit can't rewrite the agent's identity. A prompt stored before the mark existed has no seam and is used verbatim.

**Unattended mode (cron):** `assembleSystemPrompt(ws, { unattended: true })` inserts the `UNATTENDED` section, which overrides the "ask first" boundary — a scheduled run has no user, may create/edit/move/delete freely, and its work is committed after the run. Threads through `RunOpts.unattended` → the **create branch only**; a fresh uuid per cron run guarantees that branch, so cron is always unattended.

## Tools (`defaults/tools.ts`)

**`TOOL_CATALOG` is the single source** — filtered once per boot by the run's source (`toolsForSource` / `activeToolNames(source)`), and that ONE filtered list is BOTH the prompt's "Available tools" list (`formatToolList`) AND the pi allowlist (passed to `createAgentSession({ tools })`). One list so the prompt can't claim a tool pi lacks or miss one it has.

Catalog: builtins `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`; customs `list_agent_secrets`, `get_agent_secret`, `open_file`, `send_message`. **The allowlist is load-bearing:** pi's `discoverAndLoadExtensions` scans `<dataDir>/pi-agent/extensions/` unconditionally and *adds* whatever it finds; a stale extension file once made the prompt advertise 7 tools while pi ran 8. The allowlist bounds the set — a stray tool loads but is filtered out unless `TOOL_CATALOG` names it.

### Scoping a tool to where the turn runs (`only`)

`only?: ('desktop' | 'cron' | 'telegram')[]` on a catalog entry limits it to those sources (`RunOpts.source`). **Omit it and the tool goes everywhere — that's the default and what most tools want.** Today only `open_file` is scoped (`['desktop']`): it opens a tab in the app UI, and a cron or Telegram run has no UI. `source` is part of `makeKey`, so continuing one chat from a different side reboots the session instead of reusing the other side's tool set.

**A host tool MUST also be named in `TOOL_CATALOG`.** pi filters custom tools against the allowlist exactly like builtins (`_refreshToolRegistry` in pi's `agent-session.js`), so a host tool the catalog doesn't name is dropped in silence. That is precisely what happened to `send_message`: the companion supplied it, the catalog never listed it, and the agent told the user it had no way to reach Telegram. `agent.ts` now filters `host.extraTools` by the same allowlist and `console.warn`s on any tool that doesn't survive, so the drift is visible instead of mysterious.

Custom tools are in-process (`customTools`). `list_agent_secrets`/`get_agent_secret` come from `makeAgentTokenTools(host.getAgentSecrets, host.getToken)` — built once per runtime with the host getters closed over, which is what lets the same tool code run in two hosts. `list_agent_secrets` returns **metadata only**; `get_agent_secret` calls `getToken(name)` → a usable static token or fresh OAuth access token (routed to the companion), with a guideline not to echo the credential.

`send_message` follows the same pattern from `sendMessage.ts` — one definition, the delivery injected: companion → `sendTelegramMessage` in-process, desktop → `POST /telegram/send`. **The bot token is companion-only**, which is the whole reason the desktop asks rather than sends. Both sides offer the tool, so a Telegram chat answers on Telegram no matter which side runs the turn.

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
