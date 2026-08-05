// Machine-local settings — the stuff that was in the local DB's machine columns,
// now a plain userData file (never synced). Window/view state, which workspace is
// open here, and each workspace's local checkout path + sync-toggle.
//
// The per-workspace map is PRUNED on read against the current identity list, so a
// workspace deleted elsewhere can't leave orphan local state (the old
// disabledWorkspaceIds bug). Everything here is scalar/JSON — no relations — so a
// file is the right home.

import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

// The machine-local settings, declared ONCE: key → the value the renderer sees
// when the file has none. Two things derive from this and must never be listed
// separately, because both failures are silent — a key with routing but no
// default reads as `undefined` on a fresh machine, and a key with a default but
// no routing gets PATCHed to the companion (so it syncs across machines, and the
// write throws while the companion is unreachable).
//
//   LOCAL_KEYS  — write routing: a settings patch naming one of these is written
//                 here, everything else goes to the API.
//   overlayLocal (settingsStore.ts) — stamps these onto every settings read.
//
// Same discipline as agent-core/credentials.ts: one declaration, derived uses.
export const LOCAL_SETTINGS: Record<string, any> = {
  windowBounds: null,
  sidebarWidth: 260,
  chatSidebarWidth: 360,
  chatSidebarOpen: true,
  viewMode: 'live',
  treeSortOrder: 'name-asc',
  bookmarkFilterActive: false,
  showHiddenFiles: false,
  chatSources: null,
  activeWorkspaceId: null,
  // workspaceId -> { paths, active }. Which files were open when you quit.
  // Machine-local because a checkout is: the same workspace on another machine
  // has its own window, its own screen, and its own idea of what you were doing.
  openTabs: {},
};

export const LOCAL_KEYS = Object.keys(LOCAL_SETTINGS);

export function isLocalKey(key: string): boolean {
  return LOCAL_KEYS.some((k) => key === k || key.startsWith(`${k}.`));
}

export interface LocalSettings {
  windowBounds?: any;
  sidebarWidth?: number;
  chatSidebarWidth?: number;
  chatSidebarOpen?: boolean;
  viewMode?: string;
  treeSortOrder?: string;
  bookmarkFilterActive?: boolean;
  showHiddenFiles?: boolean;
  chatSources?: string[] | null;
  activeWorkspaceId?: string | null;
  openTabs?: Record<string, { paths: string[]; active: string | null }>;
  /** Update version whose toast the user dismissed. Machine-local because
   *  installing an update is a per-machine act. Not in LOCAL_KEYS — the renderer
   *  never patches it through a settings save; app:snoozeUpdate writes it. */
  updateSnoozedVersion?: string | null;
  // workspaceId -> { path, syncEnabled }
  workspaceLocal?: Record<string, { path?: string | null; syncEnabled?: boolean }>;
}

function file(): string {
  return path.join(app.getPath('userData'), 'local-settings.json');
}

export function readLocalSettings(): LocalSettings {
  try { return JSON.parse(fs.readFileSync(file(), 'utf8')); }
  catch { return {}; }
}

export function writeLocalSettings(next: LocalSettings): void {
  const f = file();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
  fs.renameSync(tmp, f);
}

// Merge a machine-local patch (dotted keys) into the file.
export function patchLocalSettings(patch: Record<string, any>): void {
  const cur = readLocalSettings();
  for (const [k, v] of Object.entries(patch)) setDotted(cur, k, v);
  writeLocalSettings(cur);
}

// The per-workspace machine bits.
export function getWorkspaceLocal(id: string): { path: string | null; syncEnabled: boolean } {
  const wl = readLocalSettings().workspaceLocal?.[id];
  return { path: wl?.path ?? null, syncEnabled: wl?.syncEnabled ?? true };
}

export function setWorkspaceLocal(id: string, patch: { path?: string | null; syncEnabled?: boolean }): void {
  const cur = readLocalSettings();
  cur.workspaceLocal = cur.workspaceLocal ?? {};
  cur.workspaceLocal[id] = { ...cur.workspaceLocal[id], ...patch };
  writeLocalSettings(cur);
}

// Drop workspaceLocal entries for ids not in `keepIds`. Returns true if it wrote.
export function pruneWorkspaceLocal(keepIds: string[]): boolean {
  const cur = readLocalSettings();
  if (!cur.workspaceLocal) return false;
  const keep = new Set(keepIds);
  let changed = false;
  for (const id of Object.keys(cur.workspaceLocal)) {
    if (!keep.has(id)) { delete cur.workspaceLocal[id]; changed = true; }
  }
  if (changed) writeLocalSettings(cur);
  return changed;
}

function setDotted(root: any, dotted: string, value: any) {
  const parts = dotted.split('.');
  let node = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (!node[p] || typeof node[p] !== 'object') node[p] = {};
    node = node[p];
  }
  node[parts[parts.length - 1]] = value;
}
