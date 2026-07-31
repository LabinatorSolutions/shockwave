// Types for the `window.api` bridge exposed by src/preload/preload.cjs.
//
// The preload is the ONLY mapping between renderer `window.api.foo` calls and
// main `ipcMain.handle('foo', ...)`. This file mirrors the JSDoc there so any
// .ts/.tsx renderer code gets compile-time checking of the IPC surface. Keep in
// sync with the preload: add a method there → add it here.

import type { FileAction, FolderAction, EditorAction } from './constants';
import type { Settings, WorkspaceData } from './settings';

/** A curated scope bundle for the connect form's second dropdown. */
export interface OAuthSetup {
  id: string;
  label: string;
  description?: string;
  scopes: string[];
}

/** A provider preset for the OAuth connect form (mirror of oauth.ts's ProviderPreset). */
export interface OAuthProviderPreset {
  id: string;
  label: string;
  authUrl?: string;
  tokenUrl?: string;
  defaultScopes: string[];
  pkce: boolean;
  authParams?: Record<string, string>;
  custom?: boolean;
  hint?: string;
  setups?: OAuthSetup[];
}

/** A node in the workspace file tree. Folders have `children`; files don't. */
export interface TreeNode {
  /** Absolute path on disk (also the React key). */
  id: string;
  /** Basename (e.g. "Foo.md" or "Notes"). */
  name: string;
  /** Modification time (ms since epoch). */
  mtime: number;
  /** Creation time (ms since epoch). */
  ctime: number;
  /** Present iff the node is a folder. */
  children?: TreeNode[];
}

/** A parsed wiki-link extracted from a markdown file. */
export interface ParsedLink {
  /** Lowercased basename (no extension, no folder). */
  target: string;
  alias?: string;
  heading?: string;
  startPos: number;
  endPos: number;
}

/** One markdown file with its parsed links + mtime, shipped at workspace load. */
export interface ParsedFile {
  path: string;
  mtime: number;
  outgoingLinks: ParsedLink[];
}

export interface FsAddOrChangeEvent {
  type: 'add' | 'change';
  path: string;
  mtime: number;
  // Present for `.md` files; absent for `.excalidraw` drawings (no wiki-links).
  outgoingLinks?: ParsedLink[];
}
export interface FsUnlinkEvent {
  type: 'unlink';
  path: string;
}
export interface FsRenameEvent {
  type: 'rename';
  oldPath: string;
  newPath: string;
  mtime: number;
  outgoingLinks: ParsedLink[];
}
export interface FsTreeEvent {
  type: 'tree';
}
/** Events shipped to the renderer over `fs:changed`, discriminated by `type`. */
export type FsChangedEvent = FsAddOrChangeEvent | FsUnlinkEvent | FsRenameEvent | FsTreeEvent;

/** An installed skill (skills.list()). */
export interface InstalledSkill {
  folderName: string;
  name: string;
  description: string;
  hasSkillMd?: boolean;
  /** 'builtin' = bundled with the app; 'workspace' = uploaded into the workspace. */
  source?: 'builtin' | 'workspace';
  /** Agent-secret names the skill declares (SKILL.md `required-secrets`). */
  requiredSecrets?: string[];
}

/** Detaches a listener. Always call on unmount. */
export type Unsubscribe = () => void;

export interface UpdateStatus {
  /** True when the latest GitHub release is newer than the running version. */
  updateAvailable: boolean;
  /** Latest release version (tag with leading "v" stripped), or null on error. */
  latest: string | null;
  /** Running app version (app.getVersion()). */
  current: string;
  /** Release page to open, or null on error. */
  url: string | null;
  /** Error message when the check failed (offline, rate-limited, …), else null. */
  error: string | null;
  /** True once electron-updater has the update downloaded and ready to install
   *  on restart. Always false in dev (notify-only fallback). */
  downloaded: boolean;
}

// Result of the two workspace setup flows. On success the row already exists
// and `id`/`path` are what the renderer needs to select and load it.
export interface WorkspaceSetupResult {
  ok: boolean;
  id?: string;
  path?: string;
  /** Present when the workspace was created or added; omitted by `setUpHere`,
   *  which only records a checkout for a workspace that already exists. */
  repoOwner?: string;
  repoName?: string;
  error?: string;
}

export interface SyncStatus {
  status: 'unconfigured' | 'idle' | 'syncing' | 'paused' | 'offline' | 'disabled' | string;
  detail: string;
  lastSyncAt: number | null;
  repoUrl?: string | null;
  /** Unmerged files (workspace-relative POSIX paths). Present on the paused status. */
  conflicts?: string[];
}

/** A saved chat (row of `chat_session`). */
export interface Chat {
  chatId: string;
  workspace: string;
  jsonlPath: string;
  title: string | null;
  systemPrompt: string | null;
  model: string | null;
  createdAt: number;
  updatedAt: number;
  archived: number;
  pinned: boolean;
  /** Cross-client execution flag: true while some machine runs this chat. */
  running?: boolean;
  /** Hostname of the machine currently running it (null when idle). */
  runningMachine?: string | null;
}

/** A stored chat message (row of `message`). Tool CALLS ride on the assistant
 *  row (`toolCalls` JSON); each tool RESULT is a `role:'tool'` row keyed by
 *  `toolCallId`. */
export interface ChatMessage {
  chatId: string;
  /** Ordering + read cursor, assigned by the server on append. NOT an identity. */
  seq: number;
  /** pi's own SessionEntry id — the row's identity. Null on pre-existing rows. */
  entryId: string | null;
  role: 'user' | 'assistant' | 'tool' | string;
  content: string | null;
  reasoning: string | null;
  toolCalls: string | null;
  toolCallId: string | null;
  toolName: string | null;
  createdAt: number;
}

/** A search result: the matching chat + a highlighted snippet. */
export interface ChatSearchHit {
  chatId: string;
  title: string | null;
  updatedAt: number;
  snippet: string;
}

export interface ShockwaveApi {
  // Dialogs
  openFolder(): Promise<string | null>;

  // Filesystem reads
  readTree(dirPath: string, opts?: { includeHidden?: boolean }): Promise<TreeNode[]>;
  readAllMarkdown(dirPath: string): Promise<ParsedFile[]>;
  /** Discard the persisted parse cache; the next readAllMarkdown re-parses every file. */
  rebuildLinkCache(dirPath: string): Promise<{ ok: boolean }>;
  readFile(filePath: string): Promise<string>;
  pathExists(p: string): Promise<boolean>;

  // Filesystem writes
  writeFile(filePath: string, content: string): Promise<number>;
  createFile(dirPath: string, name: string, content?: string): Promise<{ path: string; mtime: number }>;
  /** Literal file-browser rename — `toName` verbatim, no `.md` forcing; throws on collision. */
  renameFileLiteral(fromPath: string, toName: string): Promise<string>;
  duplicateFile(filePath: string): Promise<string>;
  writeImage(dirPath: string, bytes: ArrayBuffer | Uint8Array, ext: string, baseName: string): Promise<string>;
  trashFile(filePath: string): Promise<boolean>;
  trashFiles(filePaths: string[]): Promise<string[]>;
  trashFolder(folderPath: string): Promise<boolean>;

  // Folder ops
  createFolder(dirPath: string, name?: string): Promise<string>;
  ensureDir(dirPath: string): Promise<void>;
  renameFolder(fromPath: string, toName: string): Promise<string>;
  moveItem(srcPath: string, destDir: string): Promise<string>;
  importFiles(destDir: string | null, paths: string[]): Promise<{ imported: string[]; errors: string[] }>;

  // Shell
  revealInFolder(filePath: string): Promise<void>;
  openExternal(url: string): Promise<void>;

  // Native context menus
  showFileContextMenu(opts: { isMd?: boolean; isOpenable?: boolean; isBookmarked?: boolean; selectionCount?: number; conflictMode?: boolean }): Promise<FileAction | null>;
  showConflictCloudMenu(): Promise<'keep' | 'reset' | null>;
  showFolderContextMenu(opts?: { isRoot?: boolean }): Promise<FolderAction | null>;
  showEditorContextMenu(opts: { hasSelection?: boolean; hasFilePath?: boolean; hasLink?: boolean }): Promise<EditorAction | null>;

  // File watcher (push)
  watchStart(dirPath: string): Promise<void>;
  watchStop(): Promise<void>;
  onFsChanged(cb: (evt: FsChangedEvent) => void): Unsubscribe;

  bookmarks: {
    read(workspacePath: string): Promise<string[]>;
    write(workspacePath: string, paths: string[]): Promise<void>;
    /** Fires when the workspace file changes on disk (sync, another machine, hand edit). */
    onChanged(cb: () => void): Unsubscribe;
  };

  /** Per-workspace settings persisted to `<workspace>/.shockwave/workspace.json`. */
  workspaceSettings: {
    read(workspacePath: string): Promise<WorkspaceData>;
    update(workspacePath: string, patch: Partial<WorkspaceData>): Promise<WorkspaceData>;
  };

  settings: {
    read(): Promise<Settings>;
    /** Writes only the keys present in `obj`. Absent keys keep their stored value. */
    write(obj: Partial<Settings>): Promise<void>;
    /** Fires when MAIN writes settings on its own (OAuth tokens, window bounds,
     *  cron, auto-provisioned secret slots). Never fires for the renderer's own
     *  writes. Apply only the reported `keys`. Returns an unsubscribe fn. */
    onChanged(cb: (payload: { keys: string[]; settings: Settings }) => void): () => void;
    /** The API connection config (server URL + whether a key is stored). The key
     *  itself never leaves main. */
    /** `certFingerprint` is the approved companion certificate, shown so the user
     *  can compare it against `shockwave-fingerprint` on the server. Not a secret
     *  — it travels in the clear on every TLS handshake. Empty when the server has
     *  a publicly-trusted certificate, or nothing is approved yet. */
    apiRead(): Promise<{ url: string; hasApiKey: boolean; certFingerprint: string }>;
    /** Persist URL and/or key. Omit `apiKey` to keep the stored one. */
    apiWrite(patch: { url?: string; apiKey?: string }): Promise<{ ok: boolean; url: string; hasApiKey: boolean }>;
    /** Probe a URL + key (falls back to the stored key when omitted). Reports
     *  only — it can never approve a certificate.
     *  `version` is the companion's release tag ('v1.0.21', 'dev' for local builds).
     *  `certNeedsApproval` is set when the companion answered but the app held the
     *  connection because its certificate isn't the approved one; `approved: null`
     *  means nothing has ever been approved for this server. The server is
     *  reachable either way, so that is distinct from a plain failure. */
    apiTest(args: { url: string; apiKey?: string }): Promise<{
      ok: boolean;
      error?: string;
      version?: string;
      certNeedsApproval?: { host: string; approved: string | null; offered: string };
    }>;
    /** Compare the desktop version against the companion's. 'companion-older' is
     *  the only status that offers an upgrade; 'dev' (either side unversioned)
     *  stays silent. */
    apiCheckVersion(): Promise<{
      status: 'match' | 'companion-older' | 'companion-newer' | 'dev' | 'unreachable' | 'unconfigured';
      desktop?: string;
      companion?: string;
    }>;
    /** Ask the companion to upgrade itself to this desktop's version (POST /update
     *  -> the updater sidecar). `updater-unavailable` = pre-sidecar deployment;
     *  the user must re-run the install script once. Fire-and-forget: success
     *  means "request accepted"; completion arrives via onCompanionUpdated. */
    apiUpgradeCompanion(): Promise<{ ok: boolean; error?: string }>;
    /** Fires when an upgrade requested this session has landed — main sees the
     *  live feed reconnect with the matching version. Returns an unsubscribe fn. */
    onCompanionUpdated(cb: (payload: { version: string }) => void): () => void;
    /** Remove a stored credential by settings path (`sync.pat`,
     *  `transcription.apiKey`, `codingAgent.providerKeys.<slug>`).
     *
     *  Its own call because the renderer is never given credential VALUES, so an
     *  empty field can't mean "delete this" — every credential it holds reads as
     *  empty and is stripped from saves on purpose. Deleting is explicit. */
    deleteCredential(path: string): Promise<{ ok: boolean; error?: string }>;
    /** Whether the companion is reachable right now. Asked on load — the push
     *  below can fire before the window is listening. */
    companionState(): Promise<{ online: boolean }>;
    /** Fires when the companion becomes reachable, or stops being. Edge-triggered.
     *
     *  Becoming reachable is the ONE trigger that refreshes companion-owned data:
     *  main follows it with a `settings:changed` push carrying `workspaces`. Boot,
     *  reconnect after an upgrade restart, and Settings → Connect are all the same
     *  event, so none of them needs its own refresh. */
    onCompanionState(cb: (s: { online: boolean }) => void): () => void;
    /** Approve a companion certificate the user has been shown. The only path
     *  that stores one. Refuses any fingerprint main didn't itself read off the
     *  configured server — the value on screen is the only approvable value. */
    approveCert(fingerprint: string): Promise<{ ok: boolean; error?: string }>;
    /** Un-approve the stored companion certificate. */
    forgetCert(): Promise<{ ok: boolean }>;
    /** A certificate awaiting approval right now, or null. */
    pendingCert(): Promise<{ host: string; approved: string | null; offered: string } | null>;
    /** Fires once per distinct certificate the app held a connection on. */
    onCertNeedsApproval(
      cb: (c: { host: string; approved: string | null; offered: string }) => void,
    ): () => void;
    /** Telegram connection status (from the companion), including the workspace it runs against. */
    telegramStatus(): Promise<{ ok: boolean; connected?: boolean; botUsername?: string | null; activeChatId?: string | null; workspaceId?: string | null; workspaceName?: string | null; error?: string }>;
    /** Connect a Telegram bot — the companion validates the token + registers the webhook. */
    telegramConnect(opts: { botToken: string; authorizedTgUserId: number }): Promise<{ ok: boolean; botUsername?: string | null; webhookUrl?: string; error?: string }>;
    /** Disconnect Telegram (companion deletes the webhook + stored token). */
    telegramDisconnect(): Promise<{ ok: boolean; error?: string }>;
    /** Set the workspace Telegram runs against (starts a fresh chat, same as /workspace in the bot). */
    telegramSetWorkspace(workspaceId: string): Promise<{ ok: boolean; error?: string }>;
  };

  oauth: {
    listPresets(): Promise<OAuthProviderPreset[]>;
    /** Runs browser+loopback authorization for an oauth secret, persists tokens. */
    startConnect(name: string): Promise<{ ok: boolean; accountEmail?: string; error?: string }>;
    /** Clears live tokens (keeps client config so the user can re-connect). */
    disconnect(name: string): Promise<{ ok: boolean; error?: string }>;
  };

  theme: {
    getInitial(): Promise<{ dark: boolean }>;
    onSystemChange(cb: (payload: { dark: boolean }) => void): Unsubscribe;
  };

  skills: {
    list(workspacePath: string | null): Promise<{ builtin: InstalledSkill[]; workspace: InstalledSkill[] }>;
    libraryDir(workspacePath: string | null): Promise<string | null>;
    importPicker(workspacePath: string | null): Promise<string | null>;
    importFromPath(workspacePath: string | null, srcPath: string): Promise<string>;
    remove(workspacePath: string | null, folderName: string): Promise<void>;
    pathForFile(file: File): string;
  };

  agent: {
    /** Send to a chat. chatId is renderer-minted (UUID) for new chats.
     *  Mid-turn sends are steered into the running turn. */
    send(opts: { chatId: string; text: string; images?: Array<{ type: 'image'; source: unknown }> }): Promise<void>;
    abort(chatId: string): Promise<void>;
    /** Chats with a turn in flight (re-seed the running set after reload). */
    runningChats(): Promise<string[]>;
    listProviders(): Promise<Array<{ slug: string; label: string }>>;
    listModels(provider: string): Promise<Array<{ id: string; label: string }>>;
    listThinkingLevels(opts: { provider: string; model: string }): Promise<string[]>;
    /** Probe an openai-compatible `{baseUrl}/models`.
     *
     *  `apiKey` is what's typed in the box, which is normally empty — the renderer
     *  is never given key values. Pass `provider` so main can fall back to the
     *  stored key; without it, testing a saved endpoint runs unauthenticated and
     *  reports a 401 for a setup that works. */
    validateConnection(opts: { baseUrl: string; apiKey?: string; provider?: string }): Promise<{ ok: boolean; models?: string[]; error?: string }>;
    /** Every event is stamped with the chatId of the chat it belongs to. */
    onEvent(cb: (evt: unknown) => void): Unsubscribe;
    onError(cb: (payload: { chatId?: string; message: string }) => void): Unsubscribe;
    onOpenFile(cb: (payload: { path: string }) => void): Unsubscribe;
  };

  chat: {
    list(opts?: { limit?: number; before?: number }): Promise<Chat[]>;
    listPinned(): Promise<Chat[]>;
    setPinned(opts: { chatId: string; pinned: boolean }): Promise<void>;
    searchChats(opts: { query: string; limit?: number }): Promise<ChatSearchHit[]>;
    getMessages(chatId: string): Promise<ChatMessage[]>;
    /** The chat's row + its stored messages, plus this machine's local path for
     *  the chat's workspace (the row carries only the shared workspace id, and a
     *  chat discovered from the live feed has no other way to learn it). */
    open(chatId: string): Promise<{ chat?: Chat; messages: ChatMessage[]; workspacePath?: string | null }>;
    deleteChat(chatId: string): Promise<void>;
    rename(opts: { chatId: string; title: string }): Promise<void>;
    /** The live feed reconnected after a drop — re-read anything loaded, since
     *  events during the outage were missed. Returns an unsubscribe fn. */
    onFeedResync(cb: () => void): () => void;
  };

  voice: {
    getToken(): Promise<{ token?: string; error?: string }>;
  };

  app: {
    /** This machine's name (os.hostname) — distinguishes "running here" from "running elsewhere". */
    machineId(): Promise<string>;
    checkForUpdates(): Promise<UpdateStatus>;
    getUpdateStatus(): Promise<UpdateStatus | null>;
    onUpdateStatus(cb: (status: UpdateStatus) => void): Unsubscribe;
    restartToUpdate(): Promise<void>;
  };

  // A workspace IS a GitHub repo — both calls clone into a new folder and
  // insert the row in main. There is no way to register one from the renderer.
  workspace: {
    createWithRepo(opts: { workspacePath: string; repoName: string; name?: string; private?: boolean }): Promise<WorkspaceSetupResult>;
    addFromRepo(opts: { workspacePath: string; owner: string; repo: string; name?: string }): Promise<WorkspaceSetupResult>;
    inspectFolder(workspacePath: string): Promise<{ state: 'empty' | 'clone' | 'occupied'; repoOwner?: string; repoName?: string; defaultBranch?: string; error?: string }>;
    setUpHere(opts: { id: string; workspacePath: string }): Promise<WorkspaceSetupResult>;
    remove(opts: { id: string }): Promise<{ ok: boolean; error?: string }>;
    forgetLocal(opts: { id: string }): Promise<{ ok: boolean }>;
    /** The default file set (SOUL.md, AGENTS.md, .ignore, .gitignore) and which
     *  are absent from this checkout. */
    listFiles(opts: { workspacePath: string }): Promise<{ ok: boolean; files?: Array<{ name: string; purpose: string }>; missing?: string[]; error?: string }>;
    /** Write the defaults. Default fills only what's missing and can't destroy
     *  anything; `overwrite` replaces all of them. */
    ensureFiles(opts: { workspacePath: string; overwrite?: boolean }): Promise<{ ok: boolean; written?: string[]; error?: string }>;
  };

  sync: {
    verifyPat(pat: string): Promise<{ ok: boolean; login?: string; id?: number; name?: string | null; error?: string }>;
    checkGit(): Promise<{ ok: boolean; version?: string; error?: string; platform: NodeJS.Platform }>;
    listRepos(): Promise<{ ok: boolean; repos?: Array<{ full_name: string; clone_url: string; private: boolean; default_branch: string; pushed_at: string }>; error?: string }>;
    setWorkspaceDisabled(opts: { workspacePath: string; disabled: boolean }): Promise<{ ok: boolean; error?: string }>;
    engineStart(opts: { workspacePath: string; intervalSeconds?: number }): Promise<void>;
    engineStop(): Promise<void>;
    engineStatus(): Promise<SyncStatus>;
    listConflicts(workspacePath: string): Promise<string[]>;
    resolveConflict(workspacePath: string, relPath: string): Promise<string[]>;
    keepConflict(workspacePath: string, relPath: string): Promise<string[]>;
    resetConflict(workspacePath: string, relPath: string): Promise<string[]>;
    keepAll(workspacePath: string): Promise<string[]>;
    resetToRemote(workspacePath: string): Promise<void>;
    flushDone(token: number): Promise<void>;
    onFlushRequest(cb: (token: number) => void): Unsubscribe;
    onStatus(cb: (status: SyncStatus) => void): Unsubscribe;
  };
  cron: {
    /** Compose the schedule view: jobs from the local cron.json + run status from the companion. */
    read(): Promise<CronView>;
    /** Trigger a manual run on the companion. */
    runNow(name: string): Promise<{ ok?: boolean; chatId?: string; error?: string }>;
    onState(cb: (view: CronView) => void): Unsubscribe;
    onChatsChanged(cb: () => void): Unsubscribe;
  };
}

export interface CronJobView {
  name: string;
  schedule: string;
  description: string;
  enabled: boolean;
  invalid: string | null;
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastError: string | null;
  lastChatId: string | null;
}

export interface CronView {
  activeWorkspace: string | null;
  exists?: boolean;
  fileError: string | null;
  jobs: CronJobView[];
  inFlight: boolean;
  runningJobName: string | null;
}

declare global {
  interface Window {
    api: ShockwaveApi;
  }
}
