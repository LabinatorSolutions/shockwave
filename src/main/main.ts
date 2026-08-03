import { app, BrowserWindow, ipcMain, dialog, Menu, shell, nativeTheme, protocol, net, safeStorage, screen } from 'electron';
// CJS package with lazy getter exports — named ESM imports fail at runtime
// (cjs-module-lexer can't see them); destructure off the default instead.
import electronUpdater from 'electron-updater';
import updateLog from 'electron-log';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import * as parcelWatcher from '@parcel/watcher';
import { parseLinks } from './linkParser.js';
import { createRenameCorrelator } from './renameCorrelator.js';
import { createWatcherDispatch } from './watcherDispatch.js';
import { initDesktopAgent, agentSend, agentAbort, agentDisposeChat, agentDisposeAll, agentRunningChats, listThinkingLevels, sweepAgentScratch, removeAgentScratch } from './codingAgent.js';
// Cron execution lives entirely on the companion now; the desktop only VIEWS the
// schedule (from local cron.json + companion run-status) and triggers a manual run.
import { cronRead, cronRunNow } from './api/cron.js';
import { listChats, listPinned, pinnedChatIds, searchChats, getMessages, openChat as openChatApi, deleteChat, setChatTitle, setChatPinned, postEvent } from './api/chats.js';
import {
  getWorkspace, findWorkspaceByPath, findWorkspaceByRepo, isPathClaimed,
  createWorkspace, removeWorkspace, setUpHere as wsSetUpHere, forgetLocal as wsForgetLocal, setSyncEnabled, setWorkspaceVoiceReply,
} from './api/workspaces.js';
import { isMdFile, uniquePath, walkMarkdownPaths, isWatchIgnored, isTreeHidden } from './pathResolver.js';
import { ensureWorkspaceFiles, missingWorkspaceFiles, DEFAULT_FILES } from '../../agent-core/defaults/files.js';
// Static-catalog reads moved off the pi-ai root to `/compat` in pi-ai 0.80.0.
import { getProviders } from '@earendil-works/pi-ai/compat';
import { initModelCatalog, getCatalogModels } from '../../agent-core/modelCatalog.js';
import { listBuiltinSkills, listWorkspaceSkills, importSkillToWorkspace, removeWorkspaceSkill, workspaceSkillsDir } from '../../agent-core/skillLibrary.js';
import { installOpenFileBridge } from './openFileExtension.js';
import { initOAuth, startConnect as oauthStartConnect, disconnect as oauthDisconnect, PROVIDER_PRESETS } from './oauth.js';
import { ensureCliShims, prependPath } from './cliTools.js';
// Resolve git's absolute path BEFORE prependPath puts the agent-writable shim dir
// first on PATH. See the call site below and gitBinary.ts.
import { resolveGitBinary } from './gitBinary.js';
// Settings + secrets live in the `setting` table (see settingsStore.ts). The old
// `<userData>/settings.json` reader/writer and its per-field safeStorage
// encryption were replaced wholesale; the signatures here are unchanged, so
// every call site below (and in oauth.ts / cron.ts) is untouched.
import { readSettings, readSettingsSafe, readSettingsForRenderer, writeSettings, importLegacySettingsIfNeeded, notifyWorkspacesChanged, notifySettingsResync } from './settingsStore.js';
import { readApiConfig, writeApiConfig } from './api/config.js';
// The one declaration of which settings paths are credentials — shared with the
// companion and the renderer. Gates settings:deleteCredential.
import { isDeletableCredential } from '../../agent-core/credentials.js';
import {
  voiceConfigOf, voiceProvider, voiceLabel,
  listenProviderOf, listenKey, speakProviderOf, speakKey,
} from '../../agent-core/voiceProviders.js';
import {
  approveFingerprint, forgetFingerprint, approvedFingerprint,
  onCertNeedsApproval, readServerCert, getPendingCert, hostOf,
} from './api/net.js';
import os from 'node:os';
import { api } from './api/client.js';
import { classifyVersions } from './versionCompare.js';
import { readLocalSettings, patchLocalSettings } from './api/localSettings.js';
import {
  verifyPat as syncVerifyPat,
  checkGit as syncCheckGit,
  createWorkspaceRepo as syncCreateWorkspaceRepo,
  classifyFolder as syncClassifyFolder,
  ensureCheckout as syncEnsureCheckout,
  listRepos as syncListRepos,
} from './sync.js';
import {
  start as engineStart,
  stop as engineStop,
  userDisable as engineUserDisable,
  boundWorkspacePath as engineBoundPath,
  drainBeforeQuit as engineDrainBeforeQuit,
  handleFlushDone as engineHandleFlushDone,
  getCurrentStatus as engineGetCurrentStatus,
  getConflicts as engineGetConflicts,
  resolveConflict as engineResolveConflict,
  keepConflict as engineKeepConflict,
  resetConflict as engineResetConflict,
  keepAll as engineKeepAll,
  resetToRemote as engineResetToRemote,
} from './syncEngine.js';
import {
  APP_NAME,
  FILE_ACTIONS,
  FOLDER_ACTIONS,
  EDITOR_ACTIONS,
  SUPPORTED_PROVIDER_SLUGS as SUPPORTED_PROVIDER_SLUGS_LIST,
} from '../shared/constants';

const SUPPORTED_PROVIDER_SLUGS = new Set(SUPPORTED_PROVIDER_SLUGS_LIST);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.setName(APP_NAME);

// Dev runs against its OWN userData so a dev build and the installed app don't
// share api.json / local-settings.json / workspace-sync state. Must run before
// the single-instance lock (the lock lives in userData) and any getPath use.
if (!app.isPackaged) {
  app.setPath('userData', `${app.getPath('userData')}-dev`);
}

// One instance per userData. Without this, a second launch — or a dev build
// sitting next to the installed app on the SAME userData — collides on shared
// state: two file watchers, two live feeds, two sync engines racing the same
// files. The second instance quits; the first restores + focuses its window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [w] = BrowserWindow.getAllWindows();
    if (w) { if (w.isMinimized()) w.restore(); w.focus(); }
  });
}

// __dirname under electron-vite is `<project>/out/main/` in dev and inside the
// asar at runtime. Both layouts have `build/icon.png` two levels up.
const ICON_PATH = path.join(__dirname, '..', '..', 'build', 'icon.png');

// Pop up a native context menu and resolve with the value attached to the
// clicked item (or null on dismiss). Items in `template` use the standard
// Electron MenuItem shape, with one addition: `{ label, value }` items get a
// click handler synthesized for you that records the value. Built-in role
// items (`{ role: 'cut' }` etc.) and items with a custom `click` pass
// through unchanged.
function popupContextMenu(win, template) {
  return new Promise((resolve) => {
    let chosen: any = null;
    const items = template.map((item) => {
      if (item && typeof item === 'object' && 'value' in item && !item.click) {
        const { value, ...rest } = item;
        return { ...rest, click: () => { chosen = value; } };
      }
      return item;
    });
    const menu = Menu.buildFromTemplate(items);
    menu.on('menu-will-close', () => {
      setImmediate(() => resolve(chosen));
    });
    menu.popup({ window: win });
  });
}

// Bundled built-in skills. Shipped via electron-builder `extraResources` →
// process.resourcesPath/built-in-skills in production; read from the repo in dev.
function builtinSkillsDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'built-in-skills')
    : path.join(app.getAppPath(), 'resources', 'built-in-skills');
}

// Bundled CLI tools. Shipped via `files` + `asarUnpack` → app.asar.unpacked in
// production; read from the repo in dev.
function cliToolsDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'cli-tools')
    : path.join(app.getAppPath(), 'cli-tools');
}

// Auto-provision empty agent-secret slots for the secrets that enabled built-in
// skills declare (SKILL.md `required-secrets`). The user just pastes their key
// into the slot. Always re-adds a missing slot for an enabled built-in (so a
// deleted one returns), but never overwrites a value the user already filled —
// we only ADD names not already present. Disabling a built-in leaves its slot.
async function ensureBuiltinSecretSlots() {
  try {
    const settings = await readSettings();
    const installed = await listBuiltinSkills(builtinSkillsDir());
    const have = new Set((settings.agentSecrets ?? []).map((s) => s.name));
    const additions: any[] = [];
    const now = Date.now();
    // Built-in on/off is per-workspace now, but agent secrets are global — so we
    // provision a slot for every built-in's required secret regardless of any
    // single workspace's toggle (we only ADD missing names, never overwrite).
    for (const sk of installed) {
      for (const name of (sk.requiredSecrets ?? [])) {
        if (have.has(name) || additions.some((a) => a.name === name)) continue;
        additions.push({ name, description: `Used by the ${sk.name} skill`, token: '', createdAt: now, updatedAt: now });
      }
    }
    if (additions.length) {
      await writeSettings({ agentSecrets: [...(settings.agentSecrets ?? []), ...additions] });
    }
  } catch (err: any) {
    console.warn('[secrets] built-in slot provisioning failed:', err?.message ?? err);
  }
}

// electron-vite sets ELECTRON_RENDERER_URL in dev. In production the renderer
// is loaded from the built out/renderer/ directory.
const DEV_URL = process.env.ELECTRON_RENDERER_URL;

// Custom `app://` scheme used to serve workspace files (images) to the
// renderer with webSecurity intact. Must be registered before app.ready.
// Renderer requests `app://media/<rel-path-from-vault>`; the handler resolves
// the file against the active vault root (watcherRootDir) and returns it
// via net.fetch(file://…). Path-traversal outside the vault is rejected.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

const DEFAULT_WINDOW_SIZE = { width: 1200, height: 800 };

// True if `bounds` overlaps the work area of any currently-connected display.
// We accept partial overlap (so a window mostly off-screen still restores) —
// the OS clamps it on show. Returns false for nullish/zero-size rects too.
function boundsAreVisible(bounds) {
  if (!bounds) return false;
  const { x, y, width, height } = bounds;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  if (!(width > 100) || !(height > 100)) return false;
  for (const d of screen.getAllDisplays()) {
    const w = d.workArea;
    const intersects =
      x < w.x + w.width &&
      x + width > w.x &&
      y < w.y + w.height &&
      y + height > w.y;
    if (intersects) return true;
  }
  return false;
}

// Debounced + close-flushed persistence for window bounds. Captures the
// last-known *unmaximized* bounds (so restoring after a maximized session
// brings the window back to the size the user was actually using before
// maximizing).
function attachWindowBoundsPersistence(win) {
  let normalBounds = win.getBounds();
  let timer: any = null;

  const save = () => {
    if (win.isDestroyed()) return;
    const maximized = win.isMaximized();
    const bounds = maximized ? normalBounds : win.getBounds();
    if (!maximized) normalBounds = bounds;
    // `notify: false`, and it matters more than it looks. This fires on a 400ms
    // debounce for the whole of a window drag, and every settings push now carries
    // a FULL snapshot — so notifying here would re-seed the renderer several times
    // a second while you resize. The renderer has no use for the value either: it
    // is in MAIN_OWNED_KEYS precisely so nothing over there can author it, and
    // nothing renders it. It was only ever free because the old key-list handler
    // had no branch for it.
    writeSettings({ windowBounds: { ...bounds, maximized } }, { notify: false }).catch((err) => {
      console.warn('[settings] failed to persist window bounds:', err.message);
    });
  };

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(save, 400);
  };

  const onChange = () => {
    if (!win.isMaximized() && !win.isFullScreen()) {
      normalBounds = win.getBounds();
    }
    schedule();
  };

  win.on('resize', onChange);
  win.on('move', onChange);
  win.on('maximize', schedule);
  win.on('unmaximize', schedule);
  win.on('close', () => {
    if (timer) { clearTimeout(timer); timer = null; }
    save();
  });
}

async function createWindow() {
  // windowBounds is machine-local (userData) — read it the safe way so a down
  // server can never keep the window from opening.
  const { settings } = await readSettingsSafe();
  const saved = settings.windowBounds;
  const useSaved = saved && boundsAreVisible(saved);
  const opts: any = {
    ...DEFAULT_WINDOW_SIZE,
    title: APP_NAME,
    icon: ICON_PATH,
    // macOS: deliver the click that reactivates a background window straight to
    // the web content, so clicking a file in the sidebar when the app isn't
    // frontmost opens it in one click instead of two (first to activate, second
    // to act). No-op on Windows/Linux.
    acceptsFirstMouse: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  };
  if (useSaved) {
    opts.x = saved.x;
    opts.y = saved.y;
    opts.width = saved.width;
    opts.height = saved.height;
  }
  const win = new BrowserWindow(opts);

  if (useSaved && saved.maximized) win.maximize();

  attachWindowBoundsPersistence(win);

  // Navigation hard-block. The renderer is a single page that should NEVER
  // navigate away — if it does, the app blanks and the user has no way back.
  // This kicks in for: a stray <a href="https://…"> click anywhere in the UI
  // that the renderer didn't intercept (e.g. markdown links in chat that
  // weren't routed through openExternal), location.href changes, form
  // submits, etc. http/https URLs are routed to the system browser;
  // anything else is silently blocked.
  win.webContents.on('will-navigate', (event, url) => {
    // Allow the very first load (DEV_URL or file://…) — will-navigate also
    // fires for the initial loadURL/loadFile on some Electron versions.
    if (url === win.webContents.getURL()) return;
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  if (DEV_URL) {
    win.loadURL(DEV_URL);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  }
}

ipcMain.handle('dialog:openFolder', async () => {
  // `createDirectory` (macOS) adds a "New Folder" button to the open dialog so
  // users can create a fresh workspace directory in one step.
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// Seed SOUL.md (agent identity) + an empty AGENTS.md into a workspace on
// creation, so a new workspace has them from the start — not only when a repo
// is created via GitHub sync. Idempotent: writes only files that don't exist,
// best-effort (never throws).
// `includeHidden` is the "Show hidden files" toggle above the tree. It changes
// what the SIDEBAR shows and nothing else — the watcher, the link index, and
// wiki-link resolution all keep their own rule (isWatchIgnored) whatever this
// says. When on, everything on disk is returned: dotfiles, .git, node_modules.
// That costs a walk of whatever's there (a large node_modules is ~1s), which is
// why it's off by default and not simply always-on.
async function buildTree(dirPath, includeHidden = false) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const children = await Promise.all(
    entries
      .filter((e) => includeHidden || !isTreeHidden(e.name))
      .map(async (e) => {
        const fullPath = path.join(dirPath, e.name);
        if (e.isDirectory()) {
          return {
            id: fullPath,
            name: e.name,
            children: await buildTree(fullPath, includeHidden),
          };
        }
        // Stat each file so the renderer can sort by modified/created time.
        // birthtimeMs is the file's true creation time on macOS/Windows; on
        // Linux it may equal mtime depending on the fs.
        let mtime = 0;
        let ctime = 0;
        try {
          const st = await fs.stat(fullPath);
          mtime = st.mtimeMs;
          ctime = st.birthtimeMs || st.ctimeMs;
        } catch {
          // Race with concurrent rm/move — leave as 0; node still appears in the tree.
        }
        return { id: fullPath, name: e.name, mtime, ctime };
      })
  );
  // Default order — folders first, names A→Z. Renderer re-sorts files per the
  // user's chosen sort order; folders stay in this base order.
  children.sort((a, b) => {
    const aDir = !!a.children;
    const bDir = !!b.children;
    if (aDir !== bDir) return aDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return children;
}

ipcMain.handle('fs:readTree', async (_evt, dirPath, opts) => {
  return buildTree(dirPath, !!opts?.includeHidden);
});

// --- Persisted parse cache (Obsidian-style metadata cache) -----------------
// Stores each .md file's parsed wiki-links keyed by path, validated by mtime +
// size, so a cold start re-parses only the files that changed while the app was
// closed. Kept under userData (per-machine, NOT in the workspace) so it never
// syncs — mtimes differ per machine and would churn git.
//
// Full rebuild-from-scratch happens when: (a) LINK_CACHE_VERSION doesn't match
// the on-disk cache — bump it whenever parseLinks' output shape changes so a
// cache written by an older build is discarded rather than trusted; (b) the
// cache file is missing/corrupt; (c) the user triggers `fs:rebuildLinkCache`.
// Per-file re-parse happens when a file's mtime OR size differs from the cache
// (size guards against edits that preserve mtime).
const LINK_CACHE_VERSION = 1;   // bump when parseLinks' output shape changes (e.g. added targetParsed)

function linkCachePath(dirPath) {
  const key = crypto.createHash('sha1').update(dirPath).digest('hex');
  return path.join(app.getPath('userData'), 'link-cache', `${key}.json`);
}

async function loadLinkCache(dirPath) {
  try {
    const raw = await fs.readFile(linkCachePath(dirPath), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && parsed.version === LINK_CACHE_VERSION && parsed.entries) return parsed.entries;
  } catch { /* missing / corrupt / version mismatch → cold parse */ }
  return {};
}

async function saveLinkCache(dirPath, entries) {
  try {
    const file = linkCachePath(dirPath);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ version: LINK_CACHE_VERSION, entries }), 'utf8');
    await fs.rename(tmp, file);
  } catch { /* cache persistence is best-effort — never block a load */ }
}

async function readAllMarkdown(dirPath) {
  const cache = await loadLinkCache(dirPath);
  const paths = await walkMarkdownPaths(dirPath);
  const out: any[] = [];
  const nextEntries: Record<string, any> = {};
  let hits = 0, misses = 0;
  for (const full of paths) {
    let stat;
    try { stat = await fs.stat(full); } catch { continue; }
    const cached = cache[full];
    if (cached && cached.mtime === stat.mtimeMs && cached.size === stat.size) {
      // Unchanged since last load → reuse the cached parse, skip read + parse.
      out.push({ path: full, mtime: stat.mtimeMs, outgoingLinks: cached.outgoingLinks });
      nextEntries[full] = cached;
      hits++;
      continue;
    }
    try {
      const content = await fs.readFile(full, 'utf8');
      const links = parseLinks(content);
      out.push({ path: full, mtime: stat.mtimeMs, outgoingLinks: links });
      nextEntries[full] = { mtime: stat.mtimeMs, size: stat.size, outgoingLinks: links };
      misses++;
    } catch {
      // swallow per-file errors so one bad file doesn't kill the vault load
    }
  }
  // Rebuild the cache from the current file set (drops entries for deleted files).
  await saveLinkCache(dirPath, nextEntries);
  if (misses > 0 || hits > 0) console.log(`[link-cache] ${hits} hits, ${misses} reparsed (${paths.length} files)`);
  return out;
}

ipcMain.handle('fs:readAllMarkdown', async (_evt, dirPath) => {
  return readAllMarkdown(dirPath);
});

// Escape hatch: discard the persisted cache so the next load re-parses fully.
ipcMain.handle('fs:rebuildLinkCache', async (_evt, dirPath) => {
  try { await fs.rm(linkCachePath(dirPath), { force: true }); } catch { /* ignore */ }
  return { ok: true };
});

ipcMain.handle('fs:readFile', async (_evt, filePath) => {
  return fs.readFile(filePath, 'utf8');
});

ipcMain.handle('fs:writeFile', async (_evt, { filePath, content }) => {
  await fs.writeFile(filePath, content, 'utf8');
  // Return the file's real mtime so the renderer's self-echo guard can compare
  // apples-to-apples against the watcher event's stat.mtimeMs. Using Date.now()
  // in the renderer drops fractional ms, which can cause a same-ms write to
  // look "fresh" to the guard.
  const st = await fs.stat(filePath);
  return st.mtimeMs;
});

// File identity helpers used by the rename correlator. Hash is computed
// eagerly so we still have an identity when the watcher reports a delete (the
// file is gone, so we can't read it then).
async function statInoOf(p) {
  try {
    const st = await fs.stat(p, { bigint: true });
    return st.ino.toString();
  } catch {
    return null;
  }
}

async function hashFileOf(p) {
  try {
    const buf = await fs.readFile(p);
    return crypto.createHash('sha1').update(buf).digest('hex');
  } catch {
    return null;
  }
}

ipcMain.handle('fs:createFile', async (_evt, { dirPath, name, content = '' }) => {
  // Default new files to .md; honor an explicit extension in `name` (e.g.
  // "Notes.txt"). Internal callers (wiki-link target, daily note) pass an
  // explicit ".md"; a user-typed draft title may carry any extension or none.
  const dot = name.lastIndexOf('.');
  const hasExt = dot > 0 && dot < name.length - 1;   // not a leading/trailing dot
  const base = hasExt ? name.slice(0, dot) : name.replace(/\.$/, '');
  const ext = hasExt ? name.slice(dot) : '.md';
  // Same-folder uniqueness only. Duplicate basenames across different folders
  // are allowed now (the link resolver disambiguates by path); the filesystem
  // still forbids two identical names in one folder.
  const target = await uniquePath(dirPath, base, ext);
  await fs.writeFile(target, content, 'utf8');
  const st = await fs.stat(target);
  return { path: target, mtime: st.mtimeMs };
});

// Literal rename (file-browser + title bar): the new name is used verbatim — no
// `.md` stripping or forcing. A name ending in `.md` stays markdown; anything
// else is a plain file. Rejects (throws) on a same-folder collision; duplicate
// basenames across different folders are allowed. The renderer blocks collisions
// live; this is the backstop.
ipcMain.handle('fs:renameFileLiteral', async (_evt, { fromPath, toName }) => {
  const dir = path.dirname(fromPath);
  const name = (toName ?? '').trim();
  if (!name) throw new Error('Name cannot be empty');
  if (name.includes('/') || name.includes('\\')) throw new Error('Name cannot contain a path separator');
  const target = path.join(dir, name);
  if (target === fromPath) return fromPath;
  // Same-folder collision only, for any extension. Duplicate basenames across
  // different folders are allowed; the filesystem forbids two identical names
  // in one folder.
  let exists = true;
  try { await fs.access(target); } catch { exists = false; }
  if (exists) throw new Error(`"${name}" already exists in this folder.`);
  await fs.rename(fromPath, target);
  return target;
});

ipcMain.handle('fs:duplicateFile', async (_evt, filePath) => {
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  const target = await uniquePath(dir, base, ext);
  const content = await fs.readFile(filePath);
  await fs.writeFile(target, content);
  return target;
});

// Confirmation lives in the renderer (ConfirmDialog), same as bulk delete —
// these just move the item to the Trash. Return true so existing callers that
// gate cleanup on the result keep working.
ipcMain.handle('fs:trashFolder', async (_evt, folderPath) => {
  await shell.trashItem(folderPath);
  return true;
});

ipcMain.handle('fs:trashFile', async (_evt, filePath) => {
  await shell.trashItem(filePath);
  return true;
});

// Bulk trash. The renderer is responsible for confirming with the user before
// calling this — no per-file system dialog. Returns the paths that were
// successfully trashed; failures are logged but don't abort the rest so a
// partial success still cleans up what it can.
ipcMain.handle('fs:trashFiles', async (_evt, filePaths) => {
  if (!Array.isArray(filePaths)) return [];
  const trashed: any[] = [];
  for (const p of filePaths) {
    try {
      await shell.trashItem(p);
      trashed.push(p);
    } catch (err: any) {
      console.warn('[trashFiles] failed:', p, err);
    }
  }
  return trashed;
});

ipcMain.handle('shell:revealInFolder', async (_evt, filePath) => {
  shell.showItemInFolder(filePath);
});

ipcMain.handle('shell:openExternal', async (_evt, url) => {
  // Only allow http/https — never let an arbitrary string become a shell launch.
  if (typeof url !== 'string') return;
  if (!/^https?:\/\//i.test(url)) return;
  await shell.openExternal(url);
});

function revealLabel() {
  if (process.platform === 'darwin') return 'Reveal in Finder';
  if (process.platform === 'win32') return 'Show in Explorer';
  return 'Show in file manager';
}

ipcMain.handle('context:fileMenu', async (evt, opts = {}) => {
  const win = BrowserWindow.fromWebContents(evt.sender);
  const { isMd = true, isOpenable = isMd, isBookmarked = false, selectionCount = 1, conflictMode = false } = opts;
  // Conflict view, per file: accept as-edited, keep ours, or take remote.
  if (conflictMode) {
    return popupContextMenu(win, [
      { label: 'Conflict resolved', value: FILE_ACTIONS.RESOLVE },
      { label: 'Keep our file', value: FILE_ACTIONS.KEEP },
      { label: 'Reset to remote', value: FILE_ACTIONS.RESET },
    ]);
  }
  const multi = selectionCount > 1;
  const template: any[] = [];
  if (multi) {
    // Bulk-safe actions only: open all in new tabs (if openable), bookmark
    // toggle, delete. Rename/Duplicate/Reveal don't make sense across a
    // selection. Bookmark is .md-only (keyed by basename via the link index).
    if (isOpenable) template.push({ label: `Open ${selectionCount} files in new tabs`, value: FILE_ACTIONS.NEW_TAB });
    if (isMd) template.push(
      { label: isBookmarked ? `Remove ${selectionCount} bookmarks` : `Bookmark ${selectionCount} files`, value: FILE_ACTIONS.TOGGLE_BOOKMARK },
      { type: 'separator' },
    );
    template.push({ label: `Delete ${selectionCount} files`, value: FILE_ACTIONS.DELETE });
  } else {
    if (isOpenable) template.push({ label: 'Open in new tab', value: FILE_ACTIONS.NEW_TAB });
    template.push({ label: 'Duplicate', value: FILE_ACTIONS.DUPLICATE });
    // Bookmark is .md-only.
    if (isMd) template.push(
      { type: 'separator' },
      { label: isBookmarked ? 'Remove bookmark' : 'Bookmark', value: FILE_ACTIONS.TOGGLE_BOOKMARK },
    );
    template.push(
      { type: 'separator' },
      { label: revealLabel(), value: FILE_ACTIONS.REVEAL },
      { type: 'separator' },
      { label: 'Rename', value: FILE_ACTIONS.RENAME },
      { label: 'Delete', value: FILE_ACTIONS.DELETE },
    );
  }
  return popupContextMenu(win, template);
});

// Right-click on the sync-conflict cloud icon: whole-tree resolution.
ipcMain.handle('context:conflictCloudMenu', async (evt) => {
  const win = BrowserWindow.fromWebContents(evt.sender);
  return popupContextMenu(win, [
    { label: 'Keep entire tree (take ours)', value: 'keep' },
    { label: 'Reset entire tree (take remote)', value: 'reset' },
  ]);
});

ipcMain.handle('context:folderMenu', async (evt, opts = {}) => {
  const win = BrowserWindow.fromWebContents(evt.sender);
  const { isRoot = false } = opts;
  const template: any[] = [
    { label: 'New file', value: FOLDER_ACTIONS.NEW_FILE },
    { label: 'New folder', value: FOLDER_ACTIONS.NEW_FOLDER },
    { type: 'separator' },
    { label: revealLabel(), value: FOLDER_ACTIONS.REVEAL },
  ];
  if (!isRoot) {
    template.push(
      { type: 'separator' },
      { label: 'Rename', value: FOLDER_ACTIONS.RENAME },
      { label: 'Delete', value: FOLDER_ACTIONS.DELETE },
    );
  }
  return popupContextMenu(win, template);
});

ipcMain.handle('fs:createFolder', async (_evt, { dirPath, name = 'New folder' }) => {
  let candidate = path.join(dirPath, name);
  let i = 1;
  while (true) {
    try {
      await fs.access(candidate);
      candidate = path.join(dirPath, `${name} ${i}`);
      i++;
    } catch {
      break;
    }
  }
  await fs.mkdir(candidate, { recursive: true });
  return candidate;
});

// Recursive mkdir for an absolute path. Unlike fs:createFolder it does NOT
// auto-disambiguate — the caller wants this exact path. Idempotent. Used by
// the daily-note flow when the format contains "/" (e.g. "YYYY/MM/DD") so
// intermediate year/month folders get created in place.
ipcMain.handle('fs:ensureDir', async (_evt, dirPath) => {
  await fs.mkdir(dirPath, { recursive: true });
  return dirPath;
});

// ─── Per-workspace settings (.shockwave/workspace.json) ──────────────────────
// One file per workspace holding everything workspace-scoped: bookmarks, daily-
// note config, templates config, and built-in skill toggles. It lives under the
// `.shockwave/` dotfile segment the watcher ignores, so our writes don't echo
// back as fs:changed events. `bookmarks` are `.md` basenames (no folder, no
// extension); the rest mirror the shapes the renderer uses.
function workspaceFilePath(workspacePath) {
  return path.join(workspacePath, '.shockwave', 'workspace.json');
}
function legacyBookmarksPath(workspacePath) {
  return path.join(workspacePath, '.shockwave', 'bookmarks.json');
}

function workspaceDefaults() {
  return {
    schemaVersion: 1,
    bookmarks: [] as string[],
    dailyNote: { format: 'YYYY-MM-DD', folder: '', templatePath: '' },
    templates: { folder: '' },
    // Built-in skill folderName → 'enabled' | 'disabled'. Absent ⇒ enabled.
    builtinSkills: {},
  };
}

function normalizeWorkspaceData(raw) {
  const d = workspaceDefaults();
  if (raw && typeof raw === 'object') {
    if (Array.isArray(raw.bookmarks)) {
      d.bookmarks = Array.from(new Set(raw.bookmarks.filter((n) => typeof n === 'string' && n.length > 0)));
    }
    if (raw.dailyNote && typeof raw.dailyNote === 'object') {
      d.dailyNote = {
        format: raw.dailyNote.format || d.dailyNote.format,
        folder: raw.dailyNote.folder ?? '',
        templatePath: raw.dailyNote.templatePath ?? '',
      };
    }
    if (raw.templates && typeof raw.templates === 'object') {
      d.templates = { folder: raw.templates.folder ?? '' };
    }
    if (raw.builtinSkills && typeof raw.builtinSkills === 'object') {
      d.builtinSkills = { ...raw.builtinSkills };
    }
  }
  return d;
}

// Serialize all reads/writes of a given workspace file so a bookmarks write and
// a settings update (both read-modify-write the same JSON) can't clobber each
// other. One promise chain per workspace path.
const workspaceFileQueues = new Map();
function queueWorkspaceFile(workspacePath, fn) {
  const prev = workspaceFileQueues.get(workspacePath) || Promise.resolve();
  const next = prev.then(fn, fn);
  workspaceFileQueues.set(workspacePath, next.then(() => {}, () => {}));
  return next;
}

async function writeWorkspaceFileRaw(workspacePath, data) {
  const file = workspaceFilePath(workspacePath);
  const tmp = `${file}.tmp`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(tmp, file);
}

async function readWorkspaceFileRaw(workspacePath) {
  try {
    const raw = await fs.readFile(workspaceFilePath(workspacePath), 'utf8');
    return normalizeWorkspaceData(JSON.parse(raw));
  } catch {
    // No unified file yet — migrate a legacy bookmarks.json into it if present,
    // then remove the legacy file. Otherwise return defaults.
    try {
      const raw = await fs.readFile(legacyBookmarksPath(workspacePath), 'utf8');
      const parsed = JSON.parse(raw);
      const data = normalizeWorkspaceData({ bookmarks: Array.isArray(parsed?.names) ? parsed.names : [] });
      await writeWorkspaceFileRaw(workspacePath, data);
      await fs.rm(legacyBookmarksPath(workspacePath), { force: true });
      return data;
    } catch {
      return workspaceDefaults();
    }
  }
}

ipcMain.handle('workspaceSettings:read', async (_evt, workspacePath) => {
  if (!workspacePath) return workspaceDefaults();
  return queueWorkspaceFile(workspacePath, () => readWorkspaceFileRaw(workspacePath));
});

// Merge `patch` (a partial of the workspace data) into the current file and
// write the whole thing back. Returns the merged object.
ipcMain.handle('workspaceSettings:update', async (_evt, { workspacePath, patch }) => {
  if (!workspacePath) return workspaceDefaults();
  return queueWorkspaceFile(workspacePath, async () => {
    const cur = await readWorkspaceFileRaw(workspacePath);
    const next = normalizeWorkspaceData({ ...cur, ...(patch || {}) });
    await writeWorkspaceFileRaw(workspacePath, next);
    return next;
  });
});

// Bookmarks live in the `bookmarks` array of the unified file. These thin
// handlers keep the renderer's existing bookmarks API working.
ipcMain.handle('bookmarks:read', async (_evt, workspacePath) => {
  if (!workspacePath) return [];
  const data = await queueWorkspaceFile(workspacePath, () => readWorkspaceFileRaw(workspacePath));
  return Array.from(new Set(data.bookmarks));
});

ipcMain.handle('bookmarks:write', async (_evt, { workspacePath, paths: names }) => {
  if (!workspacePath) return;
  await queueWorkspaceFile(workspacePath, async () => {
    const cur = await readWorkspaceFileRaw(workspacePath);
    cur.bookmarks = Array.isArray(names) ? Array.from(new Set(names.filter((n) => typeof n === 'string' && n.length > 0))) : [];
    await writeWorkspaceFileRaw(workspacePath, cur);
  });
});

ipcMain.handle('fs:moveItem', async (_evt, { srcPath, destDir }) => {
  const name = path.basename(srcPath);
  // Reject moving a folder into itself or its own descendant.
  if (path.join(destDir, name).startsWith(srcPath + path.sep) || destDir === srcPath) {
    throw new Error('Cannot move a folder into itself.');
  }
  const isMd = isMdFile(name);
  let stat;
  try { stat = await fs.stat(srcPath); } catch { stat = null; }
  const isFolder = stat?.isDirectory();

  let target;
  if (isMd && !isFolder) {
    // .md file move: same-folder uniqueness only. Duplicate basenames in
    // different folders are allowed (the resolver disambiguates by path).
    const base = name.slice(0, -3);
    target = await uniquePath(destDir, base, '.md');
  } else {
    // Folder or non-.md file: same-dir uniqueness on the item's own name. A
    // folder's nested .md files may now share basenames with files elsewhere —
    // that's fine, so there's no cross-folder collision check anymore.
    target = path.join(destDir, name);
    let candidate = target;
    let i = 1;
    while (true) {
      try { await fs.access(candidate); candidate = path.join(destDir, `${name} ${i}`); i++; }
      catch { break; }
    }
    target = candidate;
  }

  if (target === srcPath) return target;
  await fs.rename(srcPath, target);
  return target;
});

// Import files/folders dragged in from the OS (Finder → file tree). COPY
// semantics — sources are never modified or removed. Folders copy recursively.
// Same-dir uniqueness via " 1", " 2" suffixes (no workspace-wide .md check:
// duplicate basenames across folders are allowed). Per-source failures are
// collected rather than aborting the batch.
ipcMain.handle('fs:importFiles', async (_evt, { destDir, paths }) => {
  if (!watcherRootDir) throw new Error('No workspace open.');
  const root = path.resolve(watcherRootDir);
  const dest = path.resolve(destDir || root);
  if (dest !== root && !dest.startsWith(root + path.sep)) {
    throw new Error('Destination is outside the workspace.');
  }
  const imported: string[] = [];
  const errors: string[] = [];
  for (const src of Array.isArray(paths) ? paths : []) {
    try {
      const srcAbs = path.resolve(src);
      const stat = await fs.stat(srcAbs);
      if (stat.isDirectory() && (dest === srcAbs || dest.startsWith(srcAbs + path.sep))) {
        throw new Error('Cannot copy a folder into itself.');
      }
      const name = path.basename(srcAbs);
      const ext = stat.isDirectory() ? '' : path.extname(name);
      const target = await uniquePath(dest, ext ? name.slice(0, -ext.length) : name, ext);
      await fs.cp(srcAbs, target, { recursive: true, errorOnExist: true, force: false });
      imported.push(target);
    } catch (e: any) {
      errors.push(`${path.basename(src)}: ${e.message}`);
    }
  }
  return { imported, errors };
});

ipcMain.handle('fs:renameFolder', async (_evt, { fromPath, toName }) => {
  const dir = path.dirname(fromPath);
  const finalName = toName.trim();
  if (!finalName) throw new Error('Name cannot be empty');
  // Folders don't share the link-index basename space, so same-dir uniqueness is sufficient.
  let candidate = path.join(dir, finalName);
  if (candidate === fromPath) return candidate;
  let i = 1;
  while (true) {
    try { await fs.access(candidate); candidate = path.join(dir, `${finalName} ${i}`); i++; }
    catch { break; }
  }
  await fs.rename(fromPath, candidate);
  return candidate;
});

ipcMain.handle('context:editorMenu', async (evt, { hasSelection, hasFilePath, hasLink } = {}) => {
  const win = BrowserWindow.fromWebContents(evt.sender);
  const template: any[] = [];
  if (hasSelection) {
    template.push(
      { label: 'Add link',          value: EDITOR_ACTIONS.ADD_LINK },
      { label: 'Add external link', value: EDITOR_ACTIONS.ADD_EXTERNAL_LINK },
      { type: 'separator' },
    );
  }
  if (hasLink) {
    template.push(
      { label: 'Edit external link',   value: EDITOR_ACTIONS.EDIT_EXTERNAL_LINK },
      { label: 'Remove external link', value: EDITOR_ACTIONS.REMOVE_EXTERNAL_LINK },
      { type: 'separator' },
    );
  }
  if (hasFilePath) {
    template.push(
      { label: 'Message Agent', value: EDITOR_ACTIONS.SEND_TO_AGENT },
      { type: 'separator' },
    );
  }
  template.push(
    { role: 'cut',   enabled: hasSelection },
    { role: 'copy',  enabled: hasSelection },
    { role: 'paste' },
    { type: 'separator' },
    { role: 'selectAll' },
  );
  return popupContextMenu(win, template);
});

ipcMain.handle('settings:read', async () => {
  // Boot-safe: an unconfigured/offline server yields defaults (+ machine-local)
  // rather than throwing, so the app still boots and can show a connect prompt.
  //
  // Credentials are stripped here — this and the `settings:changed` push are the
  // only two doors to the renderer. It gets `hasProviderKey` / `hasApiKey` /
  // `hasPat` / `hasToken` instead of values.
  const { settings } = await readSettingsForRenderer();
  return settings;
});

ipcMain.handle('settings:write', async (_evt, obj) => {
  // notify:false — the renderer authored this write and already has the values.
  await writeSettings(obj, { notify: false });
});

// Remove a stored credential. Its own channel because an empty value can no
// longer carry the intent: the renderer never receives credential values, so
// everything it holds reads as empty, and `dropEmptyCredentials` strips them all
// to stop an unrelated save wiping your keys. That left no way to remove one —
// clearing the box did nothing and the old value stayed on the companion, so a
// leaked key couldn't be revoked from the app.
//
// Deleting a credential should be an explicit act anyway, which is what this is.
// The path is checked against the one credential declaration (agent-core), so
// this can't be pointed at an arbitrary settings key.
ipcMain.handle('settings:deleteCredential', async (_evt, { path: credPath }) => {
  if (!isDeletableCredential(credPath)) return { ok: false, error: 'Not a credential.' };
  // Empty string = delete on the companion (putSecret drops the row).
  await writeSettings({ [credPath]: '' }, { notify: true });
  return { ok: true };
});

// ── API connection config (URL + key) ───────────────────────────────────────
ipcMain.handle('api:read', () => {
  const c = readApiConfig();
  // The fingerprint is NOT a secret — it's sent in the clear on every TLS
  // handshake — and showing it is the only way the user can check the app against
  // what `shockwave-fingerprint` prints on the server.
  return { url: c.url, hasApiKey: !!c.apiKey, certFingerprint: c.certFingerprint };
});
ipcMain.handle('api:write', (_evt, patch) => {
  const next: any = {};
  if (typeof patch?.url === 'string') next.url = patch.url;
  if (typeof patch?.apiKey === 'string') next.apiKey = patch.apiKey;
  const c = writeApiConfig(next);
  // Point the live feed at whatever was just configured. Connecting doesn't get
  // its own "now refresh the workspaces" line — it re-establishes the feed, and
  // the feed opening is the ONE rule that refreshes (see setCompanionOnline).
  // It also makes connecting immediate: the retry loop backs off to 30s, so
  // without this a freshly-entered URL could sit unread for half a minute.
  stopLiveFeed();
  setCompanionOnline(false);
  startLiveFeed();
  return { ok: true, url: c.url, hasApiKey: !!c.apiKey };
});

// Asked once on load: the push below can fire before the window is listening,
// same reason `api:pendingCert` exists.
ipcMain.handle('companion:getState', () => ({ online: companionOnline }));
// Probe the connection. This NEVER approves anything — it only reports. A
// certificate the app held on comes back as `certNeedsApproval` for the user to
// look at; `approved: null` means this server has never been approved here.
ipcMain.handle('api:test', async (_evt, { url, apiKey }) => {
  const key = apiKey || readApiConfig().apiKey;
  if (!url || !key) return { ok: false, error: 'URL and API key are both required.' };
  const res = await api.health(url, key);
  if (res.ok) {
    // The probe succeeded but the feed may still be parked in its retry backoff
    // (up to 30s), and the feed is what gates the settings pages. Kick it so the
    // gate follows promptly. Same rule as api:write: no refresh here — the
    // reopen is the refresh (see setCompanionOnline).
    if (!companionOnline) { stopLiveFeed(); startLiveFeed(); }
    return { ok: true, version: res.version };
  }

  // Ask the server for its certificate DIRECTLY rather than hoping the verify
  // proc happened to park one. Chromium caches its certificate verdict per host
  // per session: the proc runs on the first connection and never again, so a
  // second Connect press produced nothing to show and the user got "could not
  // reach the server" for a server that was up and merely un-approved — with no
  // route to the approval panel for the rest of the session.
  const seen = await readServerCert(url);
  if (seen && !seen.trusted) {
    const approved = approvedFingerprint();
    if (seen.offered !== approved) {
      return {
        ok: false,
        error: approved
          ? "This server's certificate has changed since you approved it."
          : 'This server has not been approved on this machine yet.',
        certNeedsApproval: { host: seen.host, approved: approved || null, offered: seen.offered },
      };
    }
  }
  return { ok: false, error: 'Could not reach the server with that URL and key.' };
});

// ── Companion version check + remote upgrade ────────────────────────────────
// The desktop and the companion image are cut from the same release tag, so
// `app.getVersion()` is the upgrade target. 'companion-older' is the only
// status that offers an upgrade; 'companion-newer' means THIS desktop is the
// stale side (electron-updater's problem, not ours).
ipcMain.handle('api:checkVersion', async () => {
  const c = readApiConfig();
  if (!c.url || !c.apiKey) return { status: 'unconfigured' };
  const h = await api.health(c.url, c.apiKey);
  if (!h.ok) return { status: 'unreachable' };
  const desktop = app.getVersion();
  return { status: classifyVersions(desktop, h.version), desktop, companion: h.version };
});
ipcMain.handle('api:upgradeCompanion', async () => {
  const tag = `v${app.getVersion()}`;
  const r = await api.triggerUpdate(tag);
  // Accepted -> remember what we asked for; the live feed's reconnect (the
  // companion coming back from its restart) checks the version and announces
  // `api:companionUpdated` on a match. Fire-and-forget: nothing waits on this.
  if (r.ok) pendingUpgradeTag = tag;
  return r;
});

// The ONE place a certificate becomes approved: the user pressed Approve on a
// fingerprint Settings put in front of them. Deliberately not reachable from
// api:test — probing a connection must never be able to approve one.
// It also refuses to pin anything main didn't itself read off the configured
// server and show. Without that check this stored whatever string arrived, so the
// link between the fingerprint on screen and the fingerprint saved was UI
// convention — the same shape of unenforced policy as the certificate check that
// used to "trust anyway". See mayApprove in certPolicy.ts.
ipcMain.handle('api:approveCert', (_evt, { fingerprint }) => {
  if (typeof fingerprint !== 'string' || !fingerprint) return { ok: false, error: 'No fingerprint provided.' };
  if (!approveFingerprint(fingerprint)) {
    return { ok: false, error: 'That certificate is no longer the one being offered. Press Connect and review it again.' };
  }
  return { ok: true };
});

// Un-approve. For when the user compared the app's fingerprint against the
// server's and they didn't match — without this, the only way to clear an
// approval was to change the URL.
ipcMain.handle('api:forgetCert', () => {
  forgetFingerprint();
  return { ok: true };
});

// Is a certificate waiting for approval right now? The renderer asks on load.
//
// Registering the push early isn't sufficient on its own: the first stopped
// connection usually happens before the window exists, and a message sent to a
// window that isn't listening yet is simply lost — there is no replay. So the
// renderer pulls once at startup as well as subscribing.
ipcMain.handle('api:pendingCert', () => {
  // Filtered by the CONFIGURED host, same as every other read. Unfiltered, the
  // startup warning could name a server that isn't yours — the slot is written by
  // any companion request, including retries against a previous URL.
  const host = hostOf(readApiConfig().url);
  return getPendingCert(host) ?? null;
});

// Telegram — the desktop UI triggers these; the actions (setWebhook, token
// storage) happen on the companion, which owns the bot.
ipcMain.handle('telegram:status', async () => {
  try { return { ok: true, ...(await api.get('/telegram/status')) }; }
  catch (e: any) { return { ok: false, error: e?.message ?? String(e) }; }
});
ipcMain.handle('telegram:connect', async (_evt, { botToken, authorizedTgUserId }) => {
  try { return { ok: true, ...(await api.post('/telegram/connect', { botToken, authorizedTgUserId })) }; }
  catch (e: any) { return { ok: false, error: e?.message ?? String(e) }; }
});
ipcMain.handle('telegram:disconnect', async () => {
  try { await api.post('/telegram/disconnect'); return { ok: true }; }
  catch (e: any) { return { ok: false, error: e?.message ?? String(e) }; }
});
ipcMain.handle('telegram:setWorkspace', async (_evt, { workspaceId }) => {
  try { await api.post('/telegram/workspace', { workspaceId }); return { ok: true }; }
  catch (e: any) { return { ok: false, error: e?.message ?? String(e) }; }
});
// OAuth for agent secrets. The whole flow (system browser + loopback callback +
// token exchange/refresh) lives in main; the renderer only kicks it off and
// reads status back off the persisted secret. `oauth:listPresets` feeds the
// connect form's provider dropdown.
ipcMain.handle('oauth:listPresets', async () => {
  // Strip nothing — presets are static, non-secret metadata.
  return PROVIDER_PRESETS;
});

ipcMain.handle('oauth:startConnect', async (_evt, name) => {
  try {
    const result = await oauthStartConnect(name);
    return { ok: true, ...result };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
});

ipcMain.handle('oauth:disconnect', async (_evt, name) => {
  try {
    await oauthDisconnect(name);
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
});

// Mint a short-lived streaming token for whichever engine is selected. The
// long-lived API key sits encrypted in settings and never crosses to the renderer
// — only the 60s temp token does, which is just the WebSocket session credential.
//
// Both engines offer exactly this, which is what makes one handler enough:
// AssemblyAI has `/v3/token`, Deepgram has `/v1/auth/grant` (TTL 1–3600s). The
// PROVIDER comes back with the token because the renderer needs it to know which
// socket to open and how to read what comes back — see `useVoiceInput.ts`.
/**
 * Which engine, which key, and is the key even reachable.
 *
 * `readSettingsSafe` (not `readSettings`) so an unreachable companion returns a
 * clean error rather than rejecting the IPC — voice is optional, and this is
 * prefetched on mount, so a throw logged an unhandled rejection on every launch.
 * Report the REAL reason too: "not configured" is a lie when the key is
 * configured and the server simply isn't reachable.
 */
async function resolveVoiceEngine() {
  const { settings, online, reason } = await readSettingsSafe();
  if (!online) return { error: reason || "Can't reach your companion server." } as const;
  const config = voiceConfigOf(settings);
  const provider = listenProviderOf(config);
  const engineName = voiceLabel(provider);
  const apiKey = listenKey(config);
  // Name the engine: with three of them, "not configured" left you checking the
  // field you'd just filled in, for the provider you weren't using.
  if (!apiKey) return { error: `No ${engineName} key — add one under Settings → Agent Voice.` } as const;
  return { provider, engineName, apiKey } as const;
}

/**
 * Turn a refusal into something a user can act on.
 *
 * A bare "failed" is unactionable, and the two failures people actually hit are
 * opposites: a wrong key (fix the key) versus a Deepgram key without permission
 * to mint (fix the key's ROLE — a restricted key transcribes perfectly and
 * cannot grant). The reason carries no secret, so it goes to the renderer rather
 * than only to the log.
 */
async function voiceFailure(res: Response, provider: string, engineName: string) {
  const body = await res.text().catch(() => '');
  let detail = '';
  try {
    const parsed = JSON.parse(body);
    // Each vendor nests its reason somewhere different, and ElevenLabs' `detail`
    // is sometimes a string and sometimes an object with a message on it.
    const nested = typeof parsed?.detail === 'string' ? parsed.detail : parsed?.detail?.message;
    detail = parsed?.err_msg || parsed?.error || nested || '';
  } catch { detail = ''; }
  if (res.status === 401 || res.status === 403) {
    return provider === 'deepgram'
      ? `${engineName} rejected the key for streaming (HTTP ${res.status}). It needs Member permissions or higher to mint a token — a restricted key can transcribe but not grant.`
      : `${engineName} rejected the key (HTTP ${res.status}).`;
  }
  return `${engineName} refused the token request: ${detail || `HTTP ${res.status}`}`;
}

/**
 * Mint the streaming credential the renderer opens its socket with.
 *
 * **The lifetime is not the same for all three, and the renderer has to be told.**
 * AssemblyAI and Deepgram both issue a 60-second token that may be reused until
 * it expires, which is what the mic's 50-second cache is built around.
 * ElevenLabs issues a 15-minute token that is **consumed on first use** — cache
 * that one and the second click connects with a spent credential. So the TTL and
 * the single-use flag travel back with the token, out of `VOICE_PROVIDERS`,
 * rather than being a number the renderer assumes.
 */
async function mintVoiceToken(provider: string, engineName: string, apiKey: string) {
  const mic = voiceProvider(provider)?.mic;
  if (!mic) return { error: `${engineName} has no live microphone support.` };

  if (provider === 'deepgram') {
    const res = await fetch('https://api.deepgram.com/v1/auth/grant', {
      method: 'POST',
      headers: { Authorization: `Token ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ttl_seconds: Math.round(mic.tokenTtlMs / 1000) }),
    });
    if (!res.ok) return { error: await voiceFailure(res, provider, engineName) };
    const data = await res.json();
    if (!data?.access_token) return { error: `${engineName} returned no token.` };
    return { token: data.access_token as string };
  }

  if (provider === 'elevenlabs') {
    // The token type is part of the path, and `realtime_scribe` is the only one
    // this app wants — a token minted for anything else is refused by the socket.
    const res = await fetch('https://api.elevenlabs.io/v1/single-use-token/realtime_scribe', {
      method: 'POST',
      headers: { 'xi-api-key': apiKey },
    });
    if (!res.ok) return { error: await voiceFailure(res, provider, engineName) };
    const data = await res.json();
    const token = data?.token ?? data?.single_use_token;
    if (!token) return { error: `${engineName} returned no token.` };
    return { token: String(token) };
  }

  const res = await fetch(
    `https://streaming.assemblyai.com/v3/token?expires_in_seconds=${Math.round(mic.tokenTtlMs / 1000)}`,
    { headers: { Authorization: apiKey } },
  );
  if (!res.ok) return { error: await voiceFailure(res, provider, engineName) };
  const data = await res.json();
  if (!data?.token) return { error: `${engineName} returned no token.` };
  return { token: data.token as string };
}

ipcMain.handle('voice:getToken', async () => {
  const engine = await resolveVoiceEngine();
  if ('error' in engine) return { error: engine.error };
  const { provider, engineName, apiKey } = engine;
  try {
    const minted = await mintVoiceToken(provider, engineName, apiKey);
    if ('error' in minted) return minted;
    // The provider AND its token rules travel with the token. The renderer needs
    // the provider to pick a socket URL and read what comes back; it needs the
    // rules because caching a single-use token breaks the second click. Deriving
    // either from a second settings read would be a second answer that can
    // disagree with the one this token was minted against.
    const mic = voiceProvider(provider)!.mic!;
    return { token: minted.token, provider, tokenTtlMs: mic.tokenTtlMs, singleUse: mic.singleUse };
  } catch (err: any) {
    console.warn(`[voice] ${provider} token request failed:`, err.message);
    return { error: `Couldn't reach ${engineName}: ${err?.message ?? 'network error'}` };
  }
});

/**
 * Check what the stored key can actually DO — per capability, not pass/fail.
 *
 * The key feeds three consumers (the microphone, Telegram voice notes, the
 * agent's `transcribe` tool) and Deepgram gates them differently: transcription
 * needs any valid key, minting a streaming token needs Member or higher. So a
 * perfectly good restricted key made Verify say "rejected", which is false for
 * two of the three uses and sends the user to replace a key that works.
 *
 * Verify used to BE the token mint, on the reasoning that AssemblyAI ships no
 * key-check endpoint so the cheapest real request is the check, and this app
 * only ever used the streaming product. Both premises died with the second
 * engine. AssemblyAI still works that way — one credential, one capability, so
 * the mint remains the whole answer — while Deepgram is asked two questions.
 */
ipcMain.handle('voice:verifyKey', async () => {
  const engine = await resolveVoiceEngine();
  if ('error' in engine) return { ok: false, error: engine.error };
  const { provider, engineName, apiKey } = engine;

  try {
    if (provider === 'deepgram') {
      // This endpoint accepts ANY valid key and answers with the key's own
      // `scopes` — which is the actual capability answer, not the 200. Treating
      // the 200 as "it transcribes" was wrong: a key scoped `account:write` is
      // perfectly valid here and cannot transcribe a thing.
      const who = await fetch('https://api.deepgram.com/v1/auth/token', {
        headers: { Authorization: `Token ${apiKey}` },
      });
      if (!who.ok) return { ok: false, error: await voiceFailure(who, provider, engineName) };

      // DO NOT gate on the `scopes` in this response. It is not the key's
      // capability list — a Member key that mints tokens successfully still
      // reports `["account:write"]` here, so reading it as permissions rejects a
      // working key. Verified against two real keys: identical `scopes`, one
      // grants and one doesn't. The only trustworthy answer is to make the call.
      const minted = await mintVoiceToken(provider, engineName, apiKey);
      if ('error' in minted) {
        // The key is valid (the call above passed) and just can't mint. Voice
        // notes and the transcribe tool may well work; only the microphone is
        // definitely out, so this is a note, not a rejection.
        return { ok: true, canStream: false, engineName, streamError: minted.error };
      }
      return { ok: true, canStream: true, engineName };
    }

    const minted = await mintVoiceToken(provider, engineName, apiKey);
    if ('error' in minted) return { ok: false, error: minted.error };
    return { ok: true, canStream: true, engineName };
  } catch (err: any) {
    console.warn(`[voice] ${provider} verify failed:`, err.message);
    return { ok: false, error: `Couldn't reach ${engineName}: ${err?.message ?? 'network error'}` };
  }
});

/**
 * The voices the SPEAKING vendor offers, for the picker in Settings.
 *
 * In main because listing needs the API key, and the key never crosses into the
 * renderer — same reason the token mint lives here. Nothing is cached: the list
 * is fetched when the settings page asks for it, which is rare, and a stale
 * catalogue is worse than a second of waiting.
 *
 * The two vendors answer very differently and both answers are normalized to
 * `{ id, name, preview }`:
 *   - ElevenLabs pages, ten at a time by default. Ask for the maximum and follow
 *     the page token, or a user with a full voice library sees the first ten and
 *     no sign there are more.
 *   - Deepgram has no voice endpoint at all — its voices ARE models, so the model
 *     list is the voice list, and the `tts` half of it is the answer.
 */
async function listVoicesFor(provider: string, apiKey: string) {
  if (provider === 'elevenlabs') {
    const voices: Array<{ id: string; name: string; preview?: string }> = [];
    let pageToken: string | undefined;
    // Bounded: a runaway `has_more` must not loop the main process forever.
    for (let page = 0; page < 20; page++) {
      const qs = new URLSearchParams({ page_size: '100', ...(pageToken ? { next_page_token: pageToken } : {}) });
      const res = await fetch(`https://api.elevenlabs.io/v2/voices?${qs}`, {
        headers: { 'xi-api-key': apiKey },
      });
      if (!res.ok) return { error: await voiceFailure(res, provider, voiceLabel(provider)) };
      const data: any = await res.json();
      for (const v of data?.voices ?? []) {
        if (v?.voice_id) voices.push({ id: String(v.voice_id), name: String(v.name ?? v.voice_id), preview: v.preview_url || undefined });
      }
      if (!data?.has_more || !data?.next_page_token) break;
      pageToken = String(data.next_page_token);
    }
    return { voices };
  }

  if (provider === 'deepgram') {
    const res = await fetch('https://api.deepgram.com/v1/models', {
      headers: { Authorization: `Token ${apiKey}` },
    });
    if (!res.ok) return { error: await voiceFailure(res, provider, voiceLabel(provider)) };
    const data: any = await res.json();
    const voices = (data?.tts ?? [])
      .filter((m: any) => m?.canonical_name || m?.name)
      .map((m: any) => ({
        // `canonical_name` is what the speak endpoint's `model=` takes; `name` is
        // the human one. Falling back either way keeps an unfamiliar shape usable.
        id: String(m.canonical_name ?? m.name),
        name: String(m.name ?? m.canonical_name),
      }));
    return { voices };
  }

  return { error: `${voiceLabel(provider)} does not do text to speech.` };
}

ipcMain.handle('voice:listVoices', async () => {
  const { settings, online, reason } = await readSettingsSafe();
  if (!online) return { error: reason || "Can't reach your companion server." };
  const config = voiceConfigOf(settings);
  const provider = speakProviderOf(config);
  if (!provider) return { error: 'Choose a provider for speaking first.' };
  const apiKey = speakKey(config);
  if (!apiKey) return { error: `No ${voiceLabel(provider)} key — add one under Settings → Agent Voice.` };
  try {
    return await listVoicesFor(provider, apiKey);
  } catch (err: any) {
    console.warn(`[voice] ${provider} voice list failed:`, err.message);
    return { error: `Couldn't reach ${voiceLabel(provider)}: ${err?.message ?? 'network error'}` };
  }
});

// ---- App update check ------------------------------------------------------
//
// **Checking is automatic; downloading and installing are not.** Packaged builds
// use electron-updater (feed baked in from package.json's `build.publish` GitHub
// block), but with BOTH of its self-driving flags off:
//
//   autoDownload         — every check used to download ~100MB the moment it
//                          found something, 8s after launch, unasked.
//   autoInstallOnAppQuit — worse, because nothing showed it: once a download had
//                          landed, the next ordinary Cmd+Q installed a different
//                          version. The user agreed to nothing at any point.
//
// Turning off only the first would have moved the download decision to the user
// while leaving the *install* decision to whenever they happened to quit, so
// both are off. The cost is real and intended: someone who never presses the
// button stays on an old version indefinitely.
//
// The status is a PHASE, not a pair of booleans (idle → available → downloading
// → ready, plus error). Three places render it — the pill, the toast, and
// Settings → Updates — and with five states across two flags they drift; this is
// the same shape as sync's status machine for the same reason.
//
// macOS requires the signed + notarized build — electron-updater refuses
// unsigned apps there.
//
// Dev (unpackaged) has no app-update.yml and so has no downloader at all: the
// notify-only GitHub API poll fills in the same status with `canDownload: false`,
// and the UI offers the release page instead of a Download button. Unauthenticated
// GitHub API allows ~60 req/hr — a daily poll, the odd manual check and the
// release-notes read are nowhere near that.
const { autoUpdater } = electronUpdater;

// electron-updater's own log of the whole check → download → stage sequence,
// to `~/Library/Logs/<app>/main.log` (and the platform equivalents).
//
// Without this its failures go to stderr, which is discarded when the app is
// launched from Finder — so a packaged build that silently refuses to update
// gives you nothing to look at. That is exactly the state v1.0.16 shipped in:
// diagnosing it meant relaunching from a terminal to see anything at all.
updateLog.transports.file.level = 'info';
autoUpdater.logger = updateLog;
const UPDATE_REPO = { owner: 'stephengpope', repo: 'shockwave' };
const UPDATE_POLL_MS = 24 * 60 * 60 * 1000; // daily auto-check

// "v1.2.3" / "1.2.3-beta" → [1,2,3]; the leading "v" and any pre-release/build
// suffix are dropped (we only compare the numeric core).
function parseVersion(v: string): number[] {
  const core = String(v || '').trim().replace(/^v/i, '').split(/[-+]/)[0];
  return core.split('.').map((n) => parseInt(n, 10) || 0);
}
// >0 when `a` is newer than `b`, <0 when older, 0 when equal.
function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

// The mutable part of the status. `current`, `canDownload` and `snoozedVersion`
// are derived on every push (see buildUpdateStatus), so they can't go stale.
let updateState = {
  phase: 'idle' as 'idle' | 'available' | 'downloading' | 'ready' | 'error',
  latest: null as string | null,
  url: null as string | null,
  error: null as string | null,
  percent: 0,
};

// Which version the user dismissed the toast for. Machine-local: installing is a
// per-machine act, so snoozing one is too. Read fresh rather than cached — it is
// one small file read on an event that fires a few times a day.
function snoozedUpdateVersion(): string | null {
  return readLocalSettings().updateSnoozedVersion ?? null;
}

function buildUpdateStatus() {
  return {
    ...updateState,
    current: app.getVersion(),
    canDownload: app.isPackaged,
    snoozedVersion: snoozedUpdateVersion(),
  };
}

// Last computed status, served to renderers that subscribe after a background
// check already ran (so the pill hydrates without waiting for the next poll).
let lastUpdateResult: any = null;

// MERGES — an error mid-download must not blank out which version we were after,
// or the UI ends up saying "couldn't update" with nothing to name.
function pushUpdateStatus(patch: Partial<typeof updateState>) {
  updateState = { ...updateState, ...patch };
  lastUpdateResult = buildUpdateStatus();
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send('app:updateStatus', lastUpdateResult);
  }
}

function releasePageUrl(version: string | null) {
  const tail = version ? `tag/v${version}` : 'latest';
  return `https://github.com/${UPDATE_REPO.owner}/${UPDATE_REPO.repo}/releases/${tail}`;
}

if (app.isPackaged) {
  // Both off on purpose — see the block comment above. Do not turn either back on.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.on('update-available', (info) => pushUpdateStatus({
    phase: 'available', latest: info.version, url: releasePageUrl(info.version),
    error: null, percent: 0,
  }));
  autoUpdater.on('update-not-available', (info) => pushUpdateStatus({
    phase: 'idle', latest: info?.version ?? null,
    url: releasePageUrl(info?.version ?? null), error: null, percent: 0,
  }));
  autoUpdater.on('download-progress', (p) => pushUpdateStatus({
    phase: 'downloading', percent: Math.max(0, Math.min(100, Math.round(p?.percent ?? 0))),
  }));
  autoUpdater.on('update-downloaded', (info) => pushUpdateStatus({
    phase: 'ready', latest: info.version, url: releasePageUrl(info.version),
    error: null, percent: 100,
  }));
  autoUpdater.on('error', (err) => {
    console.warn('[update] electron-updater error:', err.message);
    pushUpdateStatus({ phase: 'error', error: err.message || 'update failed' });
  });
}

async function runUpdateCheck() {
  const current = app.getVersion();
  // A finished download is terminal until the user restarts — re-checking would
  // walk the phase back to `available` and lose the Restart button.
  if (updateState.phase === 'downloading' || updateState.phase === 'ready') return lastUpdateResult;
  if (app.isPackaged) {
    // Events above push status as the check progresses; the resolved value is
    // just the freshest snapshot for the invoking caller.
    try { await autoUpdater.checkForUpdates(); } catch { /* 'error' event already pushed */ }
    return lastUpdateResult;
  }
  try {
    const res = await fetch(
      `https://api.github.com/repos/${UPDATE_REPO.owner}/${UPDATE_REPO.repo}/releases/latest`,
      { headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(5000) },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const latest = String(data.tag_name || '').replace(/^v/i, '');
    const url = data.html_url
      || `https://github.com/${UPDATE_REPO.owner}/${UPDATE_REPO.repo}/releases/latest`;
    pushUpdateStatus({
      phase: latest && compareVersions(latest, current) > 0 ? 'available' : 'idle',
      latest, url, error: null, percent: 0,
    });
  } catch (err: any) {
    console.warn('[update] check failed:', err.message);
    pushUpdateStatus({ phase: 'error', error: err.message || 'check failed' });
  }
  return lastUpdateResult;
}

// Manual check (Settings → Updates button) — always hits the network.
ipcMain.handle('app:checkForUpdates', async () => runUpdateCheck());
// Cached status for a freshly-mounted renderer (null until the first check).
ipcMain.handle('app:getUpdateStatus', async () => lastUpdateResult);

// Start the download — the only thing that fetches the update, and it exists
// only because the user pressed something. electron-updater downloads against
// the update info its last check cached, which is exactly the check that put us
// in `available`, so there is nothing to re-fetch first.
ipcMain.handle('app:downloadUpdate', async () => {
  if (!app.isPackaged) return lastUpdateResult;           // dev: no downloader
  if (updateState.phase === 'downloading' || updateState.phase === 'ready') return lastUpdateResult;
  if (!updateState.latest) return lastUpdateResult;       // nothing found yet
  pushUpdateStatus({ phase: 'downloading', percent: 0, error: null });
  // Not awaited: the whole point is that the UI follows `download-progress`
  // rather than blocking on a multi-hundred-megabyte transfer. Failures arrive
  // through the 'error' event, which is why the catch is empty.
  autoUpdater.downloadUpdate().catch(() => {});
  return lastUpdateResult;
});

// Install the downloaded update and relaunch. Goes through app.quit(), so the
// before-quit/will-quit drains (agent, sync, settings queue) still run. The
// renderer confirms first — this kills a running agent turn.
ipcMain.handle('app:restartToUpdate', () => {
  if (app.isPackaged && updateState.phase === 'ready') autoUpdater.quitAndInstall();
});

// "Don't tell me about this one again." Silences the TOAST for that version only;
// the pill is ambient and stays. Passing null clears it (a fresh version found
// later is news again anyway, since the check compares against this exact string).
ipcMain.handle('app:snoozeUpdate', (_evt, version: string | null) => {
  patchLocalSettings({ updateSnoozedVersion: version || null });
  pushUpdateStatus({});   // re-derives snoozedVersion and broadcasts
  return lastUpdateResult;
});

// Release notes for every version between the running one and the newest, so a
// user four releases behind sees all four rather than only the last. One list
// request either way. Cached per running-version because the answer only grows
// at the top and a dialog reopen shouldn't re-fetch.
let releaseNotesCache: { current: string; notes: any[] } | null = null;
ipcMain.handle('app:getReleaseNotes', async () => {
  const current = app.getVersion();
  if (releaseNotesCache?.current === current) return { notes: releaseNotesCache.notes, error: null };
  try {
    const res = await fetch(
      `https://api.github.com/repos/${UPDATE_REPO.owner}/${UPDATE_REPO.repo}/releases?per_page=30`,
      { headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(8000) },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const notes = (Array.isArray(data) ? data : [])
      .filter((r: any) => !r.draft)
      .map((r: any) => ({
        version: String(r.tag_name || '').replace(/^v/i, ''),
        name: r.name || null,
        // Raw markdown — the renderer already draws markdown, so nothing here
        // has to sanitize HTML.
        body: r.body || '',
        url: r.html_url || null,
        publishedAt: r.published_at || null,
      }))
      .filter((r: any) => r.version && compareVersions(r.version, current) > 0)
      .sort((a: any, b: any) => compareVersions(b.version, a.version));
    releaseNotesCache = { current, notes };
    return { notes, error: null };
  } catch (err: any) {
    console.warn('[update] release notes failed:', err.message);
    return { notes: [], error: err.message || 'Could not load release notes' };
  }
});

// ---- GitHub sync ----
//
// PAT-bearing operations all happen in main; the renderer never receives the
// PAT. `sync:verifyPat` runs the PAT through GET /user as a sanity check on
// settings save. `sync:checkGit` reports whether the git CLI is available so
// the UI can show install instructions before the user gets to "configure
// sync".

ipcMain.handle('sync:verifyPat', async (_evt, pat) => {
  // A typed value wins — the point of verifying before saving is to check a token
  // the user hasn't committed yet.
  if (pat) return syncVerifyPat(pat);
  // Nothing typed → verify the STORED one. Required now that the renderer is
  // never given credential values: its draft is empty whenever the user isn't
  // mid-edit, so gating Verify on the draft left the button permanently disabled
  // for everyone who already had a token — i.e. exactly the people who'd want to
  // check whether it still works.
  const { settings, online, reason } = await readSettingsSafe();
  if (!online) return { ok: false, error: reason || "Can't reach your companion server." };
  const stored = settings.sync?.pat || '';
  if (!stored) return { ok: false, error: 'No token saved yet.' };
  return syncVerifyPat(stored);
});

ipcMain.handle('sync:checkGit', async () => {
  return syncCheckGit();
});

// Helper: load the decrypted PAT from settings for sync setup IPCs that need
// it. We don't accept PAT from the renderer for these flows — the user has
// already saved one (otherwise the UI gates them out) so we read straight
// from disk. Returns null + an error result if PAT isn't set.
async function readSyncPat() {
  // Safe read: settings live on the companion, so an unreachable or un-approved
  // one made this THROW out of whichever IPC handler called it — an unhandled
  // rejection in the renderer rather than a message. And report the real reason:
  // "Connect a GitHub account first" for a companion problem sends the user to
  // fix the wrong thing.
  const { settings, online, reason } = await readSettingsSafe();
  if (!online) return { ok: false, error: reason || "Can't reach your companion server." };
  const pat = settings.sync?.pat || '';
  if (!pat) return { ok: false, error: 'Connect a GitHub account first.' };
  return { ok: true, pat };
}

// ---- Workspace creation ----
//
// The two ways to get a workspace: make a repo or pick one. Both clone into a
// new folder and, only on success, insert the row — so a failed setup leaves no
// workspace pointing at a folder that isn't a checkout.
//
// `name` is display-only and defaults to the repo name. The id is minted here
// rather than by the renderer: the row is created in main now, so there's no
// window where the renderer holds an id for a workspace that doesn't exist.

async function finishWorkspaceSetup(res: any, name: string) {
  const id = crypto.randomUUID();
  await createWorkspace({
    id,
    name: (name || '').trim() || res.repoName,
    path: res.path,
    repoOwner: res.repoOwner,
    repoName: res.repoName,
    defaultBranch: res.defaultBranch,
  });
  // Tell the renderer before it can save settings built from a list that
  // doesn't include this row yet — see notifyWorkspacesChanged.
  await notifyWorkspacesChanged();
  return { ok: true, id, path: res.path, repoOwner: res.repoOwner, repoName: res.repoName };
}

ipcMain.handle('workspace:createWithRepo', async (_evt, { workspacePath, repoName, name, private: isPrivate = true }) => {
  const auth = await readSyncPat();
  if (!auth.ok) return auth;
  const res = await syncCreateWorkspaceRepo({ workspacePath, repoName, private: isPrivate, pat: auth.pat });
  if (!res.ok) return res;
  return await finishWorkspaceSetup(res, name);
});

// Classify a picked folder so the dialog knows what to ask next: empty (pick a
// repo to clone in), already a clone (we know the repo — just confirm), or
// occupied (refuse). Read-only.
ipcMain.handle('workspace:inspectFolder', async (_evt, workspacePath) => {
  return syncClassifyFolder(workspacePath);
});

// Add a workspace for an existing repo. Covers both "clone this repo into an
// empty folder" and "this folder is already a clone of it" — `ensureCheckout`
// makes the folder match `owner/repo` whichever it was, so the dialog doesn't
// need two calls and main doesn't need two handlers.
ipcMain.handle('workspace:addFromRepo', async (_evt, { workspacePath, owner, repo, name }) => {
  const auth = await readSyncPat();
  if (!auth.ok) return auth;
  // Two workspaces on one repo would sync over each other through the same
  // branch, so the repo — not the folder — is what has to be unique.
  const dup = await findWorkspaceByRepo(owner, repo);
  if (dup) return { ok: false, error: `${owner}/${repo} is already open as "${dup.name}".` };
  if (await isPathClaimed(workspacePath)) {
    return { ok: false, error: 'Another workspace already uses that folder.' };
  }
  const res = await syncEnsureCheckout({ workspacePath, owner, repo, pat: auth.pat });
  if (!res.ok) return res;
  return await finishWorkspaceSetup(res, name);
});

// Check out an EXISTING workspace on this machine — the workspace already has a
// repo, it just has no local row here (a DB synced from another machine, or a
// folder that went missing). Same folder handling as adding one; only the
// bookkeeping differs, since the workspace row already exists.
ipcMain.handle('workspace:setUpHere', async (_evt, { id, workspacePath }) => {
  const auth = await readSyncPat();
  if (!auth.ok) return auth;
  const ws = await getWorkspace(id);
  if (!ws) return { ok: false, error: 'Workspace not found' };
  if (ws.path) return { ok: false, error: `"${ws.name}" is already set up at ${ws.path}.` };
  if (await isPathClaimed(workspacePath, id)) {
    return { ok: false, error: 'Another workspace already uses that folder.' };
  }

  const res = await syncEnsureCheckout({
    workspacePath, owner: ws.repoOwner, repo: ws.repoName, pat: auth.pat,
  });
  if (!res.ok) return res;

  try {
    wsSetUpHere(id, workspacePath);
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Could not record that checkout.' };
  }
  await notifyWorkspacesChanged();
  return { ok: true, id, path: workspacePath };
});

// The workspace default file set (SOUL.md, AGENTS.md, .ignore, .gitignore).
// Both creation paths seed it automatically; these two handlers are the manual
// half, for workspaces that predate a file being added to the manifest.
//
// `listFiles` lets the UI say what's missing before the user commits to writing
// anything. `ensureFiles` with overwrite writes the whole manifest unconditionally — the
// renderer confirms that first, since git only makes it recoverable for what's
// already committed.
ipcMain.handle('workspace:listFiles', async (_evt, { workspacePath }) => {
  if (!workspacePath) return { ok: false, error: 'That workspace is not set up on this machine.' };
  const missing = await missingWorkspaceFiles(workspacePath);
  return { ok: true, files: DEFAULT_FILES.map((f) => ({ name: f.name, purpose: f.purpose })), missing };
});

ipcMain.handle('workspace:ensureFiles', async (_evt, { workspacePath, overwrite = false }) => {
  if (!workspacePath) return { ok: false, error: 'That workspace is not set up on this machine.' };
  const written = await ensureWorkspaceFiles(workspacePath, { overwrite });
  return { ok: true, written };
});

// The engine holds a path captured at start(), not a live row reference, so
// anything that removes a workspace has to stop it explicitly first.
async function stopEngineForWorkspace(id: string) {
  const ws = await getWorkspace(id);
  if (ws?.path && engineBoundPath() === ws.path) await engineStop();
}

// Removal is its own call, not a settings save that happens to omit an id.
// That's both what the user action actually is, and what stops a stale renderer
// How this workspace's Telegram replies come back. Writes the companion's
// workspace row — the same value `/voice` sets on the bot — then re-pushes the
// list, so the page updates from the store rather than from local state.
ipcMain.handle('workspace:setVoiceReply', async (_evt, { id, mode }) => {
  await setWorkspaceVoiceReply(id, mode);
  await notifyWorkspacesChanged();
  return { ok: true };
});

// list from deleting a workspace it never knew about — see `updateWorkspaces`.
// Nothing on disk is touched: not the checkout, not the GitHub repo.
ipcMain.handle('workspace:remove', async (_evt, { id }) => {
  // Stop the engine FIRST if it's bound to this workspace. It captured its
  // path at start(), so deleting the row doesn't reach it — it would keep
  // committing and pushing to a folder the user just removed from the app.
  await stopEngineForWorkspace(id);
  await removeWorkspace(id);
  await notifyWorkspacesChanged();
  return { ok: true };
});

// Forget this machine's checkout but keep the workspace. What a vanished folder
// means: the clone is gone, the repo isn't. Deleting the whole workspace there
// would discard a perfectly valid remote because a folder moved — the row drops
// back to "not set up here" and can be re-cloned.
ipcMain.handle('workspace:forgetLocal', async (_evt, { id }) => {
  await stopEngineForWorkspace(id);
  wsForgetLocal(id);
  await notifyWorkspacesChanged();
  return { ok: true };
});

// List repos visible to the configured PAT, for the per-workspace "link to
// existing repo" picker. PAT is read from settings here so the renderer never
// touches it.
ipcMain.handle('sync:listRepos', async () => {
  const auth = await readSyncPat();
  if (!auth.ok) return auth;
  return syncListRepos(auth.pat);
});

// ---- Sync engine lifecycle ----
//
// Engine is bound to the renderer's active workspace. The renderer calls
// start/stop as workspaces load/unload. Status events are pushed back via
// `sync:status` and consumed by the status-bar icon.

ipcMain.handle('sync:engineStart', async (evt, { workspacePath, intervalSeconds }) => {
  // Safe read — a throw here rejected in the renderer on every workspace open.
  // No PAT means the engine emits `unconfigured` and the icon hides, which is the
  // right outcome for a companion we can't read.
  const { settings } = await readSettingsSafe();
  const pat = settings.sync?.pat || '';
  const ws = await findWorkspaceByPath(workspacePath);
  const win = BrowserWindow.fromWebContents(evt.sender);
  // User turned sync off for this workspace → don't start the engine, but show
  // the DISABLED (stop) icon so they can re-enable from the status bar. Nothing
  // on disk changes, so re-enabling is a single engineStart with no setup.
  if (ws && !ws.syncEnabled) {
    // Target this window BEFORE emitting — `userDisable` emits through
    // `state.windowId`, which after a reload is a destroyed id, so the stop
    // icon would go nowhere and the user couldn't re-enable.
    await engineUserDisable(win?.id ?? null);
    return;
  }
  await engineStart({
    workspacePath,
    pat,
    intervalSeconds: intervalSeconds ?? settings.sync?.pullIntervalSeconds ?? 10,
    windowId: win?.id ?? null,
  });
});

// Toggle per-workspace sync. Persists the flag; if this is the active
// workspace, reconciles by stopping or starting the engine. Nothing on disk is
// touched either way, so re-enable is a no-touch resume.
ipcMain.handle('sync:setWorkspaceDisabled', async (evt, { workspacePath, disabled }) => {
  // One boolean on one row. This used to rebuild the whole disabledWorkspaceIds
  // array and write it back inside the sync object, which rewrote every
  // workspace row AND re-encrypted the GitHub PAT to flip one flag.
  const ws = await findWorkspaceByPath(workspacePath);
  if (!ws) return { ok: false, error: 'Workspace not found' };
  const wsId = ws.id;
  setSyncEnabled(wsId, !disabled);
  // The flag lives on the workspace row, so the renderer learns about it the
  // same way it learns about any other workspace change.
  await notifyWorkspacesChanged();
  const { settings } = await readSettingsSafe(); // never throw into the renderer
  const nextSync = settings.sync;

  // Reconcile only if this is the active workspace. The engine is bound to
  // one workspace at a time; touching engine state for a non-active one
  // would yank the engine away from the workspace the user is editing.
  if (settings.activeWorkspaceId === wsId) {
    if (disabled) {
      // Show the DISABLED (stop) icon — not hidden — so it can be re-enabled
      // from the status bar.
      const win = BrowserWindow.fromWebContents(evt.sender);
      await engineUserDisable(win?.id ?? null);
    } else {
      const win = BrowserWindow.fromWebContents(evt.sender);
      await engineStart({
        workspacePath,
        pat: nextSync.pat || '',
        intervalSeconds: nextSync.pullIntervalSeconds ?? 10,
        windowId: win?.id ?? null,
      });
    }
  }
  return { ok: true };
});

ipcMain.handle('sync:engineStop', async () => {
  await engineStop();
});

// Renderer's ack of the flush-dirty-tabs request. The engine waits on this
// before proceeding with the rest of the tick.
ipcMain.handle('sync:flushDone', async (_evt, token) => {
  engineHandleFlushDone(token);
});

// One-shot status read (renderer asks for current state on mount before the
// next push event would arrive).
ipcMain.handle('sync:engineStatus', async () => {
  return engineGetCurrentStatus();
});

// Conflict-resolution view: list unmerged files, and resolve one (git add).
// Both return workspace-relative POSIX paths.
ipcMain.handle('sync:listConflicts', async (_evt, workspacePath) => {
  if (!workspacePath) return [];
  return engineGetConflicts(workspacePath);
});

ipcMain.handle('sync:resolveConflict', async (_evt, { workspacePath, relPath }) => {
  if (!workspacePath || !relPath) return [];
  return engineResolveConflict(workspacePath, relPath);
});

// Per file: keep ours / take remote.
ipcMain.handle('sync:keepConflict', async (_evt, { workspacePath, relPath }) => {
  if (!workspacePath || !relPath) return [];
  return engineKeepConflict(workspacePath, relPath);
});
ipcMain.handle('sync:resetConflict', async (_evt, { workspacePath, relPath }) => {
  if (!workspacePath || !relPath) return [];
  return engineResetConflict(workspacePath, relPath);
});

// Whole tree: keep ours everywhere (then complete the merge), or hard-reset to origin.
ipcMain.handle('sync:keepAll', async (_evt, workspacePath) => {
  if (!workspacePath) return;
  return engineKeepAll(workspacePath);
});
ipcMain.handle('sync:resetToRemote', async (_evt, workspacePath) => {
  if (!workspacePath) return;
  return engineResetToRemote(workspacePath);
});

// ---- Coding agent (pi) ----
//
// One live pi AgentSession per chat (see codingAgent.ts). The renderer sends
// `agent:send` with the chat's chatId (a renderer-minted UUID for new chats)
// plus the prompt text; main reads the current workspace and coding-agent
// settings, lazily creates or reuses that chat's session, then forwards every
// pi event back via `agent:event` — each stamped with its chatId so the
// renderer can route it to the right chat. Sends to a chat that is mid-turn
// are steered into the running turn by codingAgent.ts.

ipcMain.handle('agent:send', async (evt, { chatId, text, images }) => {
  const win = BrowserWindow.fromWebContents(evt.sender);
  if (!win) return;
  const emit = (channel, payload) => {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  };

  try {
    const settings = await readSettings();
    // Unified system timezone → the agent's "current date" (pi reads local tz).
    if (settings.timezone) process.env.TZ = settings.timezone;
    const ws = (settings.workspaces || []).find((w) => w.id === settings.activeWorkspaceId);
    const workspacePath = ws?.path ?? null;
    const { provider, model, baseUrl, contextWindow, thinkingLevel, providerKeys, memoryCharLimit, userCharLimit } = settings.codingAgent ?? {};
    const apiKey = providerKeys?.[provider] ?? '';
    // Built-in skill on/off is per-workspace only; it lives in the workspace file.
    const wsData = workspacePath ? await readWorkspaceFileRaw(workspacePath) : null;

    await agentSend(
      {
        chatId,
        text,
        images,
        workspaceId: ws?.id ?? '',
        workspacePath,
        provider,
        model,
        apiKey,
        baseUrl,
        contextWindow,
        thinkingLevel,
        wsBuiltinSkills: wsData?.builtinSkills ?? {},
        timezone: settings.timezone,   // same zone the companion's scheduler evaluates cron.json in
        memoryCharLimit, userCharLimit,   // the memory tool's budgets — see RunOpts
      },
      // Desktop emit routes to BOTH sinks: the renderer (IPC) and the companion
      // live feed, so other clients watching this chat see the turn stream.
      (event) => { emit('agent:event', event); postEvent(event.chatId, event).catch(() => {}); },
    );
  } catch (err: any) {
    emit('agent:error', { chatId, message: err?.message ?? String(err) });
  }
});

// Chats with a turn in flight — the renderer re-seeds its running set from
// this after a window reload.
ipcMain.handle('agent:runningChats', () => agentRunningChats());

// ---- Skills (built-in = bundled, app-global; uploaded = per-workspace) ----
// `skills:list` returns both sets for the given workspace; built-in toggle state
// is read by the renderer from the workspace file.
ipcMain.handle('skills:list', async (_evt, workspacePath) => {
  const [builtin, workspace] = await Promise.all([
    listBuiltinSkills(builtinSkillsDir()),
    listWorkspaceSkills(workspacePath),
  ]);
  return { builtin, workspace };
});

// The active workspace's uploaded-skills folder (for a "Reveal" button).
ipcMain.handle('skills:libraryDir', async (_evt, workspacePath) => {
  return workspacePath ? workspaceSkillsDir(workspacePath) : null;
});

ipcMain.handle('skills:importPicker', async (_evt, workspacePath) => {
  if (!workspacePath) throw new Error('Open a workspace first.');
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory'],
    title: 'Choose a skill folder (must contain SKILL.md)',
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return importSkillToWorkspace(workspacePath, result.filePaths[0]);
});

ipcMain.handle('skills:importFromPath', async (_evt, { workspacePath, srcPath }) => {
  if (!workspacePath) throw new Error('Open a workspace first.');
  if (typeof srcPath !== 'string' || !srcPath) throw new Error('No path provided.');
  return importSkillToWorkspace(workspacePath, srcPath);
});

ipcMain.handle('skills:remove', async (_evt, { workspacePath, folderName }) => {
  if (!workspacePath) throw new Error('Open a workspace first.');
  if (typeof folderName !== 'string' || !folderName) throw new Error('No skill name provided.');
  return removeWorkspaceSkill(workspacePath, folderName);
});

ipcMain.handle('agent:abort', async (_evt, chatId) => {
  try { await agentAbort(chatId); } catch { /* abort is best-effort */ }
});

// ---- Chat history (SQLite: display + search; pi's JSONL: continuation) ----
// The active workspace scopes every list/search (chats are workspace-scoped).
async function activeWorkspacePath(): Promise<string | null> {
  const settings = await readSettings();
  const ws = (settings.workspaces || []).find((w) => w.id === settings.activeWorkspaceId);
  return ws?.path ?? null;
}

// Chats are scoped by workspace IDENTITY (shared), not the local path.
function activeWorkspaceId(): string | null {
  return readLocalSettings().activeWorkspaceId ?? null;
}

// Recent chats for the picker (keyset paginated on updatedAt; pass `before`).
ipcMain.handle('chat:list', async (_evt, opts = {}) => {
  const ws = activeWorkspaceId();
  if (!ws) return [];
  return listChats(ws, opts);
});

// Pinned chats (the section at the top of the picker).
ipcMain.handle('chat:listPinned', async () => {
  const ws = activeWorkspaceId();
  if (!ws) return [];
  return listPinned(ws);
});

// Toggle a chat's pinned flag.
ipcMain.handle('chat:setPinned', async (_evt, { chatId, pinned }) => {
  if (chatId) await setChatPinned(chatId, !!pinned);
});

// Cross-chat title search.
ipcMain.handle('chat:search', async (_evt, { query, limit } = {}) => {
  const ws = activeWorkspaceId();
  if (!ws || !query) return [];
  return searchChats(ws, query, { limit });
});

// Messages for one chat — the renderer rebuilds the transcript from these.
ipcMain.handle('chat:getMessages', async (_evt, chatId) => {
  if (!chatId) return [];
  return getMessages(chatId);
});

// Open a saved chat: return its row + messages so the renderer can hydrate the
// UI. No main-side session work — the chat's session boots on the next send.
//
// `workspacePath` is resolved here because the renderer keys chats by local PATH
// while the row only carries the shared workspace ID. A chat discovered from the
// live feed (a Telegram run the renderer has never seen) has no other way to
// learn which workspace it belongs to.
ipcMain.handle('chat:open', async (_evt, chatId) => {
  const { chat, messages } = await openChatApi(chatId);
  if (!chat) return { messages: [] };
  const local = readLocalSettings().workspaceLocal?.[chat.workspaceId];
  return { chat, messages: messages ?? [], workspacePath: local?.path ?? null };
});

ipcMain.handle('chat:delete', async (_evt, chatId) => {
  if (!chatId) return;
  // Abort + drop any live session first so a running turn can't keep writing.
  try { await agentDisposeChat(chatId); } catch { /* best-effort */ }
  // The chat's scratch pad goes with it — the precise signal, so its working
  // files don't sit around waiting for the age sweep to notice.
  await removeAgentScratch(chatId);
  await deleteChat(chatId);
});

ipcMain.handle('chat:rename', async (_evt, { chatId, title }) => {
  if (chatId && typeof title === 'string') await setChatTitle(chatId, title.slice(0, 100));
});

// This machine's name — used by the renderer to tell "running on THIS machine"
// (my turn, composer stays live) from "running elsewhere" (freeze).
ipcMain.handle('app:machineId', () => os.hostname());

// ── Live feed (spectator side) ───────────────────────────────────────────────
//
// ONE stream to the companion, opened at startup and held for the life of the
// app, carrying every chat's events — Telegram, cron, and the same chat running
// on another machine. It forwards into the same `agent:event` channel a local
// turn uses, so a remote turn draws identically.
//
// It is always on by design. This used to be a per-chat subscription started
// from the renderer when you clicked a chat that happened to be running
// elsewhere at that instant — which meant a Telegram turn was never watched, and
// a chat you already had open could never start listening at all.
let feedAbort: (() => void) | null = null;
let feedRetry: NodeJS.Timeout | null = null;
let feedBackoff = 1000;

// ── Companion connection state — ONE rule, not a list of refresh call sites ──
//
// The workspace list lives on the companion; the renderer holds an in-memory
// copy. Refreshing that copy used to happen in exactly one place — the boot read
// — so a desktop that started while the companion was down kept an empty list
// for the whole session, and neither the companion coming back nor connecting
// one in Settings asked again. Restarting the app was the only recovery.
//
// The fix is not another refresh call at each of those sites; that's the pattern
// that missed them in the first place. It's a single rule: WHENEVER THE
// COMPANION BECOMES REACHABLE, re-read and push. The live feed already knows —
// its stream opening means the companion answered, its `done()` means we lost
// it — so that transition is the only trigger, and every case (boot, reconnect
// after an upgrade restart, Settings → Connect) is the same event.
let companionOnline = false;
let refreshRetry: NodeJS.Timeout | null = null;

// Push the companion-owned settings the renderer mirrors. The read can fail even
// though the feed just opened (a blip between the two requests), and a dropped
// push here is the whole bug — the renderer would sit on an empty list with no
// further transition to trigger another attempt, since the feed stays connected.
// So retry, bounded, and give up rather than poll forever: losing the feed is
// itself a transition, and that path will try again.
const REFRESH_RETRY_MS = [2000, 5000, 15_000];
async function refreshCompanionData(attempt = 0) {
  if (refreshRetry) { clearTimeout(refreshRetry); refreshRetry = null; }
  if (!companionOnline) return; // went offline mid-flight; the next open retries
  // A FULL snapshot, not a list of keys. The renderer's copy after a boot with the
  // companion down isn't stale in one place — it is empty everywhere, because
  // `readSettingsSafe` returns machine-local values only. Re-pushing just the
  // workspace list left every other page reading blank until the app was
  // restarted, and naming more keys would only move the problem to whoever
  // forgets the next one. See notifySettingsResync.
  if (await notifySettingsResync()) return;
  const delay = REFRESH_RETRY_MS[attempt];
  if (delay === undefined) {
    console.warn('[companion] gave up refreshing workspaces after reconnect');
    return;
  }
  refreshRetry = setTimeout(() => void refreshCompanionData(attempt + 1), delay);
}

function setCompanionOnline(online: boolean) {
  if (companionOnline === online) return; // edge-triggered: reconnect churn is not news
  companionOnline = online;
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('companion:state', { online });
  }
  // Going online is the refresh. Going offline pushes NOTHING but the flag: a
  // degraded read returns an empty workspace list, and broadcasting that would
  // clear the renderer's good copy, which is the bug this exists to fix.
  if (online) void refreshCompanionData();
  else if (refreshRetry) { clearTimeout(refreshRetry); refreshRetry = null; }
}

function startLiveFeed() {
  if (feedAbort) return;
  let opened = false;
  const done = () => {
    feedAbort = null;
    setCompanionOnline(false);
    // Reconnect forever. Anything that happened while we were down was missed,
    // so the renderer re-reads its loaded chats once we're back.
    if (feedRetry) clearTimeout(feedRetry);
    feedBackoff = opened ? 1000 : Math.min(feedBackoff * 2, 30_000);
    feedRetry = setTimeout(startLiveFeed, feedBackoff);
  };
  const announceReconnect = () => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('chat:feedResync');
    }
  };
  try {
    feedAbort = api.stream('/events', (e) => {
      feedBackoff = 1000;
      // The companion changed a setting itself — `/voice` from the bot is the
      // first of these. Re-read and push a full snapshot; the event deliberately
      // carries no value, so there is one source of truth and one route to it.
      // Checked BEFORE the chatId bail below, which every non-chat event fails.
      if (e?.type === 'settings_changed') { void notifySettingsResync(); return; }
      if (!e?.chatId) return;
      // Our own runs already reach the renderer over IPC; the copy coming back
      // down the feed (we POST every one of them up) would double-render.
      //
      // Keyed on the event's ORIGIN MACHINE — `agent-core` stamps every event it
      // emits — not on whether the chat is running here right now. The running
      // test is a race it loses: `entry.running` flips false the instant
      // `session.prompt` resolves, while the echo of that same turn is still in
      // flight over HTTP. Everything that came back late sailed through and the
      // renderer drew the assistant's reply a second time (its `message_end`
      // opens a fresh bubble when no cursor is live). On a short turn the whole
      // exchange round-tripped after the flag cleared, so the entire reply
      // doubled. It looked like a stored duplicate and wasn't: re-opening the
      // chat re-read the rows and the copy vanished.
      if (e.machine && e.machine === os.hostname()) return;
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) w.webContents.send('agent:event', e);
      }
    }, done, () => {
      // Stream response arrived = the companion is reachable again. This used
      // to fire on the FIRST EVENT instead, so a quiet server (no chats
      // running) reconnected silently — chat resync stalled, and nothing could
      // hang off "the companion came back".
      opened = true;
      setCompanionOnline(true);
      announceReconnect();
      void onFeedOpen();
    });
  } catch {
    done(); // not configured yet — retry with backoff
  }
}

// The upgrade tag this session asked the companion to install, if any. The
// feed reconnects for lots of reasons (sleep/wake, network blips); only when
// this is set does a version match after a reconnect mean "the upgrade you
// started just landed" — worth a toast. In-memory only: quit before the server
// returns and the normal boot check reports the outcome instead.
let pendingUpgradeTag: string | null = null;

async function onFeedOpen() {
  if (!pendingUpgradeTag) return;
  try {
    const c = readApiConfig();
    if (!c.url || !c.apiKey) return;
    const h = await api.health(c.url, c.apiKey);
    if (h.ok && h.version && classifyVersions(app.getVersion(), h.version) === 'match') {
      pendingUpgradeTag = null;
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) w.webContents.send('api:companionUpdated', { version: h.version });
      }
    }
  } catch { /* still restarting — the next reconnect checks again */ }
}

function stopLiveFeed() {
  if (feedRetry) { clearTimeout(feedRetry); feedRetry = null; }
  if (feedAbort) { feedAbort(); feedAbort = null; }
}

// Provider + model lookups for the Settings UI. Pi-ai's `getProviders()` is
// the source of truth; we intersect with this allowlist so OAuth /
// multi-credential providers (bedrock, vertex, azure, cloudflare, copilot,
// codex) are filtered out — our settings schema only carries a single API
// key, which is insufficient for those.
//
// 'openai-compatible' is our own generic local/remote endpoint — pi-ai's
// registry doesn't know it, so inject it after the registry filter.
const INJECTED_PROVIDERS = ['openai-compatible'];
ipcMain.handle('agent:listProviders', () => {
  const fromPi = getProviders().filter((slug) => SUPPORTED_PROVIDER_SLUGS.has(slug as any));
  return [...new Set([...fromPi, ...INJECTED_PROVIDERS])].sort();
});

ipcMain.handle('agent:listModels', async (_evt, provider) => {
  if (!provider) return [];
  // openai-compatible has no static catalog — models come from the Validate
  // call (GET /v1/models) or are typed free-form. getCatalogModels returns []
  // here (models.dev doesn't carry it and pi has no such provider). Built-in
  // providers resolve through the models.dev catalog (live → cache → pi).
  const models = await getCatalogModels(provider);
  return models.map((m) => m.id);
});

// Thinking levels supported by the given (provider, model), for the Settings
// dropdown. Returns ['off'] for non-reasoning / unknown models — the UI hides
// the control when the list has a single entry.
ipcMain.handle('agent:listThinkingLevels', (_evt, { provider, model }) => {
  return listThinkingLevels(provider, model);
});

// Validate an OpenAI-compatible endpoint by hitting `{baseUrl}/models` — no
// inference, no tokens. Confirms reachability + key validity and returns the
// model list to populate the dropdown. Scoped to openai-compatible only: that
// path is uniform (the user types a /v1 baseUrl), whereas built-in cloud
// providers have non-uniform /models paths + auth and pi already supplies their
// model lists. Security: a 5s timeout (no hang), and we never echo upstream
// response bodies back to the renderer.
ipcMain.handle('agent:validateConnection', async (_evt, { baseUrl, apiKey, provider }) => {
  try {
    if (!baseUrl) return { ok: false, error: 'Base URL is required' };
    const base = String(baseUrl).replace(/\/+$/, '');
    // A typed key wins (testing before saving); otherwise fall back to the STORED
    // one. The renderer is never given key values, so its box is empty unless the
    // user is mid-edit — without this, testing a saved endpoint sent no key at all
    // and reported a 401 for a configuration that works.
    let key = apiKey;
    if (!key && provider) {
      const { settings } = await readSettingsSafe();
      key = settings.codingAgent?.providerKeys?.[provider] ?? '';
    }
    const headers: Record<string, string> = {};
    if (key) headers['Authorization'] = `Bearer ${key}`;

    const res = await fetch(`${base}/models`, { headers, signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status} ${res.statusText}` };
    const body: any = await res.json();
    const models = (body.data ?? body.models ?? [])
      .map((m: any) => m.id ?? m.name)
      .filter(Boolean);
    return { ok: true, models: models.length ? models : undefined };
  } catch (err: any) {
    if (err?.name === 'TimeoutError') return { ok: false, error: 'Connection timed out' };
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

function timestampForFilename(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    d.getFullYear() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

// Save a binary image alongside its associated note.
//   dirPath  — target directory (typically the dir of the active .md file)
//   bytes    — Uint8Array of the image bytes
//   ext      — file extension including leading dot, e.g. '.png'
//   baseName — optional preferred basename (without extension). If a file
//              with this name already exists, uniquePath will add " 1", " 2", ...
//              Falls back to a timestamped "Pasted image …" name when omitted.
ipcMain.handle('fs:writeImage', async (_evt, { dirPath, bytes, ext, baseName }) => {
  if (!dirPath) throw new Error('No target folder for image.');
  if (!ext || !ext.startsWith('.')) throw new Error('Invalid image extension.');
  const base = baseName && baseName.trim()
    ? baseName.trim()
    : `Pasted image ${timestampForFilename()}`;
  const target = await uniquePath(dirPath, base, ext);
  await fs.writeFile(target, Buffer.from(bytes));
  return target;
});

ipcMain.handle('fs:pathExists', async (_evt, p) => {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
});

// ---- workspace file watcher ----
//
// One watcher per app. Two responsibilities:
//   1. Coalesce per-path events into a 'fs:changed' stream for the renderer
//      (parses outgoing wiki-links so the renderer doesn't have to read every
//      changed file again).
//   2. Detect renames. Chokidar reports a rename as unlink(old)+add(new). We
//      pair these via the rename correlator using inode (primary) and content
//      hash (fallback for FAT/SMB-style filesystems where ino is unreliable),
//      so an external `mv` or an agent's `fs.rename` becomes a single
//      {type:'rename', oldPath, newPath} event the renderer can act on.
//
// Events are coalesced per-path within WATCH_DEBOUNCE_MS so a burst of writes
// collapses to one notification per path.

const WATCH_DEBOUNCE_MS = 150;
const RENAME_GRACE_MS = 800;   // how long we hold an unlink waiting for a possible add to pair with

let currentWatcher: any = null;
let bookmarksWatcher: any = null;       // dedicated watcher for .shockwave/bookmarks.json (main watcher ignores .shockwave)
let watcherRootDir: any = null;
let watcherWindowId: any = null;
let pendingByPath = new Map();    // path -> 'add' | 'change' | 'unlink'
let pendingTreeOnly = false;       // folder events or non-.md events
let flushTimer: any = null;
let correlator: any = null;             // createRenameCorrelator instance, reset per workspace
let watchDispatch: any = null;          // createWatcherDispatch instance, reset per workspace
let renameQueue: any[] = [];              // emitted rename events awaiting flush to renderer

function senderWindow() {
  if (watcherWindowId == null) return null;
  const win = BrowserWindow.fromId(watcherWindowId);
  return win && !win.isDestroyed() ? win : null;
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(flushWatcher, WATCH_DEBOUNCE_MS);
}

// Ship a 'rename' event with the new file's mtime + outgoingLinks so the
// renderer can: (1) re-key its link index, (2) refresh outgoing links if
// content changed during the move, (3) rewrite references in other files.
async function sendRename(win, oldPath, newPath) {
  try {
    const [content, stat] = await Promise.all([
      fs.readFile(newPath, 'utf8'),
      fs.stat(newPath),
    ]);
    win.webContents.send('fs:changed', {
      type: 'rename',
      oldPath,
      newPath,
      mtime: stat.mtimeMs,
      outgoingLinks: parseLinks(content),
    });
  } catch {
    // The new file may have been renamed/deleted again before we could read it.
    // Fall back to an unlink for the old path so the index doesn't drift.
    win.webContents.send('fs:changed', { type: 'unlink', path: oldPath });
  }
}

async function flushWatcher() {
  flushTimer = null;
  const win = senderWindow();
  const entries = [...pendingByPath.entries()];
  const treeOnly = pendingTreeOnly;
  const queuedRenames = renameQueue.splice(0);
  pendingByPath.clear();
  pendingTreeOnly = false;
  if (!win) return;

  // Renames first — the renderer needs to re-key paths before any subsequent
  // add/change/unlink for the new path arrives.
  for (const { oldPath, newPath } of queuedRenames) {
    await sendRename(win, oldPath, newPath);
  }

  for (const [p, type] of entries) {
    if (type === 'unlink') {
      win.webContents.send('fs:changed', { type: 'unlink', path: p });
      continue;
    }
    try {
      // Drawings and non-.md text files carry no wiki-links — stat for the
      // mtime only; the renderer re-reads the file itself when it reloads an
      // open canvas (drawing) or editor buffer (text).
      if (isDrawingFile(p) || isReloadableText(p)) {
        const stat = await fs.stat(p);
        win.webContents.send('fs:changed', { type, path: p, mtime: stat.mtimeMs });
        continue;
      }
      const [content, stat] = await Promise.all([
        fs.readFile(p, 'utf8'),
        fs.stat(p),
      ]);
      win.webContents.send('fs:changed', {
        type,                         // 'add' | 'change'
        path: p,
        mtime: stat.mtimeMs,
        outgoingLinks: parseLinks(content),
      });
    } catch (err: any) {
      // ENOENT = file was deleted between watcher event and read (expected
      // race). Anything else (permission denied, decode error) is worth
      // surfacing so users can investigate why their file isn't appearing.
      if (err?.code !== 'ENOENT') {
        console.warn('[watcher] flush read failed', p, err?.code ?? '', err?.message ?? err);
      }
    }
  }

  if (treeOnly && entries.length === 0 && queuedRenames.length === 0) {
    win.webContents.send('fs:changed', { type: 'tree' });
  }
}

// Wire the watcher -> correlator -> pendingByPath. The correlator emits one of
// 'add' | 'unlink' | 'rename'. The first two go through pendingByPath so they
// pick up the per-path coalescing behavior; 'rename' goes through renameQueue
// since it's already a paired event and shouldn't be merged with anything.
function setupCorrelator() {
  correlator = createRenameCorrelator({
    emit: (e) => {
      if (e.type === 'rename') {
        renameQueue.push(e);
        scheduleFlush();
      } else if (e.type === 'unlink') {
        pendingByPath.set(e.path, 'unlink');
        scheduleFlush();
      } else if (e.type === 'add') {
        // Preserve unlink->add merge semantic from the prior implementation:
        // an unlink immediately followed by an add for the same path is a change.
        const prev = pendingByPath.get(e.path);
        pendingByPath.set(e.path, prev === 'unlink' ? 'change' : 'add');
        scheduleFlush();
      }
    },
    graceMs: RENAME_GRACE_MS,
  });
  watchDispatch = createWatcherDispatch({
    correlator,
    isMdFile,
    isDrawingFile,
    isReloadableText,
    statPath: (p) => fs.stat(p, { bigint: true }).catch(() => null),
    hashFile: hashFileOf,
    walkMarkdown: walkMarkdownPaths,
    isIgnored: isIgnoredWatchPath,
    getPending: (p) => pendingByPath.get(p),
    setPending: (p, type) => { pendingByPath.set(p, type); scheduleFlush(); },
    markTreeOnly: () => { pendingTreeOnly = true; scheduleFlush(); },
  });
}

// `.excalidraw` drawings get content events too (so an open drawing reloads
// when the agent rewrites it), but they bypass the rename correlator — that's
// .md-only machinery for re-keying the basename link index, which drawings
// aren't part of. A drawing rename therefore surfaces as unlink+add, which is
// fine: drawings carry no backlinks to rewrite.
function isDrawingFile(p) { return /\.excalidraw$/i.test(p); }

// Skip any event under a dotfile segment (excludes .git / .obsidian /
// .shockwave). @parcel/watcher's `ignore` globs are a perf hint that keeps the
// native watcher from reporting these at all; this predicate is the
// authoritative filter in case a backend reports them anyway.
//
// Independent of the tree's "Show hidden files" toggle by design — that's a
// display setting. A visible .gitignore is still not something we watch, index,
// or reload the editor for.
function isIgnoredWatchPath(p) {
  if (!watcherRootDir) return true;
  const rel = path.relative(watcherRootDir, p);
  if (!rel || rel.startsWith('..')) return false;
  return rel.split(path.sep).some((seg) => isWatchIgnored(seg));
}

// @parcel/watcher hands the callback a batch of events. The mapping from that
// batch to correlator/pending-state updates lives in `watcherDispatch.ts` so
// main and the correlator tests exercise identical logic.
async function onParcelEvents(err, events) {
  if (err) {
    console.warn('[watcher] subscribe error', err?.message ?? err);
    return;
  }
  if (watchDispatch) await watchDispatch.handleBatch(events);
}

// Seed the correlator with current identity for every .md file in the
// workspace. Runs once on watchStart, before parcel delivers any events, so an
// unlink right after startup can still be correlated to its prior identity.
async function seedCorrelator(root) {
  const paths = await walkMarkdownPaths(root);
  await Promise.all(paths.map(async (p) => {
    const [ino, hash] = await Promise.all([statInoOf(p), hashFileOf(p)]);
    correlator.onPathSeen(p, ino, hash);
  }));
}

async function stopWatcher() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  pendingByPath.clear();
  pendingTreeOnly = false;
  renameQueue.length = 0;
  if (currentWatcher) {
    const w = currentWatcher;
    currentWatcher = null;
    try { await w.unsubscribe(); } catch { /* ignore teardown errors */ }
  }
  if (bookmarksWatcher) {
    const bw = bookmarksWatcher;
    bookmarksWatcher = null;
    try { await bw.unsubscribe(); } catch { /* ignore teardown errors */ }
  }
  correlator = null;
  watchDispatch = null;
  watcherRootDir = null;
  watcherWindowId = null;
}

ipcMain.handle('fs:watchStart', async (evt, dirPath) => {
  await stopWatcher();
  const win = BrowserWindow.fromWebContents(evt.sender);
  if (!win) return;
  watcherWindowId = win.id;
  watcherRootDir = dirPath;
  setupCorrelator();
  await seedCorrelator(dirPath);
  // @parcel/watcher is recursive and reports only changes after subscribe (no
  // initial scan), so seeding above is our only startup enumeration. The
  // `ignore` globs keep the native backend from reporting dotfile trees at all;
  // `isIgnoredWatchPath` in the callback is the authoritative backstop.
  currentWatcher = await parcelWatcher.subscribe(dirPath, onParcelEvents, {
    ignore: ['**/.*', '**/.*/**', '**/node_modules', '**/node_modules/**'],
  });

  // The main watcher ignores everything under `.shockwave/`, so changes to the
  // workspace file (sync pull, another machine, a hand edit) never reach the
  // renderer. Watch that dir separately and tell the renderer to re-read.
  // @parcel/watcher requires the directory to exist before subscribing, so
  // ensure it (it's created lazily on the first bookmarks/workspace write).
  const shockwaveDir = path.dirname(workspaceFilePath(dirPath));
  await fs.mkdir(shockwaveDir, { recursive: true }).catch(() => {});
  bookmarksWatcher = await parcelWatcher.subscribe(shockwaveDir, (err, events) => {
    if (err) return;
    const w = watcherWindowId != null ? BrowserWindow.fromId(watcherWindowId) : null;
    if (!w || w.isDestroyed()) return;
    for (const e of events) {
      if (path.basename(e.path) === 'workspace.json') { w.webContents.send('bookmarks:changed'); return; }
    }
  });
});

ipcMain.handle('fs:watchStop', stopWatcher);

app.on('before-quit', () => { stopWatcher(); stopLiveFeed(); agentDisposeAll().catch(() => {}); });

// Drain the sync engine before the process exits — let any in-flight git
// push/pull finish so we don't leave a partial commit on the remote.
//
// Settings writes no longer need draining here: the window-bounds save fired
// from `close` is a machine-local userData write (see api/localSettings), which
// is synchronous and committed by the time it returns — nothing in flight to a
// fast Cmd+Q. (Synced settings go to the companion, but window bounds isn't one
// of those.)
let cleanQuitting = false;
app.on('will-quit', (event) => {
  if (cleanQuitting) return;
  event.preventDefault();
  cleanQuitting = true;
  Promise.allSettled([
    engineDrainBeforeQuit(),
  ]).finally(() => app.exit());
});

ipcMain.handle('theme:getInitial', () => ({
  dark: nativeTheme.shouldUseDarkColors,
}));

nativeTheme.on('updated', () => {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('theme:systemChanged', {
      dark: nativeTheme.shouldUseDarkColors,
    });
  }
});

// Give the OAuth engine access to settings I/O (avoids a circular import back
// into this entry file). Must run before any oauth:* IPC or getFreshToken call.
// Token writes go straight to their own rows via settingsStore, so oauth.ts no
// longer needs a writeSettings dep.
initOAuth({ readSettings });


ipcMain.handle('cron:read', () => cronRead());
ipcMain.handle('cron:runNow', (_e, { name }) => cronRunNow(name));

// Build the desktop agent host. The secret getters re-read settings on every
// call so user-side edits are picked up mid-conversation. getToken returns a
// usable credential: static → the stored token; OAuth → a fresh access token
// (getFreshToken refreshes if expired), throwing a user-facing message for
// unknown names / connections needing reconnect.
initDesktopAgent({
  builtinDir: builtinSkillsDir(),
  // Both secret operations go through the companion (it owns getting + responding
  // to the agent): metadata from /agent-secrets, tokens from /agent-secret/:name/
  // token (which mints static or fresh-OAuth). The desktop never mints.
  getSecrets: () => api.get('/agent-secrets'),
  getToken: (name) => api.get(`/agent-secret/${encodeURIComponent(name)}/token`),
  // The same AssemblyAI key the microphone uses. Main holds it; only the
  // renderer's copy is stripped, and the agent runs here.
  getVoiceConfig: async () => voiceConfigOf((await readSettingsSafe())?.settings),
});

// Reclaim scratch dirs from chats nobody has touched lately — except pinned
// ones, which are kept whatever their age. Fire-and-forget: boot never waits on
// it, and reclaiming disk is never worth blocking startup.
//
// Both reads come from the companion, and a failure means we skip this launch
// rather than sweep on assumptions: `pinned` exists nowhere else, so an
// unreachable server can't be read as "nothing is pinned". The sweep runs once
// per launch, so skipping one costs a few directories a few hours.
void (async () => {
  const [pinned, { settings }] = await Promise.all([pinnedChatIds(), readSettingsSafe()]);
  sweepAgentScratch(settings?.codingAgent?.scratchTtlDays, new Set(pinned));
})().catch((e) => console.log('[agent] skipping scratch sweep:', e?.message ?? e));

// Bridge for the open-file pi extension: validate the agent's path against the
// active workspace, then ask the renderer to open it in a new tab. Confined to
// the workspace (the agent's cwd); only display-able types open. The extension
// (cwd) ext list must stay in sync with the renderer's isOpenable (MediaView).
const OPENABLE_RE = /\.(md|markdown|mdx|txt|text|log|org|rst|tex|bib|csv|tsv|json|jsonc|json5|ya?ml|toml|ini|cfg|conf|env|properties|xml|html?|css|scss|sass|less|js|mjs|cjs|jsx|ts|tsx|py|rb|go|rs|java|kt|kts|c|h|cpp|hpp|cc|hh|cs|php|swift|m|mm|sh|bash|zsh|fish|ps1|bat|sql|graphql|gql|lua|pl|pm|r|dart|vue|svelte|astro|clj|cljs|ex|exs|erl|hs|ml|scala|groovy|gradle|proto|diff|patch|png|jpe?g|gif|webp|bmp|ico|avif|mp4|webm|mov|m4v|ogv|ogg|excalidraw)$/i;
// Text files whose whole name is the type (.gitignore, .npmrc, …) — no
// extension for OPENABLE_RE to match. Mirror of the renderer's DOTFILE_TEXT_RE
// in MediaView; the agent's open_file must accept exactly what the tree opens.
const DOTFILE_TEXT_RE = /(^|[/\\])\.(gitignore|gitattributes|gitmodules|gitkeep|ignore|dockerignore|npmignore|editorconfig|npmrc|nvmrc|prettierrc|eslintrc|babelrc|env)$/i;
function isOpenablePath(p: string) { return OPENABLE_RE.test(p) || DOTFILE_TEXT_RE.test(p); }
// Openable files that are NOT reloadable-as-text: the .md family (link-index /
// correlator path), images, video, and .excalidraw drawings. Everything else in
// OPENABLE_RE is a text/code file the editor reloads on external change (mirrors
// the renderer's isTextFile in MediaView).
const NON_TEXT_OPENABLE_RE = /\.(md|markdown|mdx|png|jpe?g|gif|webp|bmp|ico|avif|mp4|webm|mov|m4v|ogv|ogg|excalidraw)$/i;
// Deliberately OPENABLE_RE only, not isOpenablePath: reload-on-external-change
// is the watcher's business, and the watcher never reports a dotfile path.
function isReloadableText(p: string) { return OPENABLE_RE.test(p) && !NON_TEXT_OPENABLE_RE.test(p); }
installOpenFileBridge(async (relPath) => {
  if (!watcherRootDir) return { ok: false, error: 'No workspace is open.' };
  if (typeof relPath !== 'string' || !relPath.trim()) return { ok: false, error: 'No path provided.' };
  // Tolerate a leading `[cwd]/` and leading slashes; resolve against the workspace.
  const rel = relPath.replace(/^\[cwd\]\/?/, '').replace(/^\/+/, '');
  const abs = path.resolve(watcherRootDir, rel);
  if (abs !== watcherRootDir && !abs.startsWith(watcherRootDir + path.sep)) {
    return { ok: false, error: 'Path is outside the workspace.' };
  }
  if (!isOpenablePath(abs)) {
    return { ok: false, error: 'Only text, image, video, or .excalidraw files can be opened.' };
  }
  try {
    const st = await fs.stat(abs);
    if (!st.isFile()) return { ok: false, error: 'Not a file.' };
  } catch {
    return { ok: false, error: `File not found: ${rel}` };
  }
  const win = senderWindow();
  if (!win) return { ok: false, error: 'App window is not available.' };
  win.webContents.send('agent:openFile', { path: abs });
  return { ok: true };
});

// Generate the CLI shims (firecrawl, playwright-cli) into <userData>/pi-agent/bin
// and put that dir on PATH so the agent's bash can invoke them by name. Runs
// every launch; failures are non-fatal (the agent simply won't find the CLIs).
(async () => {
  try {
    const binDir = path.join(app.getPath('userData'), 'pi-agent', 'bin');
    const { made } = await ensureCliShims({ cliToolsDir: cliToolsDir(), binDir, execPath: process.execPath });
    // BEFORE prependPath, and that ordering is the entire point. `binDir` is
    // writable by the agent (same user), and prependPath puts it FIRST — so from
    // the next line on, `spawn('git', …)` would run whatever the agent chose to
    // name `git`, with GITHUB_PAT in its environment. Resolve now, while PATH is
    // still the system's, and spawn the absolute path forever after. See gitBinary.ts.
    resolveGitBinary();
    prependPath(binDir);
    // Playwright downloads its browser into a user-writable cache (no root). Point
    // it at app userData so `playwright-cli install-browser` and `open` agree on
    // location. Inherited by pi's bash → the shim's electron-as-node child. The
    // browser is fetched lazily by the agent on first use (the skill instructs it),
    // so users who never touch Playwright never pay the ~77 MB download.
    process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(app.getPath('userData'), 'ms-playwright');
    if (made.length) console.log('[cli-tools] shims ready on PATH:', made.join(', '));
  } catch (err: any) {
    console.warn('[cli-tools] shim setup failed:', err?.message ?? err);
  }
})();

app.whenReady().then(async () => {
  protocol.handle('app', async (req) => {
    try {
      const url = new URL(req.url);
      // Chat images, served from the companion. The renderer can't fetch them
      // itself — the API key lives here — so it writes an <img src> and this
      // proxies. Immutable ids, so the response is cacheable and a re-opened
      // chat doesn't re-download every picture.
      if (url.host === 'attachment') {
        const id = decodeURIComponent(url.pathname).replace(/^\/+/, '');
        if (!id) return new Response('not found', { status: 404 });
        try {
          const upstream = await api.getRaw(`/attachment/${encodeURIComponent(id)}`);
          if (!upstream.ok) return new Response('not found', { status: upstream.status });
          return new Response(upstream.body, {
            status: 200,
            headers: {
              'Content-Type': upstream.headers.get('Content-Type') ?? 'application/octet-stream',
              'Cache-Control': 'public, max-age=31536000, immutable',
            },
          });
        } catch {
          // Companion away — the image is simply absent for now, not an error
          // worth breaking the chat over.
          return new Response('unavailable', { status: 503 });
        }
      }
      if (url.host !== 'media') return new Response('not found', { status: 404 });
      if (!watcherRootDir) return new Response('no vault', { status: 404 });
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      const abs = path.normalize(path.join(watcherRootDir, rel));
      const rootNorm = path.normalize(watcherRootDir);
      if (abs !== rootNorm && !abs.startsWith(rootNorm + path.sep)) {
        return new Response('forbidden', { status: 403 });
      }
      return await net.fetch(pathToFileURL(abs).toString());
    } catch {
      return new Response('error', { status: 500 });
    }
  });

  if (process.platform === 'darwin' && app.dock?.setIcon) {
    try {
      app.dock.setIcon(ICON_PATH);
    } catch {
      // ignore: icon file may not be present in some dev configurations
    }
  }
  // Point the models.dev catalog cache at userData (its offline fallback file).
  initModelCatalog(app.getPath('userData'));
  // Registered BEFORE anything makes a companion request. A stopped connection is
  // not an outage — the server is up and answering — so say so plainly and point
  // at the one screen that can resolve it. This used to sit AFTER startLiveFeed(),
  // whose first connection is usually the first stopped one, so the very first
  // notice went to nobody and no warning appeared at launch at all.
  onCertNeedsApproval((c) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('companion:cert-needs-approval', c);
    }
  });
  // Hold the companion's live feed open for the whole session, so a Telegram or
  // cron turn streams into the UI whether or not that chat is on screen.
  startLiveFeed();
  // One-time carry-over of a pre-sqlite `settings.json` into the `setting`
  // table. No-op once the table has rows. Must precede every settings read
  // below, or the app would boot on defaults and then persist over the import.
  try {
    await importLegacySettingsIfNeeded();
  } catch (err: any) {
    console.error('[settings] legacy import failed:', err?.message ?? err);
  }
  // Provision empty secret slots for enabled built-in skills BEFORE the window
  // opens, so the renderer hydrates with them present (no clobber race).
  await ensureBuiltinSecretSlots();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  // Update check: once shortly after launch (let the window mount + subscribe
  // first), then daily. Notify-only; failures are swallowed (offline is fine).
  setTimeout(() => { runUpdateCheck().catch(() => {}); }, 8000);
  setInterval(() => { runUpdateCheck().catch(() => {}); }, UPDATE_POLL_MS);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
