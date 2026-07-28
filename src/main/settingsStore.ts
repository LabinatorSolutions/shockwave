// Settings persistence — a thin facade over the Shockwave API (synced data) and
// a userData file (machine-local). Keeps its exported signatures, so callers in
// main.ts and oauth.ts are unchanged and the renderer still sees one flat
// `Settings` object.
//
// Synced (through the API, server holds the master key): codingAgent + provider
// keys, agentSecrets, sync.pat + interval, transcription, appearance, workspace
// IDENTITY. Machine-local (userData, never synced): window/view state, active
// workspace, cron, and each workspace's checkout path + sync-toggle.
//
// No local database, no fallback: connected → the server; unreachable throws,
// which the caller surfaces (the settings:read IPC degrades to defaults so boot
// survives an unconfigured/offline server).

import { BrowserWindow } from 'electron';
import { api } from './api/client.js';
import {
  isLocalKey, readLocalSettings, patchLocalSettings, getWorkspaceLocal, pruneWorkspaceLocal,
} from './api/localSettings.js';

// The ONLY defaults the desktop holds — for machine-local settings, which live in
// a userData file and never touch the DB. DB settings have NO desktop defaults:
// the companion is the source of truth, and what it returns IS the value. A DB
// setting is either set (a row exists) or unset (no row); nothing here invents
// one, so the desktop can never show a value the DB — and every other reader
// (Telegram, cron) — doesn't have. That mismatch was the provider bug.
const LOCAL_KEYS = ['windowBounds', 'sidebarWidth', 'chatSidebarWidth', 'chatSidebarOpen', 'viewMode', 'treeSortOrder', 'bookmarkFilterActive', 'cron'] as const;
const LOCAL_DEFAULTS: Record<(typeof LOCAL_KEYS)[number], any> = {
  windowBounds: null,
  sidebarWidth: 260,
  chatSidebarWidth: 360,
  chatSidebarOpen: false,
  viewMode: 'live',
  treeSortOrder: 'name-asc',
  bookmarkFilterActive: false,
  cron: { enabled: false, maxCatchupHours: 36, maxRunMinutes: 30 },
};

// Broadcasts changed top-level keys + a fresh read to the renderer, for
// main-initiated writes (OAuth refresh, window bounds, cron).
async function emitChanged(keys: string[]) {
  if (!keys.length) return;
  try {
    const settings = await readSettings();
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('settings:changed', { keys, settings });
    }
  } catch (err: any) {
    console.warn('[settings] could not emit change event:', err?.message ?? err);
  }
}

// Overlay the machine-local settings (userData file) onto the DB settings. Each
// local key takes its file value if present, else its local default. This is the
// only place defaults are applied, and only for local keys — never DB settings.
function overlayLocal(merged: any, identities: any[]) {
  const local = readLocalSettings();
  for (const k of LOCAL_KEYS) {
    (merged as any)[k] = (local as any)[k] !== undefined ? (local as any)[k] : LOCAL_DEFAULTS[k];
  }
  merged.activeWorkspaceId = local.activeWorkspaceId ?? null;
  pruneWorkspaceLocal(identities.map((w: any) => w.id));
  merged.workspaces = identities.map((w: any) => {
    const wl = getWorkspaceLocal(w.id);
    return { id: w.id, name: w.name, path: wl.path, repo: `${w.repoOwner}/${w.repoName}`, syncEnabled: wl.syncEnabled };
  });
  return merged;
}

// DB settings from the companion (the source of truth) + machine-local from
// userData. Returns exactly what the companion holds — no default layer, so an
// unset DB value reads as unset, not faked. THROWS if the server is unreachable;
// the caller (settings:read IPC) degrades via readSettingsSafe for boot.
export async function readSettings(): Promise<any> {
  const synced = await api.get('/settings');
  const identities = Array.isArray(synced?.workspaces) ? synced.workspaces : [];
  const rest: any = { ...synced }; delete rest.workspaces;
  return overlayLocal(rest, identities);
}

// Boot/UI-safe read: never throws. On an unconfigured/offline server there are no
// DB settings to us, so it returns only the machine-local settings (which need no
// server) and the app boots to a "connect your companion" state.
export async function readSettingsSafe(): Promise<{ settings: any; online: boolean }> {
  try {
    return { settings: await readSettings(), online: true };
  } catch {
    return { settings: overlayLocal({}, []), online: false };
  }
}

// Split the patch: machine-local → userData; workspaces → identity endpoint;
// everything else → the API. A synced write throws if the server is unreachable.
export async function writeSettings(patch: any, opts: { notify?: boolean } = {}): Promise<void> {
  if (!patch || typeof patch !== 'object') return;
  const local: Record<string, any> = {};
  const synced: Record<string, any> = {};
  let workspacesPatch: any[] | null = null;
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'activeWorkspaceId') { local.activeWorkspaceId = typeof v === 'string' ? v : null; continue; }
    if (k === 'workspaces') { workspacesPatch = Array.isArray(v) ? v : []; continue; }
    (isLocalKey(k) ? local : synced)[k] = v;
  }
  if (Object.keys(local).length) patchLocalSettings(local);
  if (workspacesPatch) await api.patch('/workspaces', workspacesPatch);
  if (Object.keys(synced).length) await api.patch('/settings', synced);
  if (opts.notify !== false) await emitChanged(Object.keys(patch));
}

export async function patchAgentSecretOAuth(name: string, patch: Record<string, any>): Promise<void> {
  await api.post(`/oauth/${encodeURIComponent(name)}`, patch);
  await emitChanged(['agentSecrets']);
}

export async function notifyWorkspacesChanged(): Promise<void> {
  await emitChanged(['workspaces', 'activeWorkspaceId']);
}

// Obsolete — data lives on the server now. No-op so the boot call site is unchanged.
export async function importLegacySettingsIfNeeded(): Promise<boolean> {
  return false;
}
