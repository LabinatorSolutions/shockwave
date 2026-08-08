# CLAUDE.md — renderer

React 19 + Vite renderer. Vite root is `src/renderer/` (configured in `electron.vite.config.js`'s `renderer` section); build output goes to `out/renderer/`. Entry: `index.html` → `main.tsx` → `App.tsx`.

`main.tsx` also installs a window-level dragover/drop preventer for `Files` drags so a stray drop outside an explicit handler doesn't navigate the renderer away to the file URL, and a document-level `contextmenu` fallback: if no component preventDefaulted the right-click (editor, file tree etc. build their own menus), it pops a native cut/copy/paste menu via `context:fallbackMenu` — this is what gives the chat sidebar and settings fields clipboard menus.

Cross-cutting invariants (terminology, link-index rules, parser parity, save-before-mutate) live in the **root `CLAUDE.md`** — read that first. Settings-page policy (when a value saves, credential handling, the per-section inventory) lives in **`settings/CLAUDE.md`**.

## State model

`App.tsx` is the orchestrator. Heavy state lives in hooks under `hooks/`:

- `useTabs` — tabs (their ORDER is user-visible and drag-reorderable via `reorderTabs`; see "Tab strip" below), `activeTabId`, per-path view state, per-tab back/forward history. Tabs may be drafts (`isDraft: true, path: null`); `promoteTabPath(tabId, newPath)` flips a draft to a real file once the caller has created it on disk. The actual create-on-disk happens inside `writeNow` in `App.tsx` (see "Save lifecycle" below) — a draft has no file until its first save fires. It also owns the **editor's parked document states**: everywhere it forgets or re-keys `viewStateByPath` (close, delete, rename, workspace switch) it makes the matching `evictDocument` / `renameDocument` / `clearDocuments` call — see "Per-document undo history" below. Add a new case to one and you must add it to both, or a closed file's undo stack leaks or a renamed file comes back with an empty one.
- `useLinkIndex` — wraps `createMetadataCache()` (in `metadataCache.ts`, modeled on and named after Obsidian's) behind a ref + a `version` counter, `bump()`ed after every mutation. The cache owns `resolvedLinks` (source→dest paths), `unresolvedLinks`, the reverse backlinks, and a PRIVATE basename→paths "phone book"; it resolves links itself via `getFirstLinkpathDest` (rules in the pure `linkResolver.ts`). There is no public `pageIndex` — consumers call `cache.getFirstLinkpathDest` / `candidatesFor` / `getBacklinksForFile`. Rename/move reference rewrites (`renameOps.ts`) capture a context snapshot (`captureRewriteContext`) before the cache re-keys so resolution stays correct regardless of order.
- `useFileOps` — rename/duplicate/delete/link-click, and the `treeAndIndexChanged()` helper that re-reads the tree and bumps the link index after any structural change.
- `useSyncRef` — keeps a ref in sync with a value/callback so a stable closure (e.g. `writeNow`) can read fresh state without being rebuilt.
- `useSettings` — owns all persisted settings. **ONE object, and everything on screen is a read off it — never a copy.** See "Settings are one object" below. `persistSettings` diffs via `settingsDiff.ts` and sends a minimal patch; `hydrateSettings` replaces the whole object through `normalizeSettings` (`settingsModel.ts`); `resetSettings` empties it when the app is pointed at a different companion. **No default-merge** — `EMPTY_SETTINGS` starts UNSET for DB-backed values (empty provider/model) so the renderer never invents a value the DB doesn't have. Section-level save policy lives in `settings/CLAUDE.md`.
- `useFsWatcher` — the external-change (`fs:changed`) listener; see its own section below.
- `useBookmarks`, `useDailyNote`, `useSendToAgent`, `useAppUpdate` — bookmarks, per-workspace daily-note config, the "send file to agent" flow, and the app-update status. `useAppUpdate` takes `onRequestRestart` from App and re-exposes it as `requestRestart`, so the pill, the toast and Settings all go through the SAME confirm — installing quits the app and kills a running turn, so nothing calls `restartToUpdate` directly. Its toast keys on `version:phase` (`available` and `ready` are two pieces of news about one version), and dismissing it snoozes that version; see "App updates" in `src/main/CLAUDE.md`.

The **Editor** (`Editor.tsx`) is imperative: parent gets a ref with `loadDocument / setContent / getText / getViewState / currentDocKey / clear / flashRanges / setReadOnly / focus`, plus `evictDocument / renameDocument / clearDocuments`, and reports each new empty view through the `onViewCreated` prop. `App.tsx` loads content into the editor via an effect that watches `activeFile` — this decouples load timing from React state-update ordering, at the cost that the effect can't see *why* the file changed, which is what `onViewCreated` and the promotion record exist to tell it (see "When the load effect reads from disk"). **`currentDocKey()` is the editor's own answer to "which document are you holding?" and outranks any bookkeeping the parent keeps about it** — both the load skip and the save check ask it before acting. The `dark` prop recreates the EditorView (theme can't be reconfigured live). `viewMode` toggles the live-preview decoration bundle via a Compartment — cursor, history, and scroll all survive a reconfigure.

### Per-document undo history

**`loadDocument(key, text, viewState)` shows a DIFFERENT document; `setContent(text, viewState)` replaces the text of the one already on screen.** Use the wrong one and you either lose an undo stack or leak one across files.

There is ONE CodeMirror view for the whole app and tabs swap documents through it. CodeMirror keeps undo history inside `EditorState`, so a single shared state meant a single shared undo stack — pressing undo past the start of your edits in the current file walked back through the *document swap itself* and restored the previous file's text into the current tab. That is not a stale render: undo is a user edit, so it marked the tab dirty and the autosave then wrote the wrong file's content to disk.

So the editor follows CodeMirror's intended multi-document pattern — one `EditorState` per document, swapped in with `view.setState()`. `loadDocument` parks the outgoing document's state in `docStatesRef` and restores the incoming one. Load-bearing details:

- **Keys are DOCUMENT identity, not tab identity**: the file path, or `draft:<tabId>` before a draft has a file. One tab walks between files via back/forward, and two tabs on one file share a stack (as in VS Code). Draft promotion **re-keys** (`renameDocument(draftKey, activeFile)`), or a file would come back with an empty stack after its first save.
- **A parked state is only reused while it still matches the text just read from disk.** If the file changed underneath us (agent, git pull, another machine), its history describes text that no longer exists → start clean.
- `setContent` keeps history on purpose — it backs the external-change reload path, where being able to undo an outside writer's change is the point.
- **Compartments are reconciled after every swap, all of them, in one place.** `setState` replaces compartment contents wholesale, so a parked state comes back configured however it was when it was parked. The refs (`viewModeRef` / `isMarkdownRef` / `filePathRef` / `readOnlyRef`) are the single description of how the editor is configured and `applyCompartments(view)` installs it; the three things that can put the two out of step — a prop change, a document swap, a view rebuild (dark toggle) — all call it. Re-applying only *some* of them is the bug this replaced: the swap re-applied the lazily-loaded grammar alone, so opening a non-markdown file in another tab stripped live preview from the markdown file you'd parked, and it came back raw until you toggled the view mode twice. Add a compartment, add it to that function, and all three paths cover it.
- The cursor/scroll restore dispatches with `Transaction.addToHistory.of(false)` — it isn't an edit, and recording it would make the first undo in a freshly-opened file do nothing but move the cursor.
- Cache is capped at `MAX_DOC_STATES` (24, LRU) — a parked state holds its whole document plus history. Losing one costs only that file's undo stack.
- A theme toggle rebuilds the view and resets history; parked states are bound to the old extension instances.

### Companion reachability

The workspace list lives on the companion and the renderer holds an in-memory copy, so **an empty list means one of two very different things** and they used to render identically. `App.tsx` tracks `companionOnline` from `settings.companionState()` (asked once on load — the push can beat the window listening) + `settings.onCompanionState()`, and the empty state says "can't reach your companion server" rather than "add a workspace" while it's false. Seeded `true` so the first paint isn't a flash of "unreachable" before main answers.

**Unreachable and unconfigured are different failures and get different UI.** The rule: *forcing focus is proportionate only when the user can't proceed at all AND the fix is in front of them.*

- **Unreachable** (configured, request failed) → a persistent **red** `CloudOff` button in the sidebar footer next to the gear (`WorkspaceSelector`, gated on `companionOnline`), which deep-links to Settings → Companion, **plus a toast on the drop** (`companion-offline`, in `App.tsx` beside the certificate toast) carrying the same destination. Never auto-opens anything: the settings are correct, the server is away, and `setCompanionOnline` is edge-triggered, so flapping connectivity would pop a modal over live typing, repeatedly, pointing at a page with nothing to fix. **The icon holds the state and the toast announces it** — the button is 26px in a corner you weren't looking at, and everything it explains fails quietly (a background settings write that can't reach the server only sets `saveStatus: 'error'`, which nothing renders outside the Settings modal). So the toast takes an ordinary duration and has no "back online" counterpart, unlike the sync pair: it is the news, not the state.
  - **Red, not the amber that matches the sync icon's `offline`.** Those two are the same "away, retrying" fact about different servers, but not the same consequence: GitHub being unreachable costs nothing until you're on another machine, while the companion being unreachable means settings writes fail, chats can't run or store, the workspace list freezes, voice tokens can't mint and agent secrets are unavailable. Colour tracks what it costs you here, not whether a retry loop is still running.
- **Version mismatch** (the desktop and the server on different release tags) → a persistent red `CircleArrowUp` in the sidebar footer **plus a `duration: Infinity` toast** (`companion-version`), and the same gate on Settings, and a frozen chat composer. Harder than unreachable on purpose: main is refusing every write to the companion while it lasts (see "The companion's version rides the same signal" in `src/main/CLAUDE.md`), so this is not news about the server being busy — it is the app telling you nothing will save. `isCompanionStale` (`../shared/constants.ts`) is the one predicate all four readers share; `companionStale` in `App.tsx` is derived every render, never stored.
  - **Its own icon, not the cloud.** The server is up and answering — saying "away" about it would be false, and the fix is a different button. They can't both show: main clears the version when the companion goes offline.
  - **The toast is dismissible and the icon is not**, which is the whole reason there are two. A blocked write is a state, so it can't rely on a toast that scrolls away; but a warning you cannot silence while you finish a thought is the kind users learn to resent. Dismiss the news, keep the state.
  - **`CompanionUpdateDialog` opens itself when the SERVER is the stale side**, as well as from the toast's **Update server** button. Every write is being refused and the fix is one button, so that condition is worth taking focus for; the toast alone is bottom-right chrome that can be missed and dismissed. Three guards keep it from being the version that was removed: `bootDone` (the version lands on the first feed open, ahead of the first paint — the old one opened over a launching app), a ref keyed by the version pair (a reconnect re-pushes the same state and must not re-open what was just cancelled), and `companion-older` only (`companion-newer` means this app is the stale side and the dialog can't fix it, so that direction keeps its toast alone).
- **Unconfigured** (`!url || !hasApiKey` from `settings.apiRead()`) → boot opens Settings → Companion itself, once, just before `setBootDone(true)`. Either field missing and *nothing* companion-backed works, so there's no later moment where it stops mattering, and boot is when the user isn't mid-task. `apiRead` is local (no network), so an outage can't fake this condition; a throw opens nothing, since silence beats sending the user to the wrong page. Once the modal is open, `SettingsModal`'s existing gate takes over — every other section is disabled and `active` is pinned to Companion.

**The renderer never refreshes companion-owned data itself.** Main has one rule — the live feed opening *is* the reachable signal — and pushes the refreshed list down the existing `settings:changed` channel (see "Connection state" in `src/main/CLAUDE.md`). So `onWorkspacesPushed` also has to handle the case boot couldn't: the app started while the companion was down, boot got an empty list, and nothing is open. Setting the active id alone would leave a half-loaded workspace (`workspacePath` derives from it, so the path goes live with no tree and no watcher), so that callback actually loads the workspace — guarded on `!activeWorkspaceIdRef.current` (a push with something already open is a routine refresh and must not tear down what the user is working in) and on `bootDone` (the feed can open before boot finishes, and boot owns the first load). It reads both through refs so the callback identity stays stable — same discipline as the `fs:changed` and sync listeners.

## Tab strip

### One tab per file, and how a second tab gets made

**Every open goes through `tabForPath` in `useTabs.ts` first: if the path is already showing in some tab, that tab is activated and no new one appears.** This holds for `openInActiveTab` AND `openInNewTab` — including the context menu's "Open in new tab" and the agent's `open_file`. It isn't only convention (VS Code, Sublime and IntelliJ all activate the existing tab; a file duplicates only across SPLIT PANES, which this app doesn't have). The editor parks view state and undo history keyed by **document path**, not by tab — see "Per-document undo history" above — so two tabs on one file already share cursor, scroll and undo stack. A duplicate tab can hold nothing the original doesn't. It matches a tab's **current** path only: a file sitting in some tab's back-history isn't open, and jumping to it would make back/forward unusable.

The gestures, and why they're split this way:

| Gesture | Where | Result |
|---|---|---|
| Click | tree row, quick-access panel, quick search, backlinks, bookmark, graph node | reuses the active tab |
| Click | wiki-link | reuses the active tab, pushing onto its back/forward trail |
| **Middle-click** | tree row, quick-access panel | new tab |
| **Cmd/Ctrl+click or middle-click** | wiki-link | new tab |

**Plain click must keep reusing the tab**, because a tab's back/forward history (`goBack`/`goForward`) only has content when navigation lands *in place*. Open-every-click would cap every tab at one history entry and leave the arrows permanently dead — worst exactly where this app is distinctive, since following `[[wiki-links]]` is browsing and browsing wants back/forward, not a tab per hop. Obsidian defaults the same way.

**The tree uses middle-click and not Cmd+click**, and that is forced rather than chosen: react-arborist's `node.handleClick` already owns Cmd/Ctrl+click for multi-select and Shift+click for range-select (see the row's `onClick` in `FileTree.tsx`), and the file context menu's bulk actions read that selection. VS Code's explorer has the identical collision and resolves it the same way. Inside the editor nothing claims Cmd+click, so wiki-links take it — that's Obsidian's gesture. Both row handlers `preventDefault` a button-1 `mousedown` so Chromium's autoscroll doesn't fire, and middle-click arrives as `auxclick`, never `click`.

**The `{ newTab }` flag crosses four files, and a dropped argument is silent.** `wikiLinks.ts` reads the modifier → `Editor.tsx`'s `linkClickRef` forwarder → `useFileOps.onLinkClick` → `openInNewTab`. The forwarder took `(name, sourcePath)` and swallowed the third argument, so Cmd+click looked exactly like a plain click with nothing erroring; if the gesture ever silently degrades, check that hop first.

### Three more load-bearing behaviors

`TabStrip.tsx` is presentation over `useTabs` — it renders the tab array in order and calls back.

**Overflow: shrink, then scroll, then list.** Tabs are capped at `max-w-44` and floored at `min-w-[7rem]`, and the row they live in is the scroller (`overflow-x-auto`). The floor sits on the TAB, not on the label: flex shrinking is proportional, so without it a crowded strip collapses every tab toward nothing at once and you get a row of ellipses rather than a few readable names and a scroll. The strip previously had no overflow rule at all — tabs past the right edge were clipped by the window with no way to reach them, and `+`, as the last flex child, was pushed off *first*. So `+` and the open-tab list now live in a `shrink-0` rail **outside** the scroller and can't be scrolled away. The horizontal scrollbar is suppressed (`scrollbarWidth: 'none'`; Chromium-only, which is all Electron is) because the strip has ~31px of usable height — the list button is the visible affordance instead.

**The open-tab list is a search, and it is mounted unconditionally.** It's a `Popover` holding cmdk with `shouldFilter={false}` and fuzzysort doing the ranking against each tab's workspace-relative path — the same engine, and the same `segmentsFromIndexes` highlighting (now shared in `searchHighlight.ts`), as quick search, so typing a folder finds a tab exactly the way it finds a file. Its chrome is the **chat-history popover's**, copied deliberately: same shell, header, row shape and sizes, built on cmdk's raw primitives rather than the shadcn `Command*` wrappers precisely so those wrappers' own borders and text sizes don't leak in. Two lists of the same kind of thing shouldn't look like they came from different apps. cmdk stays underneath for the arrow-key/Enter handling the hand-rolled history list lacks, and `data-[selected=true]` must be styled to match hover or arrowing through the list looks like nothing is happening.

The trigger appears **only while the strip overflows** (a `ResizeObserver` on the scroller, re-measured on tab changes too — both side panels are drag-resizable, so width moves without the tabs changing). With every tab visible the list can't tell you anything the strip isn't already showing.

**It is hidden with `invisible`, never unmounted**, and that distinction is load-bearing rather than stylistic. Both conditions that hide it — the last tab closing, and the strip ceasing to overflow — are reachable from INSIDE the open popover by closing tabs there, and unmounting an open Radix layer is the stuck `pointer-events: none` body described under "UI conventions" below: the app renders, animates and logs perfectly while ignoring every click. The `!listOpen` term keeps it visible for as long as it's open, so the popover can never end up anchored to something invisible.

**Which files are open is remembered per workspace** (`openTabs` in machine-local settings — see the settings key list in the root `CLAUDE.md`). `loadWorkspace` restores it, filtering the stored paths against the tree it just read so a file deleted or renamed while the app was shut is dropped instead of opening a tab onto nothing; `restoreTabs` mints fresh ids, because ids are per-run and mean nothing across launches. Drafts are never stored — there's no file to reopen them from. The save is debounced 600ms **and** flushed from `beforeunload`, since closing tabs right before quitting is precisely the case a debounce would lose. It is gated on `tabsReadyForWsRef`, which `loadWorkspace` clears on entry and sets after restoring: without that gate the `resetTabs()` at the top of a load races the restore several awaits later, and the empty list saved in between is how "reopen my tabs" quietly becomes "forget them".

**The active tab scrolls itself into view, keyed on `activeTabId` ALONE.** Adding `tabs` to that effect's deps looks harmless and breaks drag: a drop changes `tabs`, so the strip would scroll away to wherever the active tab is, undoing the reorder you just watched. Nothing else needs it — a newly opened tab is activated in the same commit, and draft promotion keeps its tab id. This effect is why the agent's `open_file` tool is usable at all: it calls `openInNewTab`, so on a full strip every file the agent opened became active *off-screen* — the editor changed under you and the tab explaining why was invisible.

**Drag-to-reorder runs on dnd-kit** (`@dnd-kit/core` + `@dnd-kit/sortable`, `horizontalListSortingStrategy`), and the choice is deliberate rather than incidental: **react-dnd is already in the tree** (v14, pinned by react-arborist) and would have been the free option. It drives drags from the browser's native HTML5 drag, which this app has already had to defend against twice — `SafeHTML5Backend` in `FileTree.tsx`, and the `stopImmediatePropagation` in `imagePaste.ts` that stops CodeMirror reading dropped image bytes as text. A third native-drag surface inches from the editor is a fourth chance at that class of bug. dnd-kit drives from ordinary pointer events and shares none of that machinery, so it cannot collide with either. Details that matter:

- **Transform is translate-only**, written by hand rather than via dnd-kit's `CSS.Transform` helper, which also emits `scaleX`/`scaleY`. Tabs are variable-width; scaling one to the width of whatever it's passing stretches its text.
- **`PointerSensor` carries `activationConstraint: { distance: 4 }`** or a plain click is swallowed as a zero-distance drag and tabs stop switching.
- **The close button stops `pointerdown`.** The drag listeners are on the tab, so without that the X is a drag handle and never gets its click. Same guard on the rows in the overflow list, where Radix's own select would otherwise fire alongside it.
- Middle-click close needs no guard: dnd-kit's `PointerSensor` ignores non-primary buttons.
- `reorderTabs` (in `useTabs`) moves one entry and changes **nothing** else — not the active tab, not any path or history. `closeTab`'s "activate the tab to the left" reads the array at close time, so it follows the new order by itself.

## Save lifecycle

Edits are debounced (`SAVE_DEBOUNCE_MS = 500` in `App.tsx`) via `dirtyTabIdRef` + `saveTimerRef`. `writeNow()` flushes immediately and is awaited before any operation that would change `activeFile` (tab switch, workspace switch, rename, delete, graph toggle, `beforeunload`). When you add a new place that changes the active file, call `writeNow()` first or you'll lose unsaved edits.

`writeNow` is the **only** place a file gets created from a draft. The dirty marker holds a *tab id*, not a path. When the timer fires (or anything awaits `writeNow`), it looks up the tab: if `isDraft`, it creates the file via `window.api.createFile(newFileDir(), titleDraft || 'Untitled', buffer)` and calls `promoteTabPath(tabId, newPath)` to flip the tab to a real file; otherwise it writes through to `tab.path`. A per-tab in-flight map inside `writeNow` coalesces concurrent calls so two near-simultaneous saves can't both fire `createFile` and leave an orphan disambiguated file behind. On failure the dirty marker is re-armed so the next attempt retries the same tab. Drafts have no file on disk until the first save fires — typing into a draft, pasting an image, committing a title, or switching tabs are all events that eventually call `writeNow`, which creates the file as a side-effect of saving.

**`writeNow` never writes a buffer into a file it didn't come from.** `editor.getText()` returns whatever the ONE shared view is showing, while the write goes to the tab that was marked dirty; every path that changes the active file flushes through here first, *while the outgoing document is still on screen*, so those are normally the same document — but nothing enforced it. It does now: the save compares `editor.currentDocKey()` against the dirty tab's own key (`draft:<tabId>` for a draft, else its path) and refuses if they differ, leaving the tab dirty for a later flush. Nothing of the user's is lost by refusing — if the keys disagree, the buffer isn't that tab's content — and this is what makes a stale or rebuilt view cost a blank screen instead of a destroyed file. It should never fire; it logs if it does.

### When the load effect reads from disk

**The rule is one pure function, `loadDecision.ts` (`tests/loadDecision.test.js`), because it was got wrong twice and both times the buffer on screen stopped belonging to the file the tab pointed at — which the save then wrote back.** The load effect supplies the inputs and performs the result. Read that file's header before changing any of this; the short version:

- **A draft tab getting a path is NOT proof its draft was saved.** A draft tab also gets a path by *navigating* — clicking a file in the tree reuses the active tab — and React 18 batches state updates made after an `await`, so a save and a navigation land in ONE render and look identical from outside. Inferring promotion from `null → path` therefore showed an untouched new file's empty buffer as whatever file you clicked. `writeNow` now records what the draft actually became (`promotedRef`), the effect consumes that record, and it skips the read **only** when the file now showing is that exact path. The record is single-use: a stale one would let a later navigation skip its read.
- **"Already loaded" is the editor's answer, not our note about it.** `lastLoadRef` is a copy of a fact the editor owns and can outlive what it describes — the view is rebuilt by a theme change and destroyed outright when graph view unmounts the editor, neither of which changes the active file. The skip therefore also requires `editor.currentDocKey() === activeFile`; a rebuilt view answers `null` and the file is read back in.
- **A rebuilt view must ask for its content back.** Nothing about the active *file* changes when the editor is torn down under it, so the Editor reports every new, empty view through `onViewCreated`, which bumps `editorEpoch` — a dep of the load effect. Without it, leaving graph view left an empty editor over a real file. If you add another place that unmounts or rebuilds the editor, this is what already covers it.
- Draft undo history is re-keyed to the promoted path **even when a different file is then loaded** — the history belongs to the file the draft became either way.

## Files that aren't markdown

`.md` is the default, not the limit. **`MediaView.tsx` owns the whole decision** — four pure predicates exported beside the component, and every consumer (the load effect, the tab strip, the file tree, quick search, the status bar) reads them rather than testing extensions itself:

| Predicate | True for | What renders |
|---|---|---|
| `isMarkdown` | `.md` / `.markdown` / `.mdx` | CodeMirror **with** the live-preview bundle |
| `isTextFile` | everything else in `TEXT_RE` + the `DOTFILE_TEXT_RE` allowlist | CodeMirror, **no grammar, always raw** |
| `mediaKind` | image / video → `'image' \| 'video'` | `MediaView` (static preview) |
| `isDrawing` | `.excalidraw` | `DrawingView` (editable canvas) |
| `isOpenable` | any of the above | anything else is inert in the tree and filtered out of quick search |

Three things follow from that split and each is load-bearing:

- **Live preview is markdown-only.** Heading styles, hidden syntax markers, wiki-links, task checkboxes and image widgets all assume markdown, so `activeIsMarkdown` gates them; a `.ts` or `.yaml` file always shows raw source. Rename `Foo.md` → `Foo.txt` in the tree and it stays editable — `renameFileLiteral` forces no extension (see "In-app rename").
- **Only `.md` joins the link index**, which is basename-keyed. So other text files need their own self-echo store: `writeNow` records their `stat.mtimeMs` in `textMtimesRef`, and drawings record theirs in `drawingMtimesRef` via `onDrawingSaved`. Both play exactly the role `linkIndex.updateFile(path, text, mtime)` plays for markdown, and the mtime discipline in root invariant #6 applies unchanged — a `Date.now()` here reloads the buffer mid-typing the same way.
- **`DOTFILE_TEXT_RE` is an allowlist, not "any extensionless dotfile."** These rows only became reachable when the tree learned to show hidden files, and without it the two you'd most want to look at (`.gitignore`, `.ignore`) do nothing when clicked. `.DS_Store` fits the same shape and is binary, which is why the list is enumerated. **Mirrored in main** (`OPENABLE_RE` / `DOTFILE_TEXT_RE` in `main.ts`) — same parity discipline as the wiki-link parser, since main decides what the watcher ships as a reloadable text change.

**The load effect skips media and drawing tabs entirely** — reading them as text is garbage, and `DrawingView` loads its own JSON from the `path` prop. `EditorStatusBar`'s word/char counts read 0 for both.

`DrawingView.tsx` is the only viewer here that writes. Excalidraw is uncontrolled after init and `onChange` fires on every pointer move, so saves are debounced (500ms) — and **the pending payload is tagged with the path it belongs to**, because a tab switch reuses the same mounted component and would otherwise write one drawing's scene into another's file. The old path's pending save is flushed before the new scene loads. It exposes `reloadScene` (the watcher's external-change path) and `flush` through a ref.

## In-app rename

`renameOps.ts` is the in-app rename flow. Order of operations (important):
1. `api.renameFileLiteral` — main renames to `toName` verbatim (no `.md` forcing, so extension changes like `Foo.md` → `Foo.txt` work) and throws on a same-folder collision. Returns the FINAL path used.
2. `linkIndex.renameFile(oldPath, finalNewPath)` — re-keys the index.
3. `rewriteReferences` — rewrites `[[OldName(#h|alias)?]]` to `[[NewName(#h|alias)?]]` (case-insensitive match, suffix preserved) in every file in `getBacklinks(oldBaseName)`. Self-references in the renamed file itself are also rewritten.
4. Re-read the renamed file and `updateFile` it so its own outgoing links reflect any self-reference rewrites.

The watcher will echo a `rename` event ~350ms later (see `src/main/CLAUDE.md`); the renderer's handler runs the same `rewriteReferences` against the new state, which is idempotent (regex matches nothing because refs are already rewritten).

## Renderer-side `fs:changed` listener discipline

External fs changes (terminal, pi coding agent, other apps) reach the renderer through the `fs:changed` listener, which lives in **`hooks/useFsWatcher.ts`** (wired from `App.tsx`). It subscribes **once per `workspacePath`** and accesses every dependency (`linkIndex`, `refreshTree`, `renameTabsPath`, `showError`, `activeFile`, `activeIsDraft`) **via refs**.

Do NOT add `linkIndex` (or any per-render object) to the listener's `useEffect` deps. The handlers call `linkIndex.bump()` synchronously, which triggers a re-render; if the effect re-ran on that, its cleanup would clear the 80ms `refreshTimer` set inside the listener, and external `.md` adds would silently never refresh the sidebar.

In-app file operations call `fileOps.treeAndIndexChanged()` directly AND get echoed by the watcher, so they paper over watcher bugs; external changes (terminal, pi coding agent, other apps) rely solely on this path. If external changes stop updating the sidebar, the listener-churn pattern is the first place to look.

## File tree (`FileTree.tsx`) — two react-arborist rules

Both of these are library-integration traps that fail *silently* and intermittently, so they read as flaky UI rather than bugs.

- **The `<Tree>` children render-prop must be a stable module-level component** (`NodeWithExtras`), never an inline arrow. react-arborist renders it AS A COMPONENT (`const Node = tree.renderNode` inside its `RowContainer`), so a new function identity each render is a new component *type* — React unmounts and remounts every row subtree. That destroys the rename input mid-edit: its `useState` re-initializes from `node.data.name`, so a background re-render (the app has some on a ~10s cadence) silently reverts what the user typed. Everything the row needs beyond react-arborist's own props travels via `NodeExtrasContext`, so it updates without remounting. `onToggle`/`onMove` are stable callbacks for the same reason — otherwise arborist rebuilds its `NodeApi` list every render.
- **`SafeHTML5Backend` wraps react-dnd's manager to filter dead drop-target ids.** The HTML5 backend dispatches `hover` from a `requestAnimationFrame` using ids captured at dragover; arborist re-registers every row's drop target whenever it rebuilds its node list — including `tree.open(parentId)` inside its own drop handler — so a queued hover can fire against ids that no longer exist and dnd-core throws an uncaught "Expected targetIds to be registered" mid-drag (seen dropping a file onto a folder).

Note also that react-arborist rows receive an inline `paddingLeft` (the nesting indent) that beats any class padding, and that the tree's dnd backend is scoped to the tree element via `dndRootElement` — see "Sidebar→editor image drag" below.

### The file context menu is shared, not the tree's

`fileContextMenu.ts` (`openFileContextMenu`) owns the menu for **every** list that shows files — the tree and the quick-access panel (`TreePanel.tsx`) below it. The panel's rows are the same `TreeNode`s the tree renders (`treePanelData` in `App.tsx` flattens the same state), so everything downstream keys on paths and just works; the panel had no `onContextMenu` at all, which made real files look fake.

**Rename edits the row that was right-clicked** — the tree's row via `node.edit()`, the panel's via `panelRenamePath` in `App.tsx` — and `RenameInput` (exported from `FileTree.tsx`) is deliberately free of any `NodeApi` so both can host it. Routing the panel's rename up into the tree instead is the obvious-looking shortcut and is wrong three ways: `editNode`'s `tree.get(id)` guard only sees *visible* nodes (`idToIndex` is built from `visibleNodes`), so a file in a collapsed folder silently no-ops; `scrollToItem` does nothing in `contentSized` mode because `.tree-wrap` owns the scroll, so the input can open off-screen; and in bookmark-filter mode the tree holds only bookmarked files, so the row isn't there to edit at all. Editing in place has none of those cases.

## Wiki-link UX inside the editor

- `wikiLinks.ts` — CodeMirror `ViewPlugin` that replaces `[[…]]` ranges with a clickable `LinkWidget` (calls back into `onLinkClick`, which opens or creates the target via `useFileOps.onLinkClick`).
- `wikiCompletions.ts` — autocomplete source triggered by `[[`; reads the link index's basename candidates and `workspacePath` through refs so completions see live data without re-creating the editor.
- `taskCheckboxes.ts` — interactive `- [ ]` / `- [x]` rendering.
- `autoLinks.ts` / `headingStyles.ts` / `hideMarkdownMarkers.ts` / `bulletPoints.ts` — live-preview decorations that style markdown syntax in place. **`bulletPoints.ts` requires the space after the marker** — a lone `-` is not a bullet. It used to match one (CommonMark counts it as an empty list item), and the cost was a lie told on every list you start: type `-`, a bullet appears; type the first letter and the line is `-h`, which is not a list, so the bullet vanishes. No other markdown editor bullets a lone `-`, and none auto-inserts the space either.
- `markdownLinks.ts` — renders `[text](url)` as a clickable link showing just `text`; reveals raw syntax when the cursor touches it. **The label stays real document text** — the `[` and `](url)` are hidden and the span between them gets a `Decoration.mark`, the same shape the image-link branch in that file already used. Replacing the whole link with a widget is the obvious alternative and silently drops every other decoration over that text: a replace-widget renders as a direct child of `.cm-line`, outside the mark spans `syntaxHighlighting` emits, so `## [Title](url)` rendered at body size and `[**bold**](url)` showed its asterisks. Headings, bold, italic and inline code can all reach a mark; none of them reach a widget. The trade is that a mark can't carry a click the way the widget's `<a>` did, so opening the url is an `EditorView.domEventHandlers` pair (swallow `mousedown` so the cursor doesn't land mid-click and reveal the syntax under the pointer, open on `click`), both gated on `event.target.closest('.cm-md-link')` so image links, wiki-links and ordinary text are untouched. The url rides on the mark as `data-url` rather than being re-derived from a position, so the handler can only ever open what is actually on screen. Also exports `findLinkAtPos` so the editor context menu can offer Edit / Remove for the link under the cursor (handles both plain text links and image-wrapping links like `[![alt](src)](url)`).
- `imageWidgets.ts` — replaces `![alt](url)` ranges with an `<img>`. URLs resolve relative to the active file's folder (or absolute, or `http(s)://`) and are served via the `app://media/<rel>` protocol — see "Image pipeline" below.
  - **Right-click an image → "Reveal in Finder"** (`EDITOR_ACTIONS.REVEAL_IMAGE`). Two decisions in it: the path is read off the **pointer target**, not the cursor — a right-click doesn't move the selection, so the cursor is wherever you left it — and it comes from the widget's own `src` rather than re-deriving it, which would be a second copy of `resolveImageUrl` free to disagree with what is on screen. **Only `app://media/<rel>` qualifies**, which is exactly the form `resolveImageUrl` produces for a file inside the workspace and the same boundary main's protocol handler enforces. Remote, `data:` and `file:` images have nothing on disk to reveal, so the menu item is *absent* rather than present and broken.
- `diffFlash.ts` — accent-color (indigo) flash decoration applied when the watcher reloads the active file and the renderer wants to highlight what changed (word-level diff via the `diff` npm package).
- `codeBlocks.ts` — `` `inline code` `` as a monospace pill and ```` ``` ```` fences as a full-width block, backticks hidden until the cursor touches the node (same reveal convention as `hideMarkdownMarkers.ts`). Two plugins on purpose so their `RangeSetBuilder`s never mix mark and line decorations. Styling lives in `app.css` (`.cm-inline-code` / `.cm-code-block*`) so dark mode rides the `--bg-code` token instead of a per-theme `HighlightStyle`.
- `listContinue.ts` / `blankLineOutdent.ts` — Enter behavior in lists and todos: continue the marker, and outdent a blank indented line rather than re-copying its indent.
- `indentGuides.ts` / `hangingIndent.ts` — vertical indent guides, and wrapped lines hanging at their own indent (list lines hang past the marker so a wrapped bullet continues under its text; leading tabs on those lines are replaced with fixed-width spacers so the wider hang can't shift the CSS tab grid — see the header comment). Both answer "how wide is this leading whitespace?" and **must agree exactly** or the guides drift off the text they sit left of, so the geometry is one shared module, `indentMetrics.ts`. Widths are **measured** — the font's space advance via a canvas, not a `ch` grid — because CodeMirror forbids layout reads during an update and a proportional font has no grid.

## View mode + editor status bar

`EditorStatusBar.tsx` is a pure-presentation strip pinned to the bottom of the editor pane, visible only when a tab is active. It shows: backlink count, view-mode toggle (live ↔ raw), word count, character count, and save state. All state lives in `App.tsx`:

- `viewMode` (`VIEW_MODES.LIVE` | `VIEW_MODES.RAW` in `constants.ts`) is persisted to settings and passed into `<Editor>`. The Editor toggles a CodeMirror Compartment carrying the live-preview decoration bundle without rebuilding the view — cursor, history, and scroll all survive a reconfigure. Only the `dark` prop forces an editor recreation. The `markdown()` extension always loads with `SetextHeading` removed (ATX headings only — `=== / ---` underline headings are intentionally unsupported).
- `editorStats` (`{ words, chars }`) is computed inside `Editor.tsx` (`computeStats`) and pushed up via the `onStats` callback (rAF-throttled).
- `saveState` (`SAVE_STATES.SAVED` | `SAVE_STATES.UNSAVED`) is set to UNSAVED on every editor change and flipped back to SAVED inside `writeNow()` — but only if `dirtyTabIdRef.current === null` after the write, so a write that races a subsequent edit doesn't flash SAVED prematurely.
- "Hide line numbers" (appearance setting) doesn't remove the gutter — it keeps the reserved width so the text column doesn't shift. The host element class drives CSS that hides the digits + active-line highlight.

## Image pipeline (renderer side)

For the `app://media/...` protocol see `src/main/CLAUDE.md`. Renderer pieces:

- **`imageWidgets.ts`** — replaces `![alt](url)` ranges with an `ImageWidget` (`Decoration.replace`). Builds decorations by regex-scanning the visible ranges; rebuilds on `docChanged || viewportChanged || selectionSet` so that placing the cursor on the image's range reveals the raw markdown (same convention as `markdownLinks.ts`). `resolveImageUrl` handles relative URLs (against active file's folder), absolute paths (workspace-root-relative), `http(s)://`, `data:`, `app:`, `file:`. **`http(s)://` does not pass through** — it's rewritten to `app://remote/?url=…` so main fetches it, because `img-src` in `index.html` has no `https:` (see "`app://` protocol" in `src/main/CLAUDE.md`). `ChatSidebar` calls the same helper for markdown images in chat bubbles, so both paths are covered by the one rewrite. Anything that resolves outside the workspace returns null and the source stays visible. The widget detects a wrapping `[…](url)` link via the syntax tree and, if present, makes the image click-open the link; otherwise its `ignoreEvent` lets CM place the cursor on a single click so the user can select/edit.
- **`imagePaste.ts`** — handles both clipboard paste and drag-drop into the editor. Pasted screenshots arrive without a name → fall back to a timestamped `"Pasted image …"`; dropped files use their original basename. Multiple images get one `![](filename)` per line. The main-process `fs:writeImage` handler runs the chosen base through `uniquePath` (same-dir uniqueness) so collisions get `" 1"`, `" 2"`, … appended. For draft tabs (no file on disk yet), the plugin calls `flushDraftToDisk` to force the pending save through the normal `writeNow` path — the draft turns into a real file, the image lands next to it. The promotion record `writeNow` leaves behind (see "When the load effect reads from disk") keeps the buffer intact across the resulting `activeFile` change.

**Sidebar→editor image drag**: dragging an image from the file tree into the editor inserts a relative `![](…)` reference to that workspace file. react-arborist's react-dnd backend is **scoped to the tree element** via the `<Tree dndRootElement={wrapRef.current}>` prop (`FileTree.tsx`), so it no longer owns window-wide drag events — the editor receives the native drop cleanly. The tree row sets the workspace-absolute path under a custom dataTransfer MIME (`SIDEBAR_IMAGE_MIME`, exported from `imagePaste.ts`) on `dragstart`; the editor's `dropPlugin` reads it back via `getData` on `drop`. The drop is still attached via `view.contentDOM.addEventListener` (not CM6's `domEventHandlers`) so it can `stopImmediatePropagation` before CM6's built-in drop handler runs — CM6 would otherwise `readAsText` the image bytes and insert garbage (this is about CM6's own behavior, unrelated to react-dnd). The image-row `dragstart` still `stopPropagation`s react-arborist's drag source so image rows drag-to-embed rather than tree-reorder.

## Coding agent (renderer side: chat sidebar)

Right-side chat sidebar (`ChatSidebar.tsx`) backed by `@earendil-works/pi-coding-agent`. The sidebar is collapsed to a 28px strip by default; clicking the strip expands it. State (`chatSidebarOpen`, `chatSidebarWidth`) is persisted to settings.

For the agent session lifecycle (per-chat session map, steering, failed-image guard, the system prompt, skills, agent-tokens) see **`agent-core/CLAUDE.md`**; the desktop host wiring is in `src/main/CLAUDE.md`.

### chatStore.ts — per-chat state outside the React tree

Chats run **concurrently** — in the desktop's `agent-core` host, or on the **companion** (Telegram/cron, or the same chat open on another machine) — so their state can't live in component state (the sidebar unmounts on collapse and remounts on workspace switch). `chatStore.ts` is a module store (consumed via `useSyncExternalStore`) holding one entry per chat, keyed by chatId: transcript, `running`, tokens/elapsed, error, composer draft + attachments, streaming cursors, and `activeByWorkspace` (which chat each workspace shows). Rules:

- **One event subscription for the whole app**, made lazily inside the store, never torn down. Main stamps every `agent:event` / `agent:error` with its `chatId`; the store routes it into that chat's entry whether or not it's on screen. Events arrive for local turns (IPC) **and** for turns running on the companion or another machine (main's always-on live feed), so a Telegram or cron run streams in whether or not that chat is open.
- **The server is the source of truth; the store is a view of it.** `openChat` ALWAYS re-reads and **replaces** the chat's messages. It used to skip the fetch when the chat was already loaded, which froze it for the life of the app — a chat you'd looked at once never showed another Telegram message until restart. Replace (not concat) is what makes the re-read safe: every message is stored as pi completes it, so the stored rows are the whole chat and appending a streamed tail would double what the feed already delivered.
- **Discovery + repair.** `shockwave_chat` fires at the start of every turn wherever it runs; for a chat this app has never seen, the store calls `discover()` → `hydrateOnly()` so it lands in the right workspace with its history instead of a bare tail. `window.api.chat.onFeedResync` → `resyncAll()` re-reads every loaded chat after the live feed drops and reconnects.
- **New chats mint their chatId here** (`crypto.randomUUID`) — main hands it to pi, so events are routable before the first byte streams back.
- State is replaced immutably on every update so untouched message rows keep referential identity (preserves `MessageRow`'s memo).
- `ChatSidebar` is a view over the active entry. Its only local state is view-stuff (popover open, rename draft, drag-over, voice partials). "New chat" just mints a fresh entry — the previous chat keeps running in the background (spinner on its row in the history popover; switching into it mid-turn shows the live stream).
- **Sending while the chat is running steers** — main queues the message into the running turn; the composer never locks, and Stop + Send coexist while running. `queue_update` events drive the "N queued" hint on the Working line.
- After a window reload the store reseeds running flags from `agent:runningChats`.
- **Remote / companion runs.** A chat can execute on the companion or another machine (a Telegram/cron turn, or the same chat open on a second desktop). The entry stores the run's origin machine RAW (`runMachine`); `remoteMachineOf(entry)` compares it against `window.api.app.machineId()` at read time and a non-null answer freezes the composer. Derived rather than stored because `machineId()` resolves asynchronously at startup — a comparison made once, at `agent_start`, is permanently wrong for any turn whose first event beat that answer. There is nothing to subscribe to; main's live feed is always on, so those events are already arriving.

### "Working" is DERIVED — there is no stored flag to get stuck

`isWorking(entry)` = a turn is claimed to be in flight **AND** the channel carrying that claim is still alive. A turn on this machine reports over IPC (alive as long as the app is); a turn anywhere else reports over the live feed, so `chatStore` mirrors main's `companion:state` and gates remote runs on it. A dead feed means we know *nothing* about that turn, and knowing nothing must not render as a spinner.

This replaced a stored boolean set by `agent_start` and cleared only by `agent_end`, and the failure it caused is worth keeping in mind because every part of it looked reasonable in isolation:

- Losing ONE terminal event stranded the flag on. A silently half-open feed (see `STREAM_IDLE_TIMEOUT_MS` in `src/main/api/client.ts`) or a companion restarted mid-run both do it, and a Memory run was observed sitting on `Working 150m 36s` — well past the companion's own 30-minute watchdog, so the run had certainly ended.
- **The stale flag then blocked its own repair.** `hydrateOnly`, `openChat` and therefore `resyncAll` all bailed on `running`, so the reconnect re-read — the one thing that would have learned the truth — never ran. Stop didn't help either: it aborts a *local* session, and this turn wasn't local. Restarting the app was the only exit.

So the guard on re-reading is now `running && !remoteMachineOf(c)` — running *here*, not running at all. A turn on this machine genuinely owns the screen (the server holds only finished messages, so a replace would delete the tool call in flight); a turn anywhere else is the **server row's** call, via `applyRunState`. That is safe to trust because of the ordering in `api/src/store.ts`: the machine doing the work clears `running` only after uploading the turn, so `running: false` means "finished AND stored", never merely "stopped talking".

`agent_send_failed` clears the run state too. It didn't, and only got away with it because pi happens to emit `agent_end` alongside — a second event doing the load-bearing work.

### Event protocol consumed by the store

`agent_start` / `agent_end` gate the per-chat running state. `turn_end` carries pi's normalized `usage` (we sum `totalTokens` across turns; each turn re-pays for context so the sum matches billed usage). `message_update` carries `assistantMessageEvent` (`thinking_start/delta/end`, `text_start`, `text_delta`). `tool_execution_start` / `tool_execution_update` / `tool_execution_end` build collapsible tool entries keyed by `toolCallId`. `shockwave_chat` / `shockwave_chat_titled` carry chat identity (title, pinned). Assistant text is rendered through `react-markdown` + `remark-gfm`.

**`MessageRow` is wrapped in `React.memo`** so typing in the composer doesn't re-parse every prior assistant bubble's markdown through `react-markdown`. Keep `MessageRow`'s prop surface narrow (just the message object) — adding non-memoized callbacks would defeat this.

### Filtering history by where a chat came from

Every chat carries a `source` (`desktop` | `telegram` | `cron` | `review` | `memory` — see the `chat` table in `api/CLAUDE.md`), and the history popover offers a checkbox per source. The selection is `settings.chatSources`, and two decisions in it are deliberate:

- **`null` means all**, and it is the default a fresh install gets. Not a seeded full array: a source added in a later release would then be missing from every stored list and silently hidden. A stored array is only ever an explicit narrowing.
- **Machine-local, not synced** (`LOCAL_SETTINGS` in `src/main/api/localSettings.ts`). It's a view preference — you might want scheduled runs out of the way on a laptop and visible on a desktop — and it hides nothing that isn't still there.

`CHAT_SOURCES` / `CHAT_SOURCE_LABELS` live in `constants.ts`; the filter narrows the list only, never what the store holds, so a hidden chat still streams and still shows a spinner if you unhide it mid-turn.

> **Every source the companion can write must be in `CHAT_SOURCES`.** A missing one is not a missing checkbox: those chats stay visible while `chatSources` is `null` (the default, meaning all), so nothing looks wrong — and the moment the user narrows the filter once they become invisible with no control to turn them back on, while `allSelected` computes true over the known list and the menu claims everything is shown. You find that bug by losing history. Pinned by `tests/chatSources.test.js`, which scans `api/src` for the `source:` literals the run entry points actually write, so the next one is covered the day it is added rather than the day it is missed.

### Workspace change

The chat sidebar is mounted with `key={workspacePath ?? 'no-workspace'}` in `App.tsx`, so switching workspaces remounts it — but the store survives, so transcripts, drafts, and running chats are all intact; the remounted sidebar simply shows the new workspace's active chat (`activeByWorkspace`). Chats running in another workspace keep streaming into the store.

### Attachments (`chatAttachments.ts`)

The composer accepts images (PNG/JPEG/GIF/WebP) and a long list of text/code file extensions, via the paperclip button, paste, or drag-drop onto the sidebar. Images are sent as pi's `ImageContent[]` shape; text files are inlined into the prompt as `<file name="…">…</file>` blocks before the user's typed message. Rejected files (unsupported format or read error) surface a dismissible inline error.

**A sent image survives the send — `AttachmentChip` renders from two sources.** A file you just picked carries its bytes inline (`dataUrl`), which is what paints it the instant you hit send. A message loaded from a stored chat carries `url` instead — `app://attachment/<id>`, which main proxies to the companion's `GET /attachment/:id` (the API key lives in main, so the renderer can only ask for a URL). The chip takes whichever it has and knows nothing about the other.

That split is the whole fix for images not rendering. The optimistic row in `sendToChat` was the *only* thing drawing a picture, so it died on any re-read — `openChat` always replaces messages, and `hydrateMessages` had no attachments to rebuild from. A Telegram image never got that row at all (it arrives from the server, not your hands) and so never rendered even once. Both now come back from `attachment` rows the companion stored when the message was appended. **Metadata only on a chat read** — ids and mime types, never bytes — so opening a chat costs nothing extra and `loading="lazy"` means only the pictures actually on screen are fetched.

### Voice input (composer mic button)

The composer's microphone button uses `voice/useVoiceInput.ts`, which streams 16kHz PCM via the Web Audio API + an inline `AudioWorklet` to a real-time WebSocket — **AssemblyAI's, Deepgram's or ElevenLabs'**, per the MICROPHONE's own assignment (`settings.transcription.micProvider`, unset ⇒ `transcription.provider`; see `micProviderOf` in `agent-core/voiceProviders.ts` for why the mic is chosen separately). The flow:

1. Renderer asks main for a short-lived streaming token via `voice:getToken`, which answers `{ token, provider, tokenTtlMs, singleUse }`. The long-lived API key never leaves main, and this file never reads settings — the provider AND the token's own rules arrive with the token.
2. `useVoiceInput` prefetches a token on mount and caches it for a FRACTION of the lifetime the mint reported, never a constant. It was 50s, tuned to the 60s tokens the first two engines issue — **ElevenLabs issues 15 minutes and consumes the token on first use**, so a constant would both throw away a good token and, worse, hand back a spent one. The cached token is cleared as it is handed out and a background refresh replaces it, which is what makes the single-use case safe; on click it is consumed instantly so the next click is also instant.
3. `navigator.mediaDevices.getUserMedia({audio: true})` opens the mic, fed into an `AudioContext({sampleRate: 16000})` and through an `AudioWorkletNode` running a tiny PCM-buffering processor registered inline via a Blob URL (no separate static file).
4. The worklet posts 4096-sample Float32 chunks back to the main thread; we convert to `Int16` and send over the WebSocket, while emitting per-chunk RMS volume for the `VoiceBars` visualization (`voice/VoiceBars.tsx`).
5. The socket's messages become `onPartialTranscript` / `onTranscript`. The composer renders partials in a faded color and commits finals into the text.

**The audio is identical for all three — only the socket URL, the wire encoding, the message shape, and the goodbye differ.** Everything from the microphone to `ws.send` is shared, which is what makes a third engine cheap. Two places they genuinely diverge, and both fail quietly:

**The encoding.** AssemblyAI and Deepgram take the PCM frames raw; **ElevenLabs takes them base64 in a JSON envelope** (`input_audio_chunk`). Same 16 kHz mono s16le bytes either way — sending raw frames to ElevenLabs is accepted by the socket and transcribes nothing.

**What a message MEANS**, where reading it wrong is silently lossy:

- **AssemblyAI** `Turn`: `transcript` is *the whole turn so far*, so each message REPLACES the last and `end_of_turn: true` is simply the final one.
- **Deepgram** `Results`: each message covers *one segment*, so the pieces ACCUMULATE. `is_final` freezes a segment; `speech_final` says the utterance ended. A full utterance is every finalized segment since the previous `speech_final`, which is what `dgCommittedRef` holds. Applying the AssemblyAI reading here — treating one message as the whole turn — would commit only the last few words of anything you said, with nothing erroring.

- **ElevenLabs** names the kind on `message_type` and hands back the WHOLE committed utterance rather than a segment — so it reads like AssemblyAI's branch, not Deepgram's, and nothing accumulates. Its auth, quota and rate-limit failures arrive as `*_error` messages rather than as a socket error, so without handling them the mic closes with no explanation.

Cleanup also branches, three ways: `Terminate`, `CloseStream`, `commit`. All mean "the audio stopped, flush what you have", so `providerRef` outlives the socket long enough for teardown to pick the right one (`GOODBYE`).

**And the socket then stays open for `FLUSH_GRACE_MS` (1.5s), because the flush comes back on it.** Cleanup used to `close()` on the very next line, which is not a race it sometimes lost: `close()` moves `readyState` off OPEN synchronously and the HTML spec drops incoming messages from that moment, so the answer to the goodbye could *never* arrive and the end of every utterance was discarded. Measured against a live Deepgram socket — 0 messages after the goodbye with the close inline, 3 with it deferred. The microphone, the audio graph and the worklet are all torn down first, so nothing further is sent; this is a socket lingering to hear the last words, not a recording still running. Vendors hang up themselves once flushed (Deepgram answers and closes with 1000), so the timer is only the backstop for one that doesn't.

It carries a request guard: without one the last response to land won rather than the newest, and a request fired before the key was stored could resolve after a successful one and pin `voiceAvailable` false.

**A failed mint dims the mic; it never removes it.** The button was `{voiceAvailable && …}`, so any refusal — a Deepgram key without permission to mint, a companion away at mount — deleted the control, and `useVoiceInput` reduced the reason to a boolean on the way past. The result is the worst shape a failure can take: nothing on screen, nothing to click, and a feature that reads as never having been built. So the hook keeps `voiceError`, and `ChatSidebar` always draws the mic — dimmed, the vendor's own sentence in its tooltip, and a click that opens Settings → Agent Voice instead of the socket. **Don't put the visibility back behind `voiceAvailable`**: the whole point is that an unusable mic must still say why. Settings already printed that exact sentence under Verify; only the composer was silent.

**Re-asking is one fan-out, not one call site per caller.** `notifyVoiceConfigChanged()` (module-level, exported from `useVoiceInput.ts`) re-mints in *every* mounted instance. There are two — the composer's and the Settings page's — with no shared state, so the old per-caller `recheck` gave a fresh answer only to whoever remembered to ask: Verify went green on the Settings page while the composer sat on the old refusal for the life of the app, and restarting was the only way back. `VoiceSection` calls it after verifying, switching provider, and removing a key. **It has to be a renderer-side fan-out rather than the IPC push**, because `settings:changed` deliberately never fires for the renderer's own writes (main passes `notify: false`) and saving the key *is* a renderer write. The hook also subscribes to that push for changes made elsewhere — another machine, the companion, `/voice` — filtered so it doesn't mint on every unrelated save: re-ask when the `transcription.provider` + `transcription.micProvider` + `hasVoiceKey` fingerprint moves, **or whenever there is no working token**. (Both provider fields, because the mic mints against its own assignment — watching only `provider` would miss the whole point of pointing the mic somewhere else.) That second trigger is the load-bearing one — replacing a rejected key with a good one for the same vendor leaves `hasVoiceKey` true→true and moves no fingerprint the renderer can see, since it never receives key values.

**The mic turns itself off, and each reason is a different kind of "done".** It used to stop for three reasons only — a second click, a socket error, and unmount — so the common case of hitting send left a live socket streaming the room into your next message for the whole length of an agent turn. The full set now:

| Trigger | Where | Flush |
|---|---|---|
| Mic button, Escape in the composer | `ChatSidebar` | kept |
| **Send** | `onSend` | **discarded** |
| New chat | `onClear` | kept |
| 45s of silence | `SILENCE_TIMEOUT_MS`, in the hook | kept |
| Sidebar collapse, workspace switch | the hook's cleanup effect, via unmount | kept |

Two things in that table are load-bearing:

- **Send is the only one that discards**, and it has to. `cleanup` says goodbye and leaves the socket open `FLUSH_GRACE_MS` to hear the answer, so those words arrive *after* the draft was cleared and open the NEXT message with the tail of the one you just sent. On AssemblyAI it's a duplicate rather than a tail — its final `transcript` is the whole turn, and `onSend` already commits the partial itself. `stopRecording({ discardPending: true })` sets a ref the message handler checks first. Losing the tail is the trade and it's the right one: hitting send says the utterance is over, and what the composer showed is what went.
- **Collapse and workspace switch need no code** — `App.tsx` mounts `ChatSidebar` conditionally and keys it on `workspacePath`, so both unmount it and the hook's `useEffect(() => cleanup, …)` does the rest. Don't add explicit stops for them; if that conditional mount ever becomes a CSS hide, these two become real gaps.

The silence backstop counts a chunk above `SILENCE_RMS_FLOOR` **or** any transcript message as activity — a quiet microphone the vendor is still transcribing is one that's being used. It stops without a toast (the meter vanishing is the message, and by then nobody is looking) and it exists as much for the bill as the privacy: all three vendors charge by the minute the socket is *connected*.

**Mic permission gotcha**: Electron prompts for microphone access on the first `getUserMedia` call and persistently grants it for the origin. The Settings → Agent Voice "Test microphone" button (`settings/VoiceSection.tsx`) exists primarily so users can trigger that one-time prompt in Settings, where they expect it — without it, the first click of the chat composer's mic would prompt mid-conversation. **It tests the MICROPHONE — the hardware, the permission, and the whole path through whichever vendor the mic is assigned to.** Checking a *key* is a different question and belongs to Verify, on that vendor's row. The two were one button doing both jobs badly; that is why Test microphone now sits under the Microphone assignment rather than as its own section, and why it stays `outline` while the three per-vendor Verifies are the page's primaries (see `settings/CLAUDE.md`).

## GitHub sync (renderer side)

The engine lives in main (see `src/main/CLAUDE.md`); the renderer just bridges three things.

**Mount-only subscription.** `App.tsx` subscribes once on mount (no workspace dep) to two push events: `sync.onFlushRequest` and `sync.onStatus`. Same discipline as the `fs:changed` listener — do NOT add per-render objects (`writeNow`, `linkIndex`, etc.) to deps. `writeNow` is read via `writeNowRef.current()`, so the closure stays stable. If the listener tore down per render, an in-flight tick could lose its flush ack.

**Engine start on workspace switch.** `loadWorkspace` calls `window.api.sync.engineStart({ workspacePath, intervalSeconds })` after `watchStart`. The engine looks the workspace row up by path and reads repo + branch from it; a missing PAT or an unknown path emits `unconfigured`, so the renderer doesn't gate on those locally. The mount-effect cleanup calls `engineStop` so a full reload doesn't leave a tick running against a torn-down window.

**Status icon.** `EditorStatusBar.tsx`'s `SyncStatusIcon` maps the 6 statuses to one icon each (`paused` is handled unconditionally — gating it on a non-empty conflict list let a stopped engine render a green "Synced"): `unconfigured` → **hidden**; `idle` + `lastSyncAt===null` → gray `Cloud` ("not synced yet"); `idle` + set → `CloudCheck`; `syncing` → spinning `Refresh`; `offline` → `CloudAlert` (amber, "retrying"); `paused` → yellow `AlertTriangle` (click → conflict view via `onOpenConflicts`); `disabled` → **two looks off `syncStatus.disabledByUser`** — you turned sync off → gray `Stop`, an error stopped it → red `AlertCircle`. Both click through to the same popover (reason + **Enable** → `onEnableSync` → `setWorkspaceDisabled(false)`). Idle/syncing/offline still click through to the repo URL when known.

Painting both disabled cases gray meant a sync that had **died** looked exactly like one you had parked — the icon that should raise an alarm was the one you'd taught yourself to ignore. The error case is `AlertCircle`, deliberately **not** the triangle: that shape already means merge conflicts, and amber-triangle-vs-red-triangle in a 20px slot is a distinction nobody reads.

### Conflict-resolution view

When `syncStatus.conflicts` is non-empty, a red conflict toggle appears at the **far right** of the `SortBar` (with a count) and the red sync icon links to it; clicking either flips the file tree into a conflict-only view (`conflictFilterActive` in `App.tsx`). It auto-exits when the list clears.

- **Data source is the git conflict list, NOT the file tree.** `buildConflictTree(absPaths, workspacePath)` constructs folder/file nodes straight from `syncStatus.conflicts` (rel→abs). The normal tree (`buildTree`) hides dotfiles, but conflicts happen in them (`.obsidian/workspace.json`), so the view is built independently — any file type, including hidden, shows up.
- **Review-only.** Right-click a file → **Conflict resolved** / **Keep our file** / **Reset to remote** (`FILE_ACTIONS.RESOLVE`/`KEEP`/`RESET` → `conflictFileAction` → `sync.resolveConflict`/`keepConflict`/`resetConflict`). Resolve flushes the file first (`writeNow`) so git stages the user's edits, not stale on-disk content.
- **Whole-tree** actions live on the cloud icon's **right-click** (`showConflictCloudMenu` → `keep`/`reset` → confirm dialog → `sync.keepAll`/`resetToRemote`). Both are behind a `ConfirmDialog` (destructive).
- The view refreshes from the engine's `sync:status` push (fewer conflicts / idle), not the watcher — the watcher ignores dotfiles and `git add` changes nothing on disk.

**Settings.** Two sections, split by scope:
- `settings/GitHubSection.tsx` ("GitHub Sync") — the PAT + verify, the sync interval, and the `git --version` check. None of it is per-workspace: one account, one engine, one binary.
- `settings/WorkspacesSection.tsx` — the list and nothing else.

They were briefly merged (account above the list) and split again: the list is what you come to that page for, and three global controls on top pushed it below the fold. The merge's actual gain is kept — the old split's failure was that Workspaces never told you where the token lived, so `AddWorkspaceDialog` now links straight to the GitHub section when none is set.

Each row: inline rename (click the name), a **Sync** switch, and Open / remove. The switch only takes effect while that workspace is open — the engine is a singleton bound to the active workspace — which the tooltip says, since the label has no room for it.

A row whose `path` is null is a workspace that exists but **isn't checked out on this machine** (a DB copied from another machine, or a folder that went missing). It shows `owner/repo — not on this machine` and offers **Set up here** → folder picker → `workspace:setUpHere`, which clones into an empty folder or attaches one that's already a clone of that same repo. Sync + Open are hidden there — neither means anything without a checkout.

## Send to Agent

The editor context menu offers "Message Agent" when the active file has a path on disk (`EDITOR_ACTIONS.SEND_TO_AGENT`; drafts opt out). It builds a framing snippet (`buildSendToAgentSnippet` in `App.tsx`) with a `[cwd]/...` workspace-relative path plus selection or cursor coordinates, fences any selected text in `~~~`, and injects it into the chat composer:

- Sidebar closed → expand it, queue the injection in `pendingComposerInjection`, drain via an effect once the sidebar's imperative ref attaches (`chatSidebarReady` flag flips on a callback ref).
- Sidebar open with empty composer → inject directly.
- Sidebar open with existing text → open a Dialog asking Replace / Append / Cancel.

The chat sidebar exposes `setComposerText(text, { append })`, `getComposerText()`, `focusComposer()` via `useImperativeHandle` for this flow.

## Bookmarks

**Bookmarks are `.md`-only and identified by basename, not path.** Only `.md` files can be bookmarked (the context menu offers it only for `.md`); the basename is the key, and its location is resolved on click through the link index (`getFirstLinkpathDest` — when two files share a basename across folders the resolver's tiebreaker picks one). **Tracking the name is what makes moves free** — moving a file between folders doesn't change its basename, so there is no per-move bookmark bookkeeping. Only a *rename* (which changes the basename) re-keys, and that rides along with the existing wiki-link rename rewrite.

Stored at `<workspace>/.shockwave/bookmarks.json` as `{ version: 1, names: ["recipes", ...] }` (lowercased basenames). The `.shockwave/` segment matches the watcher's dotfile-ignore predicate so our own writes don't echo back. The renderer keeps an in-memory `Set<basenameKey>` (`bookmarkKey(path)` = basename, no `.md`, lowercased — the same basename key the link index resolves on). On workspace load `seedBookmarks(names, resolvableKeys)` prunes names whose `.md` file is gone and rewrites if pruned. No migration from the old path format — by design.

Toggle via the file context menu (`FILE_ACTIONS.TOGGLE_BOOKMARK`, `.md` only) or the bookmark icon in the sort bar. `renameBookmarkName(oldKey, newKey)` / `removeBookmarkName(key)` / `persistBookmarks` keep the set in sync; the watcher's `fs:changed` rename/unlink handlers and the two in-app rename spots (`onTreeRename` file branch, `onTitleCommit` → `performRename`) call them — a *move* hits `renameBookmarkName` with equal keys and no-ops. The sort bar's bookmark button toggles a filter mode that prunes the tree to only bookmarked files (and the folders that contain them); right-click opens a picker — App resolves each bookmarked name → current path (`bookmarkItems`) so the picker can open it and show its folder.

## Daily notes

Calendar button in the `ThinSidebar`:
- Click → open today's daily note (create if missing).
- Right-click → opens `JournalDatePicker` (a `react-day-picker` popover anchored at the cursor) to pick any date.

Settings → Daily Notes lets the user choose a dayjs format string (`YYYY-MM-DD`, `YYYY.MM.DD`, `YYYY/MM/DD`, `YYYY/MM/YYYY-MM-DD`, or custom), a workspace-relative folder via `FolderCombobox`, and a default template. This config is **per-workspace** (`.shockwave/workspace.json` via `workspaceSettings:update`), not a global setting.

**Templates come off the tree, not the disk.** `templates.ts`'s `collectTemplateFiles(tree, folder, workspacePath)` walks the already-loaded `TreeNode[]` for the `.md` **direct children** (non-recursive) of the configured folder — so the picker, the daily-note default and Settings all list the same set with no extra fs call, and a template added externally appears as soon as the watcher refreshes the tree. Each entry carries `path` (absolute, for reading the content) *and* `relPath` (workspace-relative, the portable form stored in `dailyNote.templatePath`) — storing the absolute path would break the moment the workspace is checked out at a different location on another machine. A missing or empty folder returns `[]`; nothing errors.

**The naming rules live in `agent-core/dailyNote.ts`, not here** — the coding agent's `daily_note` tool resolves the same files, and two copies would drift into each side opening a different note. `src/renderer/dailyNote.ts` is a re-export, the renderer's one door onto it. Slashes in the format become subfolder boundaries beneath the configured folder.

**`todayIso` in `App.tsx` is the app's single answer to "what day is it"** — computed once per render via `todayISO(timezone)` and passed to `useDailyNote`, `ThinSidebar` (the day number on the rail glyph), `JournalDatePicker` (which day is highlighted) and `DailyNoteSection` (the format previews). Before this, each of those read the machine's clock while the agent ran with `process.env.TZ` set from `settings.timezone`, so a user whose OS zone differed got a button and an agent that disagreed about today near midnight. It is deliberately **not** memoized: one `Intl` call is cheap, and a value cached across midnight leaves the app on yesterday. Anything new that needs today reads `todayIso` — never `new Date()`.

`openJournal(iso?)` takes a **calendar date**, not a `Date`, for the same reason the shared module does: a date the user picked off a calendar is a labelled day, not an instant, and converting it through a zone shifts it. It opens an existing note in place wherever it lives, but only when `basenameIdentifiesDate(formatted)` — with a path-style format like `YYYY/MM/DD` the basename is a bare day number, and looking `01` up in the link index answers August 1st with July's note; there the computed path is the only trustworthy location. Otherwise `ensureDir` + `createFile`, seeded from the configured template.

## Scheduled runs panel (`CronModal.tsx`)

The clock in the `ThinSidebar` opens the app's **whole** cron surface: the live schedule (next/last run, per-job status) plus a manual **Run now** per job. There is no cron settings page to pair it with — the desktop stopped running the scheduler, so what's left is the companion's env (see `settings/CLAUDE.md`).

**One-way by design.** `<workspace>/cron.json` is the source of truth for the jobs and their enabled flags; this panel *displays* that state and can trigger a run, and never writes definitions back. Editing jobs means editing the file (or asking the agent). Data comes from `cron:read` — the desktop composes the local `cron.json` with run status fetched from the companion — and `cron:runNow`. `cronSchedule.ts` (`describeSchedule` / `timezoneNote`) renders a cron expression as English via `cronstrue`, against `settings.timezone`.

## Quick search & sort bar

- **`SortBar`** (above the file tree): bookmark filter toggle, quick-search opener, sort menu, collapse-all, hidden-files toggle. The sort menu offers Name asc/desc, Modified new→old/old→new, Created new→old/old→new (`TREE_SORT_ORDERS` in `constants.ts`). Folders always stay first in A→Z order; the sort only re-orders files inside their folder. Sort is persisted to settings. `buildTree` in main stats every file for `mtimeMs` and `birthtimeMs` so the renderer can sort without re-statting.
- **Hidden files** (eye button, `showHiddenFiles` in machine-local settings): re-reads the tree with `readTree(path, { includeHidden })`, so dotfiles, `.git` and `node_modules` appear in the sidebar. **Display only.** The watcher, the link index, wiki-link resolution and editor reload keep their own rule (`isWatchIgnored` in main) and are unaffected — a visible `.gitignore` is not watched or indexed. Two consequences that follow from that, both intentional: external edits to a hidden file don't refresh the tree, and a hidden `.md` isn't in the link index. The flag is read from `settingsRef`, never from React state, at both `readTree` call sites — boot hydrates settings and calls `loadWorkspace` in the same tick, so a state read is still `false` there and the tree would come back filtered. Recent Files shows hidden files too (anything you edited belongs there) but skips `.git`, whose internals are rewritten on every sync commit and would otherwise own the list.
- **`QuickSearch`** (`QuickSearch.tsx`): modal launched from the sort bar. Empty query → top 10 files by the active sort order. With a query → `fuzzysort` ranks every file by workspace-relative path so typing `j/2026` finds `Journal/2026-05-24.md`. Matches are highlighted via `segmentsFromIndexes`. Arrow keys + Enter; Esc closes.

## Settings

### Settings are ONE object, and the screen READS it

`useSettings` holds a single `Settings` object plus a ref mirroring it, and nothing else. There are no per-field `useState` slices; the named values it returns (`sync`, `transcription`, `codingAgentSettings`, …) are reads off that object, kept only so App and `SettingsModal` keep the props they always had. **Adding a per-field `useState` here reintroduces the bug this shape exists to remove.**

Three rules, and they are the whole model:

1. **A push replaces the object.** `hydrateSettings(payload)` → `normalizeSettings` → one assignment.
2. **A write sends only what changed.** `persistSettings(patch)` merges the patch into the object and `buildPatch` sends the differing leaves. This half was always right and is unchanged.
3. **A different companion empties it.** `resetSettings()`, on `api:companionChanged`.

> **What this replaced, and why it could never be got right by care.** `hydrateSettings` used to fan one payload out into twenty `useState` slices with twenty-one hand-written assignments — and **seven of them were guarded on the key being present**. The companion answers `GET /settings` from the rows it HAS (`api/src/store.ts`), so a setting nobody has set is *absent* from the payload, not empty; `stripCredentials` deliberately won't conjure a missing parent to hang a `has*` flag on, so `sync` and `codingAgent` stayed absent too. Those guards therefore read "the new server has no row for this" as "keep the old server's value". Point the app at a second companion and its Agent, GitHub, Voice and timezone pages all kept the first one's — and `codingAgent` was worse than cosmetic, because `disk.codingAgent ?? settingsRef.current.codingAgent` put the stale slice in the canonical cache, which is both the diff base for saves and the merge source for `onCodingAgentChange`. The old server's provider and model could be written INTO the new one on the next edit.
>
> Every settings bug in this file's history is the same defect: `voiceReply` added to the complete mapping and missed in the partial one, `micProvider` dropped by a two-field whitelist, a fake `anthropic` provider invented by a defaults merge. Twenty-one places to get one fact right is what produced them; one place is the fix, not more comments on each branch.

`normalizeSettings` (`settingsModel.ts`, pure, `tests/settingsModel.test.js`) is the only way an object is built. It is **total** — every key of `Settings` is assigned, which the return type makes a compile error to get wrong — and it is a function of its argument alone. There is no `?? previous` in it and there must never be one: that is the mechanism, not a convention. Coercions and the two retired `treePanel` migrations live there, so they are one tested function rather than inline branches.

**Credentials never enter the object.** Main strips them on the way down; `persistSettings` drops them from what it *keeps* after building the patch, so a key you just typed travels to the companion without parking in renderer memory. `onVoiceKeyChange` sets the `hasVoiceKey` flag itself, since the value it sent is gone.

**Three values are deliberately NOT reads**: `sidebarWidth`, `chatSidebarWidth` and `chatSidebarOpen` stay App-local. A resize writes on every mousemove and persists once at mouseup, so routing it through the store would either write per frame or lag the pointer. All three are machine-local, so no companion can disagree with them.

### Pointing at a different companion — the one "forget it" signal

`api:write` broadcasts `api:companionChanged` when the **URL** changes (not the key — the companion is single-tenant, so the key is auth, not identity). App's handler empties the settings object, clears the workspace list and active id, calls `chatStore.clearAllChats()`, and runs `closeWorkspace()`. Main clears the machine-local `activeWorkspaceId` in the same breath, or that id survives into the new server's session and blocks the auto-load of a real workspace.

**It has to be its own event.** No push can carry the meaning: absent keys mean "unchanged" on every ordinary read, so a switch is indistinguishable from a read with fewer rows.

**It is NOT wired to the companion going offline**, and that is the deliberate line. An unreachable server is the same truth temporarily out of contact — clearing on it would flip the theme to system, empty the workspace list and close the editor every time the wifi blinked, and the files are on local disk and still editable. `SettingsModal`'s existing gate already refuses to show a synced settings page while unreachable, which is everything clearing would have bought. (Main's rule that going offline pushes the flag and *no* settings payload stands unchanged, for the same reason.)

### "Needs setup" badge — one rule, three readers

`setupStatus.ts` (pure, no React/window import, `tests/setupStatus.test.js`) answers one question per required item: **is it filled in?** `hooks/useSetupStatus.ts` gathers the two inputs that aren't in the settings object (the companion URL/key via `api:read`, git via `sync:checkGit`) and hands the flags to the **three** places that render them — the gear in `WorkspaceSelector`, the nav rows in `SettingsModal` (`BADGE_KEY_FOR_SECTION`), and the pages themselves. One definition is what stops them disagreeing.

Load-bearing decisions, each of which was a live option:

- **Filled-in only.** Whether a stored key still *works* needs the network, goes stale, and would mean polling GitHub + the model provider + the companion on a timer to keep one dot honest. A key that gets refused surfaces as a toast where it's refused; sync — the one failure that lasts days rather than seconds — holds its state in the status-bar icon instead.
- **Reachability is never a badge.** The companion goes away with the wifi and comes back; a dot that blinks teaches people to ignore dots. That's the red `CloudOff` in the sidebar footer (plus its toast) — a signal that says what it is, not a dot on the gear. Same for a **version mismatch**, which gets its own `CircleArrowUp` beside it: both are conditions of the server, not of your setup, and neither is answered by the question this file asks ("is it filled in?").
- **Unknown reads as fine.** `gitInstalled` defaults `true` because it's answered by spawning a process — a badge for the first 200ms of every launch is noise, not signal. Same for a probe that throws: keep the previous answer rather than claim git vanished.
- **Required only.** Companion, GitHub Sync (token **and** git — git isn't a field on that page but it's the other thing without which nothing on it works), Agent Chat. Telegram, Agent Voice and the per-workspace pages get no dot however empty they are; that's what keeps red meaningful.
- **One dot shape.** Empty vs rejected is explained in a sentence *on the page*, not by a second icon in a 216px rail.
- The agent rule mirrors `agent-core/agent.ts`'s runtime check exactly (provider, model, key unless `openai-compatible`). Two definitions of "configured" is how a page shows green while the turn it describes refuses to start.

`useSetupStatus` exposes `refresh`, called from the settings modal's `onClose` — Settings is the only place the companion config or git can change, so that's the whole refresh story, not a poll.

`SettingsModal.tsx` is the host; every section lives in `settings/`. **Deep doc: `settings/CLAUDE.md`** — when a value saves, credential handling, verify buttons, and the per-section inventory. Read it before touching any `settings/*.tsx`.

**`ReleaseNotesDialog.tsx`** (root of `src/renderer/`) is the app's "What's new" — markdown release notes for every version between this one and the newest, read without leaving the app. Rendered by `UpdatesSection`, reachable while an update is merely `available`, since reading what changed is how someone decides whether to download at all. Permanently mounted with an `open` prop, so its fetch keys off the open transition rather than mount.

**There is no update pill.** An "Update available" pill used to sit absolutely positioned over the tab strip's right end; the strip now owns that space (pinned `+` and the open-tab list). The toast in `useAppUpdate` carries the same news and the same action — Download while `available`, Restart once `ready` — and Settings → Updates is the durable copy. Both restart paths go through App's confirm dialog, never a bare `quitAndInstall()`: installing quits the app and kills a running agent turn. Note the consequence of dropping the pill — dismissing the toast snoozes that version, so Settings is then the ONLY place it appears, which is what `unsnooze()` exists to undo.

One piece lives out here because two callers render it: **`CompanionUpdateDialog.tsx`** (root of `src/renderer/`, rendered by both `App.tsx` and `CompanionSection`) — the remote-upgrade flow, **fire-and-forget**: confirm (versions + "in-flight Telegram/cron runs will be interrupted") → `apiUpgradeCompanion` → toast "started" → close. Completion arrives asynchronously: main watches the live feed reconnect after the companion's restart, re-checks the version, and pushes `api:companionUpdated`, which App.tsx toasts. Nothing waits or polls — an earlier version owned a poll loop behind a non-dismissable overlay, and one hung health check locked the entire app; don't reintroduce a blocking "updating…" phase. `updater-unavailable` (pre-sidecar companion) surfaces the install one-liner. Three openers: the `companion-version` toast's button, the Companion page's row, and `App.tsx`'s auto-open on `companion-older` (guarded — see "Companion reachability" above).

## Theme & design tokens

Three modes (`light` / `dark` / `system`) stored in settings; system mode listens to `nativeTheme` updates via `theme:systemChanged`. The effective theme is set on `document.documentElement.dataset.theme` and also re-passed into the Editor (which recreates the view to swap the light/dark syntax highlight style).

**Tokens live in `app.css`** (the Tailwind v4 entry, imported by `main.tsx` and processed by `@tailwindcss/vite` — the plugin is registered in `electron.vite.config.js`'s renderer section). It defines the shadcn semantic tokens (`--background`, `--primary`, `--border`, …) plus app-specific ones (`--selected` accent-soft fill, `--sidebar`, `--chrome`, `--chat`, `--raise`, `--success/-soft`, `--bullet`, `--folder`, `--code-chip`, amber `--ring`, and `--graph-node` / `--graph-link` for the force graph) in light + dark, and maps them to Tailwind utilities via `@theme inline` (`bg-selected`, `text-muted-2`, `bg-chrome`, `font-chat`, …). Dark mode is a custom variant on `[data-theme="dark"]` — do NOT introduce a `.dark` class.

The palette is the "polish spec": warm neutrals, one indigo accent (#5B57D8 light / #7D79E8 dark) used only for active/primary, amber keyboard-focus ring, JetBrains Mono for code/paths/line numbers, Instrument Sans (`font-chat`) for chat-panel message text only. All three fonts are self-hosted in `assets/fonts/` — never load fonts from the network.

### Type scale — four sizes, and no in-between values

Chrome text is **`text-micro` (10px) / `text-xs` (12px) / `text-sm` (13px) / `text-md` (14px)**, with the editor at 16px. Modelled on Obsidian, which this app's editor already matched: nav rows and tabs 13, status bar 12. Reach for the nearest of the four; do not add a fifth.

Before this the chrome was six ad-hoc literals across 24 files (9 / 10 / 11 / 11.5 / 12 / 12.5 / 13 / 13.5). Nobody chose those differences — each component was sized on its own, so every new one was a fresh guess, and the sidebar ended up smaller than every app it is modelled on. The visible tell was a `DropdownMenuItem` rendering at 14px directly under a 12.5px workspace name.

Three things about it are load-bearing:

- **`--text-sm` is Tailwind's OWN token, deliberately redefined from 14px to 13px.** That is what pulls the vendored shadcn primitives — menu and select items, buttons, labels are all `text-sm` — onto the scale *without editing them*, so `npm run ui:diff` stays clean. It also means plain `text-sm` gives you the right size and there's no bespoke class to remember. **Do not "fix" it back to 14px.**
- **The 14px step is `--text-md`, and naming it `--text-chat` is a trap.** `--color-chat` already exists (the chat panel's background), and **Tailwind resolves a `text-<name>` that collides with a color token AS A COLOR** — it emitted `.text-chat { color: var(--chat) }`, generated no font-size utility at all, and the chat body silently kept inheriting 16px. Check the color tokens before adding a size.
- **A custom `--text-*` name must also be declared to `cn()`** — `extend.theme.text` in `lib/utils.ts`. tailwind-merge decides which property a class sets from a table of Tailwind's *own* scale, so a name it doesn't know is assumed to be a text COLOR; `cn('text-micro … text-muted-2')` then looks like two colors and it deletes the size on the way to the DOM. The class simply isn't there, the element inherits 16px, and nothing reports anything — the stylesheet still has the rule and the JS still has the class, so a build comparison finds them both and they still never meet. Every settings-nav group header shipped at 16px this way from the day the scale landed. Plain `className` strings bypass tailwind-merge entirely, which is why most sites were fine and the bug looked like a design choice. Add the token to `app.css` and the name to `lib/utils.ts` in one move.
- **Text inside a body of text stays em-relative.** `.chat-markdown` headings, code and tables are in `em` so they track the transcript's body size instead of being pinned to it — the same way the editor's own code sizes already worked. A px value there re-breaks the link the moment the body size moves.

## Graph view (`GraphView.tsx`)

The rail's graph button (`ThinSidebar` → `onToggleGraph`) swaps the editor pane for a `force-graph` canvas of the workspace's `.md` files and their resolved wiki-links. Clicking a node closes the graph and opens that file in the active tab.

- **Edges come straight from `linkIndex.cache.resolvedLinks`** (source path → dest paths) — already resolved, so there is no per-edge resolution here and the graph can never disagree with the backlinks panel. Nodes are the `.md` leaves of the same `tree` the sidebar renders; a link whose endpoint isn't in that set is skipped rather than inventing a node.
- **Node objects are cached by path across rebuilds**, and that cache is the whole reason the view is usable. force-graph mutates `x/y/vx/vy` onto each node object, so handing it fresh objects on every `linkIndexVersion` bump would reset the simulation — the layout reshuffles from scratch every time any file in the workspace is saved. Reusing the reference keeps positions and velocities; entries for paths that vanished are pruned in the same pass.
- **Colors are read from CSS variables, not props** (`--graph-node` / `--graph-link` off `:root`), re-read on the `dark` prop changing. The canvas is outside React's styling, so the token is the only thing keeping it on the palette.

**It unmounts the Editor**, which is why it appears in the load-decision rules: nothing about the active *file* changes when the graph is toggled, so leaving graph view used to land an empty editor over a real file. `onViewCreated` → `editorEpoch` is what covers it (see "When the load effect reads from disk"). Toggling also flushes through `writeNow` first, like every other operation that changes what's on screen.

`app.css` is the app's ONLY stylesheet (`styles.css` is gone). Its bottom section is a clearly-banner-marked **unlayered legacy block** — CodeMirror widget styling (`.cm-*`), `.chat-markdown` typography, the Excalidraw sizing rule, `.image-drag-ghost`, the legacy `--bg-*`/`--fg-*` tokens those rules use — kept unlayered because CodeMirror injects its own runtime styles and ours must keep beating Tailwind's layers. Never add component classes there; style components with Tailwind utilities inline. Also beware: react-arborist rows receive an inline `paddingLeft` (the nesting indent) that beats any class padding — see FileTree's Node.

## Reusable UI primitives

shadcn/ui components live in `components/ui/` (installed via `npx shadcn@latest add <name>`, config in `components.json`, `cn()` in `lib/utils.ts`, `@/*` alias → `src/renderer/*`). Icons: `lucide-react` (a few app-specific ones remain in `Icons.tsx`).

**Updating vendored components:** `npm run ui:diff` shows upstream drift for every installed component (`npm run ui:diff -- button` for one). It's read-only. To update: `npx shadcn@latest add <name> --dry-run`, review, then merge preserving local edits — `sonner.tsx` is intentionally customized (data-theme instead of next-themes) and will always show drift.

- `Dialog.tsx` — legacy-API wrapper (`open/onClose/title/children/footer`) over shadcn Dialog; portal + focus trap come from Radix.
- `ConfirmDialog.tsx` — shadcn AlertDialog two-button confirm (`destructive` prop → red action).
- `ErrorMessage.tsx` — shadcn Alert (destructive) banner.
- `QuickSearch.tsx` — cmdk Command in a Dialog; fuzzysort does the ranking (`shouldFilter={false}`).
- `Combobox.tsx` / `settings/FolderCombobox.tsx` — custom input + filtered listbox (freeForm typing), Tailwind-styled.
- Toasts: `sonner` `<Toaster>` mounted in `App.tsx`, anchored bottom-right of the editor pane — over the content being read, not the chat column. Two placement constraints, both learned: it must **not** be a direct child of the `.app` grid (a stray grid child adds an implicit row and squeezes the layout), and it must **not** live inside a scroller (its own class swaps sonner's `fixed` for `absolute`, so an `overflow-y-auto` ancestor would scroll it away with the content). Its containing block is therefore a `relative`, non-scrolling wrapper. **The right gutter is 26, not the ~14 a margin would want**: that wrapper CONTAINS the scroller, so a toast's right edge lands on the scrollbar rather than beside it. 14 is the gap we want, ~12 is the scrollbar. Use `toast()` for background events only; inline errors stay `ErrorMessage`.

## UI conventions (read before building any new dialog / settings page)

**Everything new is Tailwind + shadcn.** Compose `components/ui/*` primitives; style with Tailwind utilities against the semantic tokens (`bg-background`, `text-muted-foreground`, `border-border`, `bg-selected`, `bg-raise`, …). Never hardcode hex colors, never use `dark:` overrides for colors the tokens already handle, no `style={{}}` for colors/borders/fonts.

**Templates:**
- New settings section → copy `settings/GeneralSection.tsx`: `<SettingsSection title description>` + `<SettingsGroup title>` per concern (`description` too, when the group is the unit that makes sense and its fields don't individually) + `<SettingsDivider />` between groups (scaffolding in `settings/SectionUI.tsx`, 360px measure; pass `wide` for entity lists). Controls: shadcn `Field`/`FieldLabel`/`FieldDescription`, `Input`, `Select`, `Checkbox`, `Switch`, `Slider`, `Button` — and `settings/CredentialRow.tsx` for anything holding a secret. (`InputGroup` is vendored but no longer used by anything; it was how credential fields carried addons, and that shape is what `CredentialRow` replaced.) Wire into `SettingsModal.tsx`'s NAV + `SETTINGS_SECTIONS` in `constants.ts`.
- New modal dialog → shadcn `Dialog`/`DialogContent`/`DialogHeader`/`DialogFooter` (or the legacy-API `Dialog.tsx` wrapper); confirms → `ConfirmDialog`. Footer buttons: `Button` (default = primary, `variant="outline"` = cancel, `variant="destructive"` = irreversible).
- **Button hierarchy: EXACTLY ONE primary (blue, default variant) per settings page / dialog** — the page's main action. Every settings page has one; a page whose fields all auto-save still has the action you came there to take (GitHub → Verify, Agent Voice → Verify, Agent → Test, Companion → Connect). Where a page has both a credential check and a wider end-to-end test, **the credential check is the primary** — Agent Voice's "Test microphone" has the bigger side effect (it triggers Electron's one-time mic permission prompt) but nothing on the page means anything until the key is known good. Secondary actions are `outline` (white), row icons `ghost`.
- **`destructive` (red) is for removing something, and nothing else.** Every credential field's Remove uses it. It is not a "careful" style — approving a changed certificate is dangerous and is still not red, because it destroys nothing.
- Icon buttons in chrome: 26px hit targets `size-[26px] rounded-[7px] text-muted-foreground hover:bg-accent hover:text-foreground`; rail buttons 34px. Active state: `bg-selected text-primary`.
- Menus → `DropdownMenu`; anchored pickers that must not own left-click → controlled `Popover` + `PopoverAnchor` (see SortBar's bookmark picker).
- `SelectContent` defaults to `position="popper"` — it opens BELOW the trigger. Don't
  pass `position="item-aligned"`: that's Radix's macOS convention where the menu
  covers the trigger, and with nothing selected it has no item to align to and looks
  broken. Our vendored copy had drifted to `item-aligned` as the default, so ten of
  eleven Selects inherited the overlay; the one author who hit it patched their own
  call site instead of the default, which is why it survived.

**A modal is CONTROLLED by an `open` prop and is never conditionally mounted.** Render
`<TheModal open={isOpen} …>` unconditionally; never `{isOpen && <TheModal>}` around a
`<Dialog open>`. Radix's `DismissableLayer` puts `pointer-events: none` on `<body>` while a
modal is open and takes it off in its close sequence, and it tracks that with a `Set` of
live layers plus a module-scoped `originalBodyPointerEvents` holding the value to restore.
Unmounting an open dialog tears the dialog and everything inside it (an open `Select`, a
`DropdownMenu`) down in ONE commit, so their cleanups race: whichever runs last writes its
own saved value back. If that's the inner layer — which saved `"none"`, because the dialog
had already set it — `<body>` keeps `pointer-events: none` forever.

The result is the worst possible failure shape: **the app renders, animates, syncs and
logs perfectly while ignoring every click.** It looks like a total hang, but every process
is idle at 0% CPU and macOS doesn't mark it unresponsive. The tell is that **the keyboard
still works** — keyboard events don't go through pointer hit-testing. If you ever see that,
check `document.body.style.pointerEvents` first; `document.body.style.pointerEvents = ''`
un-sticks it without a restart.

Anything that used to run on mount then has to key off the open transition instead —
`UrlPromptModal` reads the clipboard to pre-fill, and permanently mounted that would fire
once at app start and never again. `SettingsModal` re-applies `initialSection` on open for
the same reason, or every deep link would land on whatever page you closed Settings on last.

**Radix internals that touch `document` are pinned to ONE copy** (`overrides` in
`package.json`: `react-dismissable-layer`, `react-focus-guards`, `react-focus-scope`).
Radix pins its own deps to exact versions, and `@radix-ui/react-popover@1.1.6` (pulled in by
Excalidraw) held the hoisted slot at an older one — so npm nested a *separate physical copy*
under `react-dialog`, `react-select`, `react-menu` and five others. Nine copies of a module
whose state is global to one `document`, each with its own `Set` and its own
`originalBodyPointerEvents`, is what let the restore write back the wrong value at all. Do
not remove these overrides; the versions are minor bumps within the same major, and without
them the layer bookkeeping is not actually shared.

**When a setting saves — one rule, no Save buttons.** Inputs commit on blur, everything
else on change, there are no Save buttons, and credential fields are write-only. The full
policy — and the bugs each rule exists to prevent — is in **`settings/CLAUDE.md`**. Read it
before adding a field, a verify button, or anything that holds a credential.

**Other rules that still hold:**
- Labels describe the control, not the section ("Color theme", not "Theme" again).
- Validation/operation error → `<ErrorMessage>`; helper text → `FieldDescription` / `text-xs text-muted-foreground`; success note → `text-xs text-success`.
- Entity lists (workspaces, secrets): rows as `flex items-center justify-between rounded-lg border border-border px-3 py-2.5`.
- Paths/URLs/tokens/commands render in `font-mono` (JetBrains Mono).

## Path helpers (`pathUtils.ts`)

POSIX-only helpers: `basenameOf`, `dirOf`, `toRelPath`, `toAbsPath`. The renderer always uses forward slashes regardless of OS (workspace paths come in this form from main, and we keep them that way for link parsing, sidebar drag-drop, etc.). **Do not import `node:path`** — it's unavailable behind contextIsolation.

## Renderer-only constants (`constants.ts`)

Re-exports cross-process constants (`APP_NAME`, `FILE_ACTIONS`, `FOLDER_ACTIONS`, `EDITOR_ACTIONS`, `SUPPORTED_PROVIDER_SLUGS`, `DEFAULT_PROVIDER_SLUG`) from `src/shared/constants.ts`. Renderer-only additions: `SETTINGS_SECTIONS`, `THEME_MODES`, `VIEW_MODES`, `SAVE_STATES`, `TREE_SORT_ORDERS`, `TREE_SORT_LABELS`.
