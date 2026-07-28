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

export const DEFAULT_SETTINGS = {
  workspaces: [],
  activeWorkspaceId: null,
  appearance: { themeMode: 'system', hideLineNumbers: false, treePanel: { content: 'off', count: 10 } },
  codingAgent: { provider: 'anthropic', model: 'claude-sonnet-4-5', providerKeys: {}, baseUrl: '', thinkingLevel: 'medium' },
  agentSecrets: [],
  transcription: { provider: 'assemblyai', apiKey: '' },
  sync: { pat: '', pullIntervalSeconds: 10 },
  timezone: 'UTC',
  cron: { enabled: false, maxCatchupHours: 36, maxRunMinutes: 30 },
  chatSidebarOpen: false,
  chatSidebarWidth: 360,
  sidebarWidth: 260,
  viewMode: 'live',
  treeSortOrder: 'name-asc',
  bookmarkFilterActive: false,
  windowBounds: null,
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

function isObj(v: any): boolean { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function deepMerge(base: any, over: any) {
  for (const [k, v] of Object.entries(over ?? {})) {
    if (isObj(v) && isObj(base[k])) deepMerge(base[k], v);
    else base[k] = v;
  }
}

// Merge the machine-local overlay onto a base settings object.
function overlayLocal(merged: any, identities: any[]) {
  const local = readLocalSettings();
  for (const k of ['windowBounds', 'sidebarWidth', 'chatSidebarWidth', 'chatSidebarOpen', 'viewMode', 'treeSortOrder', 'bookmarkFilterActive', 'cron'] as const) {
    if ((local as any)[k] !== undefined) (merged as any)[k] = (local as any)[k];
  }
  merged.activeWorkspaceId = local.activeWorkspaceId ?? null;
  pruneWorkspaceLocal(identities.map((w: any) => w.id));
  merged.workspaces = identities.map((w: any) => {
    const wl = getWorkspaceLocal(w.id);
    return { id: w.id, name: w.name, path: wl.path, repo: `${w.repoOwner}/${w.repoName}`, syncEnabled: wl.syncEnabled };
  });
  return merged;
}

// Synced from the API + machine-local from userData. THROWS if the server is
// unreachable — the caller (settings:read IPC) degrades to defaults for boot.
export async function readSettings(): Promise<any> {
  const merged: any = structuredClone(DEFAULT_SETTINGS);
  const synced = await api.get('/settings');
  const identities = Array.isArray(synced?.workspaces) ? synced.workspaces : [];
  const rest = { ...synced }; delete rest.workspaces;
  deepMerge(merged, rest);
  return overlayLocal(merged, identities);
}

// Boot/UI-safe read: never throws. On an unconfigured/offline server it returns
// DEFAULT_SETTINGS (+ machine-local, which needs no server) so the app still
// boots and can show a "connect your server" state.
export async function readSettingsSafe(): Promise<{ settings: any; online: boolean }> {
  try {
    return { settings: await readSettings(), online: true };
  } catch {
    const merged: any = structuredClone(DEFAULT_SETTINGS);
    return { settings: overlayLocal(merged, []), online: false };
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
