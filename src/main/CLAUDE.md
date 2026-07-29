# CLAUDE.md — main process

Main-process internals. Code under `src/main/`. Cross-cutting invariants (terminology, link-index rules, parser parity, save-before-mutate) live in the **root `CLAUDE.md`** — read that first.

## Files

- `main.ts` — entry point. Window lifecycle, every IPC handler, watcher orchestration, `app://` protocol.

**Chats live on the companion.** Chat sessions, messages, and transcripts are stored on the companion (Postgres); the desktop reads/writes them through `src/main/api/chats.ts`. Each chat carries provenance — `source` (`desktop` | `cron` | `telegram`), `source_id` (identity within that source: the cron job name, telegram chat id, null for desktop), and `machine` (`os.hostname()` at creation). See the `chat`/`message` tables in `api/CLAUDE.md`.
- `settingsStore.ts` — the settings facade over the companion + a machine-local file: `readSettings`/`writeSettings`, `patchAgentSecretOAuth`, `LOCAL_DEFAULTS`. See "Settings persistence" below.
- `src/main/api/` — the desktop's whole bridge to the companion. `client.ts` (the HTTP client: `api.get/patch/post/del`, `api.stream` for SSE; `ApiError` with kinds `unreachable | unauthorized | server | config`; reads URL+key from `config.ts`). `net.ts` (`companionFetch` — a dedicated in-memory Electron `session` whose `setCertificateVerifyProc` trusts the companion's self-signed cert; this is why the companion can serve on Traefik's self-signed default). `config.ts` (`<userData>/api.json` — companion URL + `safeStorage`-wrapped API key, the only locally-stored secret). `localSettings.ts` (`<userData>/local-settings.json` — `LOCAL_KEYS`, window/view state, `activeWorkspaceId`, cron toggle, per-workspace `{path, syncEnabled}`). `chats.ts` (chat persistence + list/search over HTTP, backing `chat:*` and the agent host). `workspaces.ts` (workspace identity + local checkout/sync). `cron.ts` (read-only cron view).
- `pathResolver.ts` — `isMdFile`, `uniquePath` (same-dir uniqueness), `walkMarkdownPaths`, `isIgnoredSegment` (what `main.ts` imports). Disambiguation is **same-folder only**: `fs:createFile` / `fs:renameFileLiteral` / `fs:moveItem` auto-suffix within one folder; duplicate basenames across different folders are allowed (the link resolver disambiguates). (`uniqueInWorkspace` / `collectMarkdownBasenamesLower` are still exported but no longer imported by `main.ts` — the workspace-wide-uniqueness era is over.)
- `workspaceRow.js` — PURE `workspace` row → `WorkspaceEntry` projection (plain `.js`, unit-tested). The single place `sync_disabled` (0/absent = syncing) is negated into the renderer-facing `syncEnabled`; getting it backwards silently inverts every Sync switch with nothing failing, so all three polarity cases are pinned by tests.
- `workspaceFolder.js` — PURE folder classification for the add-workspace flow (plain `.js`, unit-tested under `node --test`): `classifyFolder` → `empty` | `clone` | `occupied`, plus `parseGithubUrl` / `cloneUrlFor` / `repoMismatch` / `sameRepo` (case-insensitive, as GitHub is). No electron import — pure + testable, the wiring around it isn't. `sync.ts` re-exports these.
- `linkParser.js` — ESM mirror of the wiki-link parser in `src/renderer/linkIndex.js` (intentionally kept as `.js` so both processes load the exact same module bytes — see parser-parity rule in root).
- `renameCorrelator.js` — pairs unlink+add events into rename events. See below.
- `watcherDispatch.js` — maps a `@parcel/watcher` event batch to correlator/pending-state calls. Imported by BOTH `main.ts` (real sinks) and the correlator/e2e tests (tmp-dir sinks), so main and the tests exercise identical watcher logic — same parity discipline as `linkParser.js`. Handles the parcel-specific shapes: atomic-save-as-`create`-of-known-path, folder-rename via directory expansion, deletes-before-creates batch ordering.
- `codingAgent.ts` — the **desktop host** for the shared `agent-core` runtime: builds the `AgentHost` (I/O, secret getters, chat persistence via `api/chats.ts`) and calls `createAgentRuntime(host)`, re-exporting `agentSend`/`agentAbort`/etc. All turn logic lives in `agent-core` (see "Coding agent (desktop host)" below and `agent-core/CLAUDE.md`).
- `openFileExtension.ts` — the `open_file` custom pi tool (`OPEN_FILE_TOOL` + `installOpenFileBridge`), the one tool the desktop host adds to the shared `agent-core` runtime. (Cron, skills, agent-tokens, the system prompt, and the model catalog all moved to `agent-core/` / the companion — see "Coding agent (desktop host)" below.)
- `oauth.ts` — the interactive OAuth2 **connect** flow for `oauth`-kind agent secrets (arctic + a loopback callback server; BYO Desktop-app client). Token storage + refresh happen on the companion; this just runs the browser flow and posts the result. See "OAuth for agent secrets" below.
- `cliTools.ts` — generates per-CLI shim scripts (`firecrawl`, `playwright-cli`) into `<userData>/pi-agent/bin/` that run each bundled CLI via the app's own Electron binary in Node mode, then `prependPath` puts that dir on `PATH` so the agent's bash inherits it. Regenerated every launch (`ensureCliShims` / `prependPath`).
- `sync.ts` — GitHub sync support: REST helpers (`verifyPat`, `createRepo`, `listRepos`), the `gitSpawn` wrapper that injects a PAT via `GIT_ASKPASS`, the git-presence check, and the workspace setup flows. **`ensureCheckout`** makes a folder BE a checkout of `owner/repo` whatever state it starts in — clone if empty, verify-and-leave-alone if it's already that repo, refuse otherwise — so adding a workspace and checking one out on this machine are one operation, not two implementations of it. `createWorkspaceRepo` stays separate because creating a repo also scaffolds it. Folder classification itself lives in `workspaceFolder.js`; it is the one place that reads `.git/config`, ONCE at setup, to learn what a folder already is (not the per-tick re-derivation the row replaced). The old `setupLink` (git-init an arbitrary folder and force a remote onto it) is gone — adopting now requires the remote to already be there.
- `syncEngine.ts` — singleton per-workspace tick engine. Sequential ticks (pause-if-conflicts → flush → commit → fetch → **merge** if behind → push), status state machine (with a `conflicts[]` payload on pause), per-file + whole-tree conflict resolution (`resolveConflict`/`keepConflict`/`resetConflict`/`keepAll`/`resetToRemote`), flush-renderer-dirty bridge, drain-on-quit hook. **Every git op — the tick and each resolution op — runs through one serial chain (`exclusive`)**; the interval SKIPS when the chain is busy, user-driven ops QUEUE. Conflict ops also refuse any path the engine isn't currently bound to.

## File watcher

`@parcel/watcher` (native, N-API — ABI-stable across Electron bumps). One `subscribe()` per active workspace (lifecycle: started in `loadWorkspace`, stopped in `loadWorkspace`/`removeWorkspace`/`before-quit`), plus a second `subscribe()` on `.shockwave/` for `workspace.json`. parcel is always recursive and reports only changes after subscribe (no initial scan) — seeding is our only startup enumeration. Per-path events are coalesced within a 150ms window; `.md` adds/changes are read + parsed in main (reusing `linkParser.js`).

parcel-specific handling (all in `watcherDispatch.js`): events are `{type: 'create'|'update'|'delete', path}` with **no mtime and no file/dir discriminator**, so the dispatch stats each path (for the inode + to reject directories); a `create` of an already-known path is an atomic save (temp-write + rename-over) and is treated as a modification; a folder rename arrives as delete(oldDir)+create(newDir) and is expanded into per-file events (paired by inode → per-file renames); deletes in a batch are dispatched before creates so rename pairing always has the unlink buffered first. The `ignore` globs are a perf hint; the authoritative dotfile filter is `isIgnoredWatchPath` in the callback.

Events shipped to the renderer (via `fs:changed`):

- `{type:'add'|'change', path, mtime, outgoingLinks}` — `.md` file appeared or modified
- `{type:'add'|'change', path, mtime}` (no `outgoingLinks`) — a `.excalidraw` drawing or a non-`.md` **reloadable text/code file** (`isReloadableText` — everything in `OPENABLE_RE` except the `.md` family, images, video, drawings) changed. Bypasses the rename correlator (link-index machinery); the renderer re-reads the file to reload an open canvas/buffer, keyed by its own mtime store (`drawingMtimesRef` / `textMtimesRef`) for the self-echo guard.
- `{type:'unlink', path}` — `.md`/drawing/reloadable-text file removed (grace window already elapsed without a paired add)
- `{type:'rename', oldPath, newPath, mtime, outgoingLinks}` — paired by the correlator (inode primary, hash fallback); `.md` only (drawings/text surface as unlink+add)
- `{type:'tree'}` — folder change or a non-reloadable change (binaries, etc.) — tree refresh only

The watcher only sees inside the active workspace, and `isIgnoredWatchPath` skips any path with a dotfile segment (`.git`, `.obsidian`, `.shockwave`, etc.) — mirrors `buildTree`. The `.shockwave/` segment is how we store our own per-workspace data (bookmarks) without echoing back through the main watcher (a separate subscription watches it for `workspace.json`).

### End-to-end pipeline

The watcher is a state machine spread across `main.ts` (orchestration), `watcherDispatch.js` (event mapping), and `renameCorrelator.js` (rename pairing). The flow from a parcel event batch to the renderer:

```
@parcel/watcher subscribe(root) (fsevents on macOS)
   │
   ├── batch of {type: create|update|delete, path}
   ▼
onParcelEvents → watchDispatch.handleBatch(events)   (deletes first, then creates/updates)
   │
   ├─ drawing / reloadable-text path? → pend as add/change (mtime-only event; bypasses correlator)
   ├─ other non-.md path? → markTreeOnly() → pendingTreeOnly = true; scheduleFlush() (150ms debounce)
   ├─ directory? → create: walk .md inside and upsert each; delete: unlink every known .md under it
   └─ .md file? → stat ino + hash file, hand to correlator:
                    create (unknown path) → correlator.onPathAppeared(p, ino, hash)
                    create (known path) / update → onPathSeen(p, ino, hash); pendingByPath.set(p, 'change')
                    delete → correlator.onPathGone(p)  (buffered for 800ms grace)
   ▼
createRenameCorrelator
   │
   ├─ pairs `unlink(old)` + `add(new)` by inode (primary) or sha1 hash (fallback for FAT/SMB/etc.)
   └─ emits ONE of: { type: 'rename', oldPath, newPath } | { type: 'add', path } | { type: 'unlink', path }
        ▼
   setupCorrelator's emit callback:
        rename  → renameQueue.push(e); scheduleFlush()
        unlink  → pendingByPath.set(p, 'unlink'); scheduleFlush()
        add     → pendingByPath.set(p, prev === 'unlink' ? 'change' : 'add'); scheduleFlush()
   ▼
flushWatcher (fires 150ms after the first scheduleFlush since last flush)
   │
   ├─ renames first: read content + stat, send {type:'rename', oldPath, newPath, mtime, outgoingLinks}
   ├─ then per-path entries: unlink → send {type:'unlink', path}; add/change → read + parse + send
   └─ if treeOnly + nothing else: send {type:'tree'}
        ▼
win.webContents.send('fs:changed', evt)  →  renderer's onFsChanged
```

Pipeline invariants:

1. **The watcher windowId is captured at `watchStart`.** Subsequent flushes target that window via `BrowserWindow.fromId(watcherWindowId)`. If the window is destroyed and re-created (full reload), the watcher must be restarted to pick up the new id.
2. **Coalescing key is the path.** Multiple events for the same path within the 150ms window collapse to the latest type, with one special case: `unlink → add` for the same path collapses to `change` (atomic save pattern from vim/VS Code).
3. **The rename correlator buffers unlinks for `RENAME_GRACE_MS` (800ms).** If a paired add arrives in that window with matching inode or content hash, it's emitted as `rename` instead of separate unlink+add. After the grace period, buffered unlinks become real unlinks.
4. **Renames go through `renameQueue`, not `pendingByPath`.** They're already paired events and shouldn't be merged with per-path bursts.
5. **Self-echo guard is mtime-based.** `fs:writeFile` and `fs:createFile` return the file's `stat.mtimeMs` (sub-ms float) post-write. The renderer stores that exact value via `linkIndex.updateFile(path, text, mtime)`. The watcher's later flush re-stats and ships the same `stat.mtimeMs`. `evt.mtime > stored` is false → skip. Never substitute `Date.now()` for the renderer-side mtime — integer ms compared to a sub-ms float makes every save look fresh and the editor reloads mid-typing. See "Real mtimes everywhere" in the root invariants.
6. **Seeding runs synchronously on `watchStart`.** Every `.md` under the root is stat'd + sha1'd before `subscribe()` is awaited. Without this, an unlink fired immediately after startup couldn't be correlated (we'd have no prior identity to match against). It also feeds `correlator.isKnown` / `knownUnder`, which the dispatch relies on to classify atomic saves and expand folder deletes.

### Rename correlator (`renameCorrelator.js`)

External actors — Finder, `mv`, `git checkout`, a coding agent shelling out to `fs.rename` — bypass the in-app rename flow. Without intervention, the watcher would see a rename as unrelated `unlink(old) + add(new)` events, references in other files would break, and the link index would lose the connection between the old and new paths.

The correlator buffers unlinks and pairs them with subsequent adds:

- **Primary key: inode.** `fs.stat(p, { bigint: true }).ino` is stable across `fs.rename` on every realistic filesystem (NTFS, APFS, ext4, btrfs, xfs). The correlator stores `{path → {ino, hash}}` for every known file; on `unlink`, it buffers the identity; on `add`, it stats the new file's ino and matches against buffered unlinks.
- **Fallback: content hash.** For filesystems where ino is unreliable (FAT, exFAT, some SMB shares), the correlator falls back to matching the SHA-1 of the file contents (computed eagerly on `onPathSeen` because the file is gone by the time `unlink` fires).
- **Grace window.** `RENAME_GRACE_MS = 800` in `main.js`. Buffered unlinks that aren't claimed within that window are emitted as real `unlink` events.
- **Atomic saves** (vim/VS Code write-temp-then-rename-over-existing) come through parcel as `create` of the existing destination (+ a delete of the temp). The dispatch sees the destination is already known (`correlator.isKnown`) and treats it as a modification, not a rename — see `tests/correlator.integration.test.js`.

## Settings persistence

Settings have two homes, and `settingsStore.ts` hides the split behind `readSettings`/`writeSettings` — one flat `Settings` object, so every call site in `main.ts`/`oauth.ts` and the whole renderer is unchanged:

- **Synced settings** (agent config + provider keys, agent secrets, `sync.pat`, transcription, appearance, timezone, workspace *identity*) live on the **companion** (Postgres) — the single source of truth, which encrypts every credential. The desktop reaches them through the API client in `src/main/api/` (`readSettings` → `GET /settings`, `writeSettings` → `PATCH /settings`). See **`api/CLAUDE.md`** for the storage + encryption model.
- **Machine-local settings** (window/view state, the cron master toggle, the active workspace, each workspace's checkout path + sync toggle) live in `<userData>/local-settings.json` (`src/main/api/localSettings.ts`) and never sync.
- **The companion connection itself** — URL + API key — lives in `<userData>/api.json` (`src/main/api/config.ts`), the key `safeStorage`-wrapped. This is the **only** secret the desktop stores locally; all other secrets are on the companion.

### DB is the source of truth — nothing faked on read

`readSettings` returns the companion's settings **verbatim**, then overlays the machine-local values (`overlayLocal`). It does **not** merge a defaults object over them, so an unset synced value reads as unset, never faked. The only desktop defaults are `LOCAL_DEFAULTS` in `settingsStore.ts`, and they cover **machine-local keys only**.

This matters because the companion is read by more than the desktop — the Telegram and cron runners read it directly. A desktop-side default that filled an unset value would make a setting *look* configured while those runners saw the hole and failed. That is exactly what a former `DEFAULT_SETTINGS` merge did to `codingAgent.provider`: the desktop showed `anthropic` from its default while the DB had no row, so the server-side agent threw "provider not configured". Required synced settings therefore have **no default** and error at their consumer; optional ones fall back **at the point of use** (see `api/CLAUDE.md`). `readSettingsSafe` never throws — on an unreachable companion it returns machine-local settings only, so the app boots to a "connect your companion" state.

### Writes are disjoint + pushed

- **`writeSettings` writes only the keys in the patch**, split by destination: machine-local keys → the local file, `workspaces` → the workspace endpoint, everything else → `PATCH /settings`. The renderer's `persistSettings` sends just what changed (diffed against its in-memory cache in `settingsDiff.js`), so a credential it happens to hold isn't republished on an unrelated save.
- **`settings:changed` pushes main's own writes to the renderer.** Main writes settings the renderer can't observe — OAuth token refresh, window bounds, cron toggles — so `emitChanged(keys)` broadcasts `{ keys, settings }` and the renderer applies **only** those keys, so an unrelated main write can't stomp a field the user is editing. The `settings:write` IPC passes `notify: false` (the renderer already has what it just wrote). The renderer's `settingsRef` (`useSettings`) is a render cache, not the truth.

Adding a persisted **synced** field: extend the `Settings` type in `src/shared/settings.ts`, add a slice + setter in the renderer's `useSettings` hook, and — if it holds a credential — register its pattern in the companion's `keys.js`. There is **no** desktop `DEFAULT_SETTINGS` to update; a synced field with no value is simply unset, handled at its consumer (required → error, optional → point-of-use fallback). A **machine-local** field goes in `LOCAL_KEYS` / `LOCAL_DEFAULTS` (`settingsStore.ts`) + `localSettings.ts`.

> **Legacy note.** The pre-companion build stored settings in a local sqlite `shockwave.db` with a desktop master key (`masterkey.enc`) and routed secrets via `settingsKeys.js`. That's gone: `masterKey.ts` and `settingsKeys.js` were deleted, all storage + secret encryption moved to the companion (`api/src/{store,crypto,keys}.js`), and `importLegacySettingsIfNeeded()` is now a no-op (its `whenReady` call site is vestigial).

### OAuth for agent secrets

An `agentSecrets[]` entry is either `kind: 'static'` (a pasted token, in `.token`) or `kind: 'oauth'` (an OAuth2 connection, in `.oauth` — see `AgentSecretOAuth` in `src/shared/settings.ts`). `oauth.ts` runs the whole flow in main:

- **BYO client, RFC 8252 loopback.** The user creates their own OAuth client in the provider console (Google → "Desktop app" client type) and pastes `clientId`/`clientSecret`. `startConnect` opens the **system browser** (`shell.openExternal`) to the consent URL and catches the redirect on a throwaway `http` server bound to `127.0.0.1:<ephemeral port>`. No embedded webview; the app never sees credentials. Ephemeral port ⇒ Google works (it accepts any loopback port); exact-match providers like GitHub do not (see each preset's `hint`).
- **arctic** (`arctic@^3.7.0`, ESM — externalized, resolved by the ESM main at runtime) is used **only for the pure authorize-URL + PKCE building** (`createAuthorizationURLWithPKCE`, `CodeChallengeMethod.S256`, `generateState`, `generateCodeVerifier`). The **token exchange + refresh are our own `fetch`** (`postToken`), NOT arctic's `validateAuthorizationCode`/`refreshAccessToken`: arctic 3.7.0 manually sets a `Content-Length` header on its token request, which Electron's undici rejects with `UND_ERR_INVALID_ARG` "invalid content-length header" — the request never leaves the app. Our `postToken` sends a `URLSearchParams` string body with only `Content-Type`/`Accept` (undici computes Content-Length) and puts `client_id`+`client_secret` in the body. `PROVIDER_PRESETS` bakes in endpoints/scopes/quirks (Google's `access_type=offline` + `prompt=consent` guarantees a refresh token).
- **State/verifier live in-memory** for the flow's lifetime (a webapp would use httpOnly cookies; we have neither). `state` is checked on the callback (CSRF). 5-min timeout.
- **Token refresh/minting for the agent happens on the companion**, not here — `oauth.ts` no longer has `getFreshToken`. The desktop agent host's `getToken` calls `GET /agent-secret/:name/token`, and the companion refreshes an OAuth access token (rotating the refresh token) or returns the static token. This desktop `oauth.ts` only runs the interactive connect/disconnect and posts the result to the companion (`patchAgentSecretOAuth` → `POST /oauth/:name`).
- **Settings reads are injected** via `initOAuth({ readSettings })` (called once at startup, before any `oauth:*` IPC) to avoid a circular import back into `main.ts`. Writes don't need injecting — `patchSecret` calls `patchAgentSecretOAuth` (`settingsStore.ts`), which `POST`s to the companion's `/oauth/:name`; the companion writes **only** this connection's token rows in `secret_value` plus its OAuth status columns on `agent_secret`, in one transaction. (Token storage — and refreshing/minting fresh tokens for **server-side** Telegram/cron runs — lives on the companion; see `api/CLAUDE.md`. The desktop still runs the interactive connect flow below.) It used to read-modify-write the entire `agentSecrets` array, which raced the renderer's own array write: the renderer's copy was built from pre-refresh state, so it could overwrite a token main had just rotated, and Google rotates refresh tokens on every refresh — a lost write killed the connection permanently. Two guards now: the writes are disjoint, and `OAUTH_OWNED_FIELDS` (`oauth.accessToken`, `oauth.refreshToken`) + `OAUTH_OWNED_COLUMNS` (`oauthExpiresAt`, `oauthStatus`, `oauthAccountEmail`) bar any bulk `writeSettings` from authoring them at all, so a stale echo can't win even in principle. `clientId`/`clientSecret` are deliberately NOT owned — the user enters those in Settings. `patchAgentSecretOAuth` also emits `settings:changed(['agentSecrets'])`, so the renderer picks up fresh status on its own; the explicit `reloadAgentSecrets` call after Connect/Disconnect is now a belt rather than the mechanism.
- IPC: `oauth:listPresets`, `oauth:startConnect`, `oauth:disconnect`.

## `app://media/...` protocol

Registered before `app.ready` via `registerSchemesAsPrivileged({scheme: 'app', privileges: {standard, secure, supportFetchAPI, stream}})` so the renderer can fetch it with `webSecurity` intact. Requests resolve `<rel>` against `watcherRootDir` (the active workspace), reject path traversal outside the workspace with 403, and stream the file via `net.fetch(file://…)`. `<img src="app://media/…">` in the live-preview decoration loads with no extra wiring.

## Window bounds persistence

`attachWindowBoundsPersistence` tracks the last-known unmaximized bounds and persists `{ x, y, width, height, maximized }` to `settings.windowBounds` on a 400ms debounce, with a final flush on `close`. The `will-quit` handler `event.preventDefault`s once, drains the **sync engine**, then calls `app.exit()`. It no longer drains a settings queue: `windowBounds` is machine-local, so its write is a synchronous local-file write (`local-settings.json`, tmp+rename) that has completed by the time `writeSettings` resolves, and a fast Cmd+Q can't lose it. On restore, `boundsAreVisible` checks the saved rect against currently-attached displays and falls back to the default 1200×800 if it no longer intersects any display.

## Coding agent (desktop host)

**All the turn logic lives in `agent-core/`** (session lifecycle, steering, system prompt, tools, skills, model resolution, the failed-image splice — see `agent-core/CLAUDE.md`). `codingAgent.ts` is a thin (~57-line) desktop **host**: it builds the `AgentHost` and calls `agent-core`'s `createAgentRuntime(host)`, then re-exports `agentSend` / `agentAbort` / `agentDisposeSession` / `agentDisposeAll` / `agentRunningSessions` / `listThinkingLevels`.

What the desktop host supplies to `agent-core`:

- `builtinDir` (bundled built-in skills), `machine: os.hostname()`, `extraTools: [OPEN_FILE_TOOL, SEND_MESSAGE_TOOL]`, `dataDir: () => app.getPath('userData')` (one global pi scratch dir — the companion uses a per-session dir instead).
- Chat persistence closures from `src/main/api/chats.ts` — `getSession`, `upsertSession`, `appendMessages`, `setSessionTitle`, `setRunning`, `getTranscript`, `putTranscript`. So **chats are stored on the companion**, not locally; the runtime just calls these.
- Secret getters (`getAgentSecrets` / `getToken`), injected by `initDesktopAgent()` in `main.ts`. `getToken` calls the companion (`GET /agent-secret/:name/token`), so OAuth refresh happens server-side; the desktop only runs the interactive connect flow (`oauth.ts`).

Chats run concurrently (one live pi session per chat). Events forwarded to the renderer (`agent:event` / `agent:error`) are stamped with `chatId`; `agent:runningChats` returns in-flight ids (the renderer reseeds after a window reload).

### Live feed — one always-on stream

`startLiveFeed()` (called once in `whenReady`, stopped on `before-quit`) holds **one** SSE connection to the companion's `GET /events` for the life of the app, carrying every chat's events — Telegram, cron, and the same chat open on another machine — and forwards them into the same `agent:event` channel a local turn uses, so a remote turn draws identically. It reconnects forever with backoff; on reconnect it fires `chat:feedResync` so the renderer re-reads its loaded chats (anything during the outage was missed).

Events for sessions THIS machine is running are dropped (`agentRunningSessions()`): they already reached the renderer over IPC, and we POST every one of them up to `/chat/:id/events` so other clients see them — the copy coming back would double-render.

**It is always on by design.** This used to be a per-chat subscription (`chat:watchStart`/`watchStop`) started from the renderer when you clicked a chat that happened to be running elsewhere *at that instant* — so a Telegram turn was never watched, and a chat already on screen could never start listening at all. Don't reintroduce a per-chat subscription: the point is hearing about chats the desktop doesn't yet know exist.

**Desktop tools** (both supplied via `extraTools`):

- **`open_file`** (`openFileExtension.ts`) — `OPEN_FILE_TOOL` + `installOpenFileBridge`, opens a file in the app from a turn. Scoped `only: ['desktop']` in `agent-core`'s `TOOL_CATALOG`: cron and Telegram runs have no UI to open a tab in.
- **`send_message`** (`codingAgent.ts`, built from `agent-core/sendMessage.ts`) — DMs the user on Telegram by `POST /telegram/send` to the companion. The desktop holds no bot token; it asks. Without it, a chat started in Telegram and continued in the app couldn't reply on Telegram.

The agent-tokens tools (`list_agent_secrets` / `get_agent_secret`) and the whole `TOOL_CATALOG` live in `agent-core`. Anything added to `extraTools` **must** also be named in that catalog — pi drops unlisted custom tools silently (see `agent-core/CLAUDE.md`).

**Model/provider discovery IPC** — handlers stay in `main.ts`, logic in `agent-core/modelCatalog.ts`: `agent:listProviders` (pi's list filtered to `SUPPORTED_PROVIDER_SLUGS` in `src/shared/constants.ts`), `agent:listModels` (the models.dev catalog), `agent:listThinkingLevels`, `agent:validateConnection` (checks an openai-compatible `{baseUrl}/models`). `initModelCatalog` is called once in `whenReady`.

**`ensureBuiltinSecretSlots()`** (`main.ts`): auto-provisions empty agent-secret slots on the companion for the `required-secrets` a workspace's enabled built-in skills declare — adds missing names, never overwrites.

## Workspace default files

The manifest (`SOUL.md`, `AGENTS.md`, `.ignore`, `.gitignore`) and `ensureWorkspaceFiles` live in **`agent-core/defaults/files.ts`** (see `agent-core/CLAUDE.md`). Main only *calls* it, from two IPC paths — `workspace:ensureFiles` (manual; `overwrite` replaces all, renderer confirms first) and `createWorkspaceRepo` (automatic, for a fresh repo the user made here) — plus `workspace:listFiles` to report what's missing. It deliberately does **not** scaffold on clone/adopt (`ensureCheckout`) or on workspace switch: pushing files into a repo the user may not own, or writing on every activation, would be surprising. A cloned workspace with no `SOUL.md` falls back to `DEFAULT_SOUL` in memory.

## Scheduled runs (cron) — companion-side

Cron **runs on the companion** now (`api/src/scheduler.ts` + `cronRun.ts` — see `api/CLAUDE.md`), not in main. `cron.json` at the workspace root is still the job source of truth. The desktop keeps only three thin pieces:

- A machine-local master toggle + windows (`settings.cron`, in `local-settings.json`).
- A **read-only view** — `src/main/api/cron.ts` composes job definitions from the active workspace's local `cron.json` with run status from `GET /workspace/:id/cron/state`.
- Two IPC channels: `cron:read` and `cron:runNow` (→ `POST /workspace/:id/cron/:name/run`). There are no `cron:setEnabled`/`setMaxCatchupHours`/`setMaxRunMinutes` handlers and no `cron:state`/`cron:chatsChanged` push events.

## GitHub sync

Per-workspace background sync to GitHub. Two files: `sync.ts` (one-shot helpers + setup) and `syncEngine.ts` (the singleton tick loop).

### Auth model

PAT is stored encrypted in `sync.pat` **on the companion** (`secret_value`, owner `settings` — see `api/CLAUDE.md`); the desktop reads the decrypted value through `readSettings`. For shell git, the decrypted PAT is set on the child process's `GITHUB_PAT` env, and `GIT_ASKPASS` points at `<userData>/sync/askpass.sh` — a tiny posix helper that echoes `x-access-token` for `Username` prompts and `$GITHUB_PAT` for everything else. The PAT lives in process memory only for the lifetime of that one git child. **Never written to `.git/config`**; remote URLs stay plain `https://github.com/owner/repo.git`. REST calls use a `Bearer` header with the same memory-only lifetime.

### Tick (sequential, never overlapping)

0. **`git diff --name-only --diff-filter=U -z` → if any unmerged files exist, emit `paused` + the conflict list and RETURN — before step 2.** `git add -A` on a conflicted tree stages the marker-laden files and git treats them resolved, so push would ship `<<<<<<<` garbage. This bail is the entire defense; it must run first. (`-z` / NUL-split is required — the default output escapes spaces/unicode paths.)
1. `sync:flushRequest(token)` → renderer flushes dirty editor tabs → `sync:flushDone(token)`. **1 s timeout** so a hung renderer can't stall the engine.
2. `git status --porcelain`; if dirty → `git add -A` + commit (message `Shockwave sync: <ISO>`). A `git commit` here with `MERGE_HEAD` present also **concludes a resolved-but-open merge** — that's how the engine stays *stateless* about the pause (once conflicts are gone, the normal commit finishes the merge).
3. `git fetch origin <branch>`, then `git rev-list --count HEAD..origin/<branch>` to see if the remote is ahead. Fetch failing with "couldn't find remote ref" = no remote branch yet (fresh init) → skip to push.
4. If the remote is ahead → **`git merge origin/<branch>`** (NOT rebase — merge touches only genuinely-differing files and resolves in one pass; rebase replayed every auto-commit and churned the tree). On conflict the merge leaves unmerged files + `MERGE_HEAD`; emit `paused` + the list and return.
5. If local is ahead → `git push --set-upstream origin <branch>`.

### Conflict resolution (driven by the renderer's conflict view)

While paused, the renderer surfaces the conflict list and lets the user resolve. All of these stage the index (serialized with the tick via the `ticking` guard), re-list conflicts, and — when the list hits empty — kick a tick immediately so the merge commit + push happen at once:

- `resolveConflict(ws, rel)` — accept the file as hand-edited: `git add <rel>`.
- `keepConflict(ws, rel)` — keep ours: `git checkout --ours -- <rel>` + add.
- `resetConflict(ws, rel)` — take remote: `git checkout --theirs -- <rel>` + add.
- `keepAll(ws)` — whole tree, keep ours: `git checkout --ours .` + `git add -A` (then the merge completes; remote's non-conflicting changes still come in).
- `resetToRemote(ws)` — whole tree, take remote: `git merge --abort` + fetch + `git reset --hard origin/<branch>` (discards ALL local divergence — the renderer confirms first).

### Status state machine

`sync:status` push event carries `{ status, detail, lastSyncAt, repoUrl, conflicts }`. `conflicts` is the workspace-relative path list, present only on `paused`-for-conflicts (every other emit resets it to `[]` — see `emitStatus`):

- `unconfigured` — sync not set up (no origin / no PAT), or a benign engine stop (workspace switch / window reload). **Renderer hides the icon.**
- `idle` — synced. `lastSyncAt === null` = "not synced yet" (gray cloud); set = synced (cloud-check).
- `syncing` — a tick is in progress; `detail` describes the current step.
- `paused` — **merge conflicts** (carries `conflicts[]`). The engine is stateless — once unmerged files are gone, the next tick completes the merge and resumes (see the per-file / whole-tree resolution above).
- `offline` — **a transient/network error. Sync is NOT off — it backs off (10s → 30s → 1m) and keeps retrying forever.** `state.retryAt` gates ticks during backoff; a confirmed fetch clears it.
- `disabled` — **stopped**: the user turned it off (`userDisable`), or a *terminal* error stopped it (`disableOnError` — clears the interval). The renderer shows the **stop** icon; clicking it → reason + **Enable** (→ `setWorkspaceDisabled(false)` → `engineStart`).

**Network NEVER disables sync.** Only `isTerminalGitError` (an allowlist: big file `GH001`, secret `GH013`, protected branch, auth/perms, repo-not-found) routes a failure to `disabled`. Anything unrecognized → `offline` + retry. Bias is intentional: when unsure, keep trying, don't turn off.

### Lifecycle

- `start({ workspacePath, pat, intervalSeconds, windowId })` — stops any previous instance, looks the workspace row up by path and takes repo + branch FROM THE ROW (no `git remote get-url`, no per-tick `rev-parse`), then kicks the interval. **First tick fires immediately** so a workspace switch doesn't wait up to `intervalSeconds` before picking up remote changes.
- `stop()` — clears the interval and awaits the in-flight tick (so a partial commit/push never leaks).
- `drainBeforeQuit()` — called from `before-quit`. Same as `stop()` minus the disabled-status emit. Without this, a fast Cmd+Q could kill a child mid-push.

### Flush bridge

`requestFlush()` posts a token to the renderer and resolves either when the renderer acks via `sync:flushDone(token)` or when the 1 s timeout fires. Pending flushes are tracked in a `Map` keyed by token. The renderer subscribes once on mount (not per workspace) and reads `writeNow` via a ref — same discipline as the `fs:changed` listener.

The flush runs at the head of every tick, so on a fast-typing user the engine's `git add` + `git commit` will see and stage the just-flushed buffer — but `writeNow` records the file's real `stat.mtimeMs` in the link index as the canonical "last self-write." When chokidar fires its echo for the same write ~350ms later, the watcher's `evt.mtime` equals the stored value and the self-echo guard skips it. Without that exact-mtime match the watcher would treat the renderer's own save as an external change and reload the editor mid-typing. See "Real mtimes everywhere" in the root `CLAUDE.md` — this is the chain that broke in v1.0.1 when a wrapper dropped the mtime arg.

### Platform support

`ensureAskpass` writes the right credential helper for the host: a posix `.sh` on macOS/Linux, a `.cmd` batch file on Windows (both answer `x-access-token` for the `Username` prompt and `$GITHUB_PAT`/`%GITHUB_PAT%` for the password). `gitSpawn` is otherwise platform-agnostic, so sync runs on all three platforms wherever `git` is on PATH.

## Voice transcription IPC

`voice:getToken` mints a short-lived (60s) AssemblyAI streaming token. The long-lived API key (`settings.transcription.apiKey`) never leaves main — the renderer requests a fresh streaming token on each WebSocket connection. The actual WebSocket + audio pipeline lives in the renderer; see `src/renderer/CLAUDE.md`.

## IPC surface

| Group | Handlers |
|---|---|
| Dialogs | `dialog:openFolder` |
| FS | `fs:readTree`, `fs:readAllMarkdown`, `fs:readFile`, `fs:writeFile`, `fs:createFile`, `fs:renameFileLiteral`, `fs:duplicateFile`, `fs:trashFolder`, `fs:trashFile`, `fs:trashFiles`, `fs:createFolder`, `fs:ensureDir`, `fs:moveItem`, `fs:renameFolder`, `fs:writeImage`, `fs:pathExists`, `fs:importFiles`, `fs:rebuildLinkCache`, `fs:watchStart`, `fs:watchStop` |
| Shell | `shell:revealInFolder`, `shell:openExternal` |
| Context menus | `context:fileMenu` (`conflictMode` → Conflict resolved / Keep our file / Reset to remote), `context:conflictCloudMenu` (whole-tree keep/reset), `context:folderMenu`, `context:editorMenu` |
| Settings | `settings:read`, `settings:write` (writes only the keys present); plus push event `settings:changed` (`{keys, settings}`, main-initiated writes only) |
| OAuth | `oauth:listPresets`, `oauth:startConnect`, `oauth:disconnect` |
| Bookmarks | `bookmarks:read`, `bookmarks:write` |
| Theme | `theme:getInitial`; plus `theme:systemChanged` push event |
| Voice | `voice:getToken` |
| Agent | `agent:send` (takes `chatId`; steers if that chat is mid-turn), `agent:abort` (per chatId), `agent:runningChats`, `agent:listProviders`, `agent:listModels`, `agent:listThinkingLevels`, `agent:validateConnection` (checks an openai-compatible `{baseUrl}/models`); plus push events `agent:event` / `agent:error` (stamped with `chatId`) |
| Chat (all over HTTP to the companion) | `chat:list`, `chat:listPinned`, `chat:setPinned`, `chat:search`, `chat:getMessages` (optional `after` seq), `chat:open` (returns the row + messages + this machine's `workspacePath` for the chat's workspace), `chat:delete`, `chat:rename`; plus push event `chat:feedResync` (the live feed reconnected — re-read loaded chats) |
| Skills | `skills:list`, `skills:libraryDir`, `skills:importPicker`, `skills:importFromPath`, `skills:remove` |
| Workspaces | `workspace:inspectFolder`, `workspace:createWithRepo`, `workspace:addFromRepo` (covers both clone-into-empty and adopt-a-clone), `workspace:setUpHere`, `workspace:remove`, `workspace:forgetLocal`, `workspace:listFiles`, `workspace:ensureFiles` |
| Workspace settings | `workspaceSettings:read`, `workspaceSettings:update` (per-workspace `.shockwave/workspace.json` — daily-note config, templates, built-in-skill toggles) |
| Cron | `cron:read`, `cron:runNow` (the desktop's read-only view; cron runs on the companion) |
| Telegram | `telegram:status`, `telegram:connect`, `telegram:disconnect`, `telegram:setWorkspace` (thin passthroughs to the companion `/telegram/*`; the companion owns the bot) |
| Companion config | `api:read`, `api:write`, `api:test` (the "connect to your server" form — URL + key, key `safeStorage`-wrapped; `api:test` also returns the companion's release version), `api:checkVersion` (classify desktop-vs-companion via `versionCompare.js` — `companion-older` is the only status that offers an upgrade), `api:upgradeCompanion` (`POST /update` with this desktop's version — the companion's updater sidecar does the pull + restart) |
| App / updates | `app:machineId`, `app:checkForUpdates`, `app:getUpdateStatus`, `app:restartToUpdate` (electron-updater); plus update-status push events |
| Sync | `sync:verifyPat`, `sync:checkGit`, `sync:listRepos`, `sync:setWorkspaceDisabled`, `sync:engineStart`, `sync:engineStop`, `sync:engineStatus`, `sync:flushDone`, `sync:listConflicts`, `sync:resolveConflict`, `sync:keepConflict`, `sync:resetConflict`, `sync:keepAll`, `sync:resetToRemote`; plus push events `sync:status` (carries `conflicts[]` when paused), `sync:flushRequest` |

The renderer reaches every one of these via `window.api.*` — see `src/preload/preload.cjs`. The renderer never touches Node directly.
