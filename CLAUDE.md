# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run dev` — start electron-vite (`electron-vite dev --watch --remoteDebuggingPort=9222`). Builds main + preload, serves the renderer on :5173, launches Electron, and auto-reloads on any `src/**` change. CDP for the renderer is exposed on :9222.
- `npm run build` — production build to `out/` (main, preload, renderer).
- `npm start` — `electron-vite preview` against the production build.
- `npm run dist` — build then `electron-builder` (produces dmg/nsis/AppImage per `build` block in `package.json`).
- `npm test` — run the test suite (`node --test "tests/**/*.test.js"`, no install needed).
- `npm run lint` — ESLint over `src/**` + `tests/**` (config in `eslint.config.js`). **`agent-core/` and `api/src/` are not linted** — they're covered by the two typecheck gates instead.
- `npm run typecheck` — `tsc --noEmit` (permissive TS; see below). **This does not cover `api/`** — that tree has its own gate, below.
- `npm run cli-tools` — install the bundled CLIs the agent shells out to (`cli-tools/`, see below) and clean npm's self-link. A separate top-level step, never a postinstall: nested inside `npm ci` it dies with EPERM on the Windows runner.
- `npm run ui:diff` — read-only upstream drift report for the vendored shadcn components (`npm run ui:diff -- button` for one). See "Reusable UI primitives" in `src/renderer/CLAUDE.md`.
- **Companion** (`api/`) is a separate server with its own scripts + Docker deploy — see `api/CLAUDE.md`. Local dev: `cd api && docker compose up -d --build` (postgres + api + traefik), or bare `npm run build && node dist/server.js`. `cd api && npm run typecheck` is its type gate — the root one can't see it (nothing under `src/` imports `api/`), and esbuild bundles without checking. Schema tooling: `npm run db:push` / `db:generate` (drizzle-kit).

## TypeScript

The codebase is TS with a deliberately permissive posture: `strict: true` but `noImplicitAny: false` in `tsconfig.json`. Conversions favor "kill `.jsx` extensions" over fully-typed annotations — many components use `any` for state. Treat that as the migration baseline, not a target.

**`checkJs` is on and there are no unchecked source files left.** `src/`, `agent-core/` and `api/src/` are TypeScript end to end; the only `.js`-family file is `src/preload/preload.cjs`, which is CommonJS because Electron's preload must be. Two gates, because esbuild strips types without checking them in *both* builds: `npm run typecheck` at the root (covers `src/**` plus everything it imports, which pulls in `agent-core`), and `npm run typecheck` in `api/` (covers `api/src/**` plus `agent-core` again, against the companion's own dependency versions). Neither build checks anything — run both.

### How imports are spelled — two rules, and the second one is not optional

Vite has an `extensionAlias` (in `electron.vite.config.js`) and esbuild does the same rewrite natively, so **app-side imports are written `./foo.js` and resolve to `./foo.ts`** at dev, build, and bundle time. That's why the source is full of `.js` import strings — don't "fix" them. The alias also maps `.jsx` → `.tsx`, which is why React components are still imported as `./App.jsx` / `./FileTree.jsx` while every one of those files is `.tsx` on disk. Same rule, same reason: the specifier is a build-time key, not a filename.

**A module the test suite loads spells its own imports `.ts`.** `npm test` runs `node --test` straight off the source with no build step — that's what makes the suite installable-free and fast — and **Node resolves a specifier literally**: it has no `extensionAlias`, so `./foo.js` does not find `foo.ts`. Node strips types natively (22.18+), so the extension is the whole constraint.

Concretely, that means:
- Every `tests/*.test.js` import names `.ts` (`from '../src/renderer/linkIndex.ts'`).
- A tested module importing another tested module names it `.ts` too — today `renameOps.ts`, `metadataCache.ts`, `settingsDiff.ts`, and `api/src/keys.ts`.
- Everything else keeps `.js`. Rewriting the whole app would be churn for nothing.

`allowImportingTsExtensions: true` (both tsconfigs, legal because they're `noEmit`) is what lets tsc accept the `.ts` spelling. **This is why the parser, the rename logic and the credential declaration sat unchecked as `.js` for so long** — being under test is what pinned them, not neglect. If you add a test for a module, change that module's imports to `.ts` in the same move.

Cross-process types live in `src/shared/`:
- `api.d.ts` — the typed `window.api.*` surface (what preload exposes).
- `settings.ts` — typed `Settings` shape. (Synced settings live on the **companion** — the source of truth; the desktop keeps no `DEFAULT_SETTINGS`. Only machine-local settings have desktop defaults: `LOCAL_SETTINGS` in `src/main/api/localSettings.ts`.)
- `constants.ts` — shared enums + `APP_NAME`.

For day-to-day workflow (when to restart, how to read main vs renderer logs, how to attach to the renderer via CDP for headless debugging, IPC discipline), use the **electron-dev** skill at `.claude/skills/electron-dev/SKILL.md`.

## Architecture

Electron app with a Vite + React 19 renderer. The renderer is a markdown-workspace editor (CodeMirror 6) with wiki-links (`[[name]]`), backlinks, tabs, drafts, multiple workspaces, a force-graph view, a live-preview / raw view-mode toggle, an editor status bar, bookmarks, daily notes, quick search, image embeds, voice input, and a right-hand coding-agent chat sidebar (pi).

**Markdown is the default, not the only thing it opens.** The same tab strip also hosts other text/code files (any extension in `OPENABLE_RE`, plus an allowlist of extensionless dotfiles), image/video previews, and editable Excalidraw drawings. Which viewer a tab gets is decided by `src/renderer/MediaView.tsx`'s `isOpenable` / `mediaKind` / `isDrawing`; see "Files that aren't markdown" in `src/renderer/CLAUDE.md`.

### Process boundary

- **Main** (`src/main/`): filesystem, dialogs, context menus, settings (a thin client over the companion API + a machine-local userData file — no local DB), `nativeTheme`, the file watcher + rename correlator, the `app://media/...` protocol for serving workspace images, window-bounds persistence, the desktop host for the shared **`agent-core`** coding-agent runtime (one live pi session per chat, concurrent; the turn logic lives in `agent-core`, this side supplies I/O), the voice-token mint (AssemblyAI, Deepgram or ElevenLabs) and the voice list for the settings picker, auto-update. Entry: `src/main/main.ts` — ~3,000 lines, and **every IPC handler in the app is registered in it** (~110 of them), so expect a long file rather than a slim entry point; the subsystems it calls into are the separate modules beside it. **Deep doc: `src/main/CLAUDE.md`.**
- **Preload** (`src/preload/preload.cjs`): exposes a single `window.api` surface (typed in `src/shared/api.d.ts`). The renderer never touches Node — every fs/dialog/agent call goes through `window.api.*`. Also exposes `webUtils.getPathForFile` so the renderer can resolve drag-dropped folder paths (skill import).
- **Renderer** (`src/renderer/`): React app rooted at `main.tsx` → `App.tsx`. `App.tsx` composes 11 hooks from `src/renderer/hooks/` (where the per-domain state lives) and owns what genuinely spans them: the save lifecycle, tree rename/move, the conflict view, and the tree/link-index helpers. It is ~2,500 lines — the hook extraction is real, but "thin" would overpromise; read it expecting an orchestrator with substance, not a shell. Vite root is `src/renderer/` (configured in `electron.vite.config.js`); build output goes to `out/renderer/`. Built main/preload land at `out/main/index.js` and `out/preload/index.cjs`. **Deep doc: `src/renderer/CLAUDE.md`.**
- **Companion** (`api/`): a separate Node/Express + Postgres server the desktop talks to over HTTP — the source of truth for synced settings, secrets, workspaces, and chats, and the host that runs the coding agent for Telegram and cron. Runs in Docker (compose: postgres + api + traefik). Not part of the Electron app; the desktop reaches it via `src/main/api/`. **Deep doc: `api/CLAUDE.md`.**

### Where things live

| Area | File(s) | Deep doc |
|---|---|---|
| Main-process internals (watcher, IPC, settings, app://, coding agent, voice token, GitHub sync engine) | `src/main/*.ts` | `src/main/CLAUDE.md` |
| Renderer internals (hooks, editor decorations, file tree, chat sidebar, voice, bookmarks, daily notes, quick search, sync UI) | `src/renderer/**` | `src/renderer/CLAUDE.md` |
| Settings pages (when a value saves, credential fields, per-section inventory) | `src/renderer/settings/**` | `src/renderer/settings/CLAUDE.md` |
| Companion server (settings/secrets/chats storage, server-side agent for Telegram + cron, Docker deploy) | `api/**` | `api/CLAUDE.md` |
| Shared coding-agent runtime (pi wrapper — bundled into BOTH the desktop and the companion) | `agent-core/**` | `agent-core/CLAUDE.md` |
| Voice, both directions (hearing you, and answering out loud) | `agent-core/{voiceProviders,transcribe,speak,spokenText,voiceReply}.ts`, `src/renderer/settings/VoiceSection.tsx`, `src/renderer/voice/**`, `api/src/telegram/sendTool.ts` | the voice entries in `agent-core/CLAUDE.md` |
| Reviews (the agent writes its own skills after enough work) | `api/src/{backgroundSweeper,backgroundRun}.ts`, `agent-core/manageSkill.ts`, `agent-core/skill{Validate,Tool}.ts`, `agent-core/fuzzyMatch.ts`, `agent-core/defaults/reviewPrompt.ts` | "Background runs" in `api/CLAUDE.md` |
| Memory (what the agent knows about you and this workspace) | `agent-core/memory{Store,Tool}.ts`, `agent-core/defaults/memoryPrompt.ts`, `api/src/{backgroundSweeper,backgroundRun}.ts`; the files themselves are `MEMORY.md` / `USER.md` at the workspace root | "Memory" in `agent-core/CLAUDE.md` |
| GitHub sync (merge-based; in-app conflict resolution) | `src/main/sync.ts`, `src/main/syncEngine.ts`, `src/renderer/settings/WorkspacesSection.tsx`, `src/renderer/settings/AddWorkspaceDialog.tsx`; conflict view in `src/renderer/{App.tsx, SortBar.tsx, FileTree.tsx}` | "GitHub sync" sections in both subdocs |
| Cross-process types + constants | `src/shared/{api.d.ts, settings.ts, constants.ts}` | this file, below |
| Bundled skills the agent gets out of the box | `resources/built-in-skills/**`, `cli-tools/`, `src/main/cliTools.ts` | `resources/built-in-skills/CLAUDE.md` |
| Cutting a release (desktop installers + the companion image, one git tag) | `.github/workflows/*.yml` | `.github/workflows/CLAUDE.md` |
| Tests | `tests/*.test.js` | `tests/CLAUDE.md` |
| Historical design records — **not current** | `docs/*.md` | `docs/CLAUDE.md` |

## Terminology

The canonical names. Use these in UI strings, comments, docs, agent prompts — anywhere a human (user or contributor) might read them.

- **File** — a `.md` document in the workspace. The user-facing noun for the thing you create / open / edit / delete. **Never use "page" or "note"** — both were earlier conventions that have been retired.
- **Basename** — a file's name with no folder path and no `.md` extension. For `notes/projects/Foo.md`, the basename is `Foo`. This is what wiki-links use, and what the link index is keyed by.
- **Workspace** — a GitHub repo plus its checkout on this machine. Everything inside the folder (files, images, other assets) is part of the workspace. A workspace cannot exist without a repo: the companion's `workspace.repo_owner`/`repo_name` columns are `NOT NULL` (`api/src/schema.ts`, `api/init.sql`), and the two setup flows both clone. The repo *identity* lives on the companion; each machine's checkout path + sync toggle are machine-local (`local-settings.json`). Code sometimes still says "vault" (Obsidian-inherited); new code uses "workspace".
- **Wiki-link** — the `[[Some File]]` syntax linking one file to another by basename. The term comes from MediaWiki/Obsidian/etc. Variants: `[[File#Heading]]`, `[[File|Display]]`. Resolution is workspace-wide, case-insensitive, basename-only — never include a folder path. The parser + index live in `src/renderer/linkIndex.ts` (mirrored in main at `src/main/linkParser.ts`).
- **External link** — the `[label](https://…)` markdown form. Always means an off-workspace URL. Opens in the system browser. Not to be confused with wiki-links.
- **Chat** — one conversation with the agent. The user-facing noun, and the name used in code, in the database (`chat` / `message.chat_id`), and in the IPC channels (`chat:list`, `chat:open`, …). **Never call a chat a "session".**
- **Session** — reserved for **pi's own session**: its `SessionManager`, its `AgentSession`, and the JSONL session file that is its working memory for a chat. Different thing, different lifetime — pi's session is rebuilt from the stored transcript whenever a chat moves between machines.
- **Review run** — a chat the companion opens by itself, after a chat has done enough work, in which the agent reviews that conversation and updates its own skills. It is an ordinary chat (`source: 'review'`), not a second agent and not a supervisor of anything. Closest existing thing is **cron**: same fresh chat, same unattended run, same check-in — only the trigger differs.
- **Memory** — the two files the agent maintains at the workspace root: `MEMORY.md` (what it has learned about working here) and `USER.md` (who the user is). Written with the `memory` tool, loaded into the prompt at the start of every chat. **Memory is not review**: they are separate processes with separate triggers, separate counters, separate settings and separate prompts, and the only thing they share is the timer that wakes them. Do not describe one in terms of the other.
- **Memory run** — a chat the companion opens by itself, after a chat has accumulated enough of the user's messages, in which the agent looks that conversation over for facts worth remembering (`source: 'memory'`). Same shape as a review run, different trigger and a tool set of exactly one.
- **Backlink** — a wiki-link that points *at* a given file from elsewhere. The link index maintains backlinks per file; the backlinks panel under the editor reads from that.

Avoid: "page", "note", "document" (for `.md` files), "vault" (in new code/copy), "internal link" (call it a wiki-link), "session" (for a chat).

## Invariants when touching files/links

Any code that creates, modifies, renames, or deletes a `.md` file — whether through in-app actions or via the watcher path — must satisfy all of these. Skipping any one drifts the cache from disk:

1. **Link-index sync.** Create/change → `linkIndex.updateFile` or `applyParsedLinks`. Delete → `removeFile`. Rename → `renameFile`. Then `bump()` so consumers re-render.
2. **Tree refresh.** Any add/remove of a file or folder must result in `refreshTree()` (in-app: call `fileOps.treeAndIndexChanged()`; external: handled by the fs watcher).
3. **Folder rename re-keys nested files.** Renaming a folder changes every nested file's path. The handler (`onTreeRename` in `App.tsx`) walks `getOutgoingMap()` for paths under the old folder, calls `linkIndex.renameFile(oldP, newP)` and `renameTabsPath(oldP, newP)` for each, and shifts `selectedFolderPath` if it pointed inside. `onMoveItems` does the same for drag-and-drop moves. Without this, the index carries stale path keys until the watcher echoes per-file events, and open tabs inside the renamed folder break.
4. **Parser parity.** `LINK_RE` / `parseTarget` / `normalizeTarget` / `parseLinks` / `leadingWidth` / `collectContext` must stay identical between `src/renderer/linkIndex.ts` and `src/main/linkParser.ts`. The watcher in main reuses `linkParser.ts`, so this constraint is exercised on every external change. `tests/parserParity.test.js` enforces this.
5. **Save before mutating active file.** `writeNow()` first, awaited. See "Save lifecycle" in `src/renderer/CLAUDE.md`.
6. **Real mtimes everywhere — never `Date.now()`.** Every place that stores or compares a mtime — main's `fs:writeFile` / `fs:createFile` return value, the watcher's `fs:changed` event, the renderer's `linkIndex.updateFile` call from `writeNow` — uses the file's `stat.mtimeMs` (a float with sub-ms precision on macOS/Linux). The self-echo guard works because the value stored via `linkIndex.updateFile(path, text, mtime)` is *exactly* the value the watcher's later stat returns for the same write, so `evt.mtime > stored` is false on the echo. Mixing `Date.now()` (integer ms) with a sub-ms float makes every save look fresh to the watcher → editor reloads from disk mid-typing → keystrokes lost, cursor jumps. The `useLinkIndex.updateFile` wrapper MUST forward the mtime arg through; shipped briefly with arity 2 in v1.0.1 and triggered exactly this.
7. **Workspace-scoped watcher.** One watcher per app. Switching or removing a workspace must `watchStop()` before doing anything else; `loadWorkspace` handles this. Don't start a watcher without stopping the previous one. Starting also seeds the rename correlator (stat + hash every `.md` under the root) so unlinks fired immediately after `watchStart` can still be correlated.
8. **Idempotent watcher handlers.** Every in-app write self-echoes ~350ms later. Handlers must be safe to re-run on the same data. The mtime guard is the primary mechanism. For `rename` events, the renderer's handler is also idempotent (`linkIndex.renameFile` of an already-renamed path is a no-op; the regex rewrite matches nothing because refs are already rewritten).
9. **Watcher reloads the active file on external change.** When `evt.path === activeFile` and the event is fresh (`evt.mtime > stored mtime`), the renderer reads the new content, calls `editor.setContent(text, viewState)` to preserve cursor/scroll, then flashes the added text with an indigo accent pulse via `editor.flashRanges(ranges)` (reuses the AI-stream-done animation; see `--ai-done-bg-*` in `app.css`). The diff is word-level (`diff` npm, `diffWordsWithSpace`). Reload runs unconditionally — if a keystroke lands in the same instant the agent (or any external writer) modifies the file, the keystroke loses. The save-debounce window is 500ms so this is rare. The renderer's own writes don't trigger this path because the self-echo's mtime is equal to the stored mtime (see invariant #6). See `src/renderer/diffFlash.ts` for the flash extension.
10. **Self-references are rewritten on rename.** `renameOps.ts` does NOT skip `src === oldPath`. If `Foo.md` contains `[[Foo]]` and is renamed to `Bar.md`, the on-disk file ends up containing `[[Bar]]`. Don't reintroduce the skip.

## Cross-process constants

- `APP_NAME` lives in **two** places: `src/shared/constants.ts` (single source of truth, imported by both processes) and `package.json` (`build.productName` — electron-builder uses it for `.app`/`.dmg` names at build time). Comments in each file flag this.
- `FILE_ACTIONS`, `FOLDER_ACTIONS`, `EDITOR_ACTIONS`, `SUPPORTED_PROVIDER_SLUGS`, `DEFAULT_PROVIDER_SLUG`, `isCompanionStale` — all in `src/shared/constants.ts`. That last one is a *predicate* rather than a constant and belongs there for the same reason the rest do: **the desktop and the companion image are cut from one release tag**, so a version mismatch means they disagree about the shape of the data they exchange, and main answers it to refuse every write while the renderer answers it for the toast, the sidebar icon, the settings gate and the chat composer. One declaration, five readers; `'dev'` (either side unversioned) is never stale, or every development session would be unable to save. See "The companion's version rides the same signal" in `src/main/CLAUDE.md`. Both `src/main/main.ts` (native context menus, provider filter) and `src/renderer/constants.ts` (re-export + renderer-only additions) import from there. **Editor-menu items are built per right-click from what the renderer says applies, so an item that can't work is absent rather than present and broken**: `EDITOR_ACTIONS.SEND_TO_AGENT` needs the active file to have a path on disk (drafts opt out), and `EDITOR_ACTIONS.REVEAL_IMAGE` needs an `app://media/` image under the pointer (remote and `data:` images have nothing on disk to reveal).
- Renderer-only constants (`SETTINGS_SECTIONS`, `THEME_MODES`, `VIEW_MODES`, `SAVE_STATES`, `TREE_SORT_ORDERS`, `TREE_SORT_LABELS`) live in `src/renderer/constants.ts`.
- The `Settings` type lives in `src/shared/settings.ts`. Top-level keys: `workspaces`, `activeWorkspaceId` (both DERIVED, not stored scalars), `appearance`, `codingAgent`, `agentSecrets[]`, `transcription` + `speech` + `voiceKeys` (the three voice JOBS — transcription, the microphone via `transcription.micProvider`, and speech — plus the per-vendor keys they share; see `agent-core/voiceProviders.ts`), `sync`, `telegram` (bot *preference* — the catching-up notice; identity and runtime state stay in the companion's `telegram_account` row), `timezone`, `chatSidebarOpen`, `chatSidebarWidth`, `sidebarWidth`, `viewMode`, `treeSortOrder`, `bookmarkFilterActive`, `showHiddenFiles`, `chatSources`, `openTabs`, `windowBounds`. (Scheduled runs have **no** settings key: the companion executes them and its knobs are that server's env; job definitions live per-workspace in `<workspace>/cron.json`. See "Scheduled runs (cron)" in `src/main/CLAUDE.md`.) **Synced settings live on the companion (Postgres) — the single source of truth — and the desktop applies NO defaults on read**, so an unset value reads as unset, never faked. Adding a persisted synced field means updating the `Settings` type, adding its line to `normalizeSettings` (`src/renderer/settingsModel.ts` — the one total function that builds the renderer's settings object; the `Settings` return type makes a missing key a compile error), and adding a setter in `useSettings` if it needs one. **Do not add a `useState` for it** — the renderer holds ONE settings object and every field is a read off it; per-field copies are what made a setting from a previous companion stay on screen (see "Settings are one object" in `src/renderer/CLAUDE.md`). There is **no** desktop `DEFAULT_SETTINGS` to extend. A synced field with no value is simply unset — required fields error at their consumer, optional fields fall back at the point of use. **A credential is declared in exactly one place: `agent-core/credentials.ts`** — add it there and all three consumers follow (the companion's `api/src/keys.ts` decides what to encrypt → the `secret_value` table, crypto columns `NOT NULL`; `src/main/settingsStore.ts` decides what to strip before the renderer; `src/renderer/settingsDiff.ts` decides what not to send back). `agent-core` is the only code bundled into both builds, which is why it lives there. Three copies of this fact is what it replaced, and a mismatch is not cosmetic — miss a field in the strip and it leaks to the screen, miss it in the send guard and a stale cached copy republishes over a fresher one. Pinned by `tests/credentials.test.js` (the list, by name) and `tests/rendererSettingsDoor.test.js` (no IPC handler may return an unstripped read). **A stored credential is destroyed only by something asking to destroy it** — never by an empty value in a save, never by a name missing from a saved list, and a rename re-files the value rather than recreating the entry. That rule lives on the companion (`putSecret` / `writeAgentSecrets` / the two `DELETE` routes) because it has to hold for every writer, not just the renderer; the four ways it was got wrong, and what each one cost, are tabulated in **`api/CLAUDE.md`** under "Destroying a credential is a REQUEST, never an inference". Pinned by `tests/secretDeletes.test.js`. **Machine-local** settings (window/view state, the active workspace, which chat sources the history list shows) are the exception: they live in `<userData>/local-settings.json` with desktop defaults. Those are declared in exactly one place too — **`LOCAL_SETTINGS` in `src/main/api/localSettings.ts`**, a key→default map that `LOCAL_KEYS` (write routing) and `overlayLocal` (the read overlay) both derive from. Adding a machine-local field is that one edit; splitting the two lists is how a key ends up routed but undefaulted (reads as `undefined` on a fresh machine) or defaulted but unrouted (silently `PATCH`ed to the companion, so it syncs and fails offline). See "Settings persistence" in `src/main/CLAUDE.md` and the companion's **`api/CLAUDE.md`**.

## Duplicate basenames + path-prefixed links

Duplicate basenames across different folders are **allowed** (`clients/acme/Meeting.md`
and `clients/globex/Meeting.md` coexist). Only same-folder collisions are rejected/
auto-disambiguated (`" 1"`, `" 2"`, …) — the filesystem forbids them anyway. `fs:createFile`,
`fs:renameFileLiteral`, `fs:moveItem`, and the renderer's `findNameConflict`
/ `findTreeRenameConflict` are all same-folder-only now. (`uniqueInWorkspace` /
`collectMarkdownBasenamesLower` are still *exported* from `pathResolver.ts` but nothing
imports them — the workspace-wide-uniqueness era is over. There is no `fs:renameFile`
channel; `fs:renameFileLiteral` is the only rename IPC and it forces no extension.)

Wiki-links resolve through `src/renderer/linkResolver.ts` (`resolveLinkTarget`):

- **Bare `[[Meeting]]`** → the file with that basename in the source's own folder,
  else the shallowest path (Obsidian-style tiebreaker). `pageIndex` is
  `Map<basename, path[]>`.
- **Path-qualified `[[globex/Meeting]]`** → the exact folder match; if the path is
  stale (target moved/renamed) it **falls back to basename resolution** so the link
  still resolves.
- Autocomplete inserts `shortestUniqueLinkFor` — bare when the name is unique, the
  shortest disambiguating prefix when not — so ambiguous links are rarely authored.

Backlinks are basename-keyed but each entry carries `targetParsed`; `getBacklinksForFile`
resolve-filters the bucket so a link attributes to the correct duplicate. Rename
reference-rewrite (`renameOps.ts`) is resolution-aware (rewrites only links resolving
to the renamed file; handles path-qualified links).

## Tests

`npm test` runs everything via `node:test` (no install). See **`tests/CLAUDE.md`** for the per-file coverage table and what's not covered by automated tests.
