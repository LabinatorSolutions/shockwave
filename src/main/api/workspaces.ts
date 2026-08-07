// Workspace operations against the API (identity) + userData (this machine's
// checkout path + sync-toggle). Replaces the old db/index workspace functions.
// The API owns identity; the path/sync-toggle are machine-local.

import { api } from './client.js';
import { getWorkspaceLocal, setWorkspaceLocal, readLocalSettings, writeLocalSettings } from './localSettings.js';

export interface WsView {
  id: string; name: string; repoOwner: string; repoName: string; defaultBranch: string;
  path: string | null; syncEnabled: boolean;
}

async function identities(): Promise<any[]> {
  const rows = await api.get('/workspaces');
  return Array.isArray(rows) ? rows : [];
}

function view(id: any): WsView {
  const wl = getWorkspaceLocal(id.id);
  return {
    id: id.id, name: id.name, repoOwner: id.repoOwner, repoName: id.repoName,
    defaultBranch: id.defaultBranch ?? 'main', path: wl.path, syncEnabled: wl.syncEnabled,
  };
}

export async function getWorkspace(id: string): Promise<WsView | null> {
  const found = (await identities()).find((w) => w.id === id);
  return found ? view(found) : null;
}

export async function findWorkspaceByRepo(owner: string, repo: string): Promise<WsView | null> {
  const found = (await identities()).find(
    (w) => String(w.repoOwner).toLowerCase() === owner.toLowerCase() && String(w.repoName).toLowerCase() === repo.toLowerCase());
  return found ? view(found) : null;
}

export async function findWorkspaceByPath(path: string): Promise<WsView | null> {
  const local = readLocalSettings().workspaceLocal ?? {};
  const id = Object.keys(local).find((k) => local[k]?.path === path);
  return id ? getWorkspace(id) : null;
}

export async function isPathClaimed(path: string, exceptId?: string): Promise<boolean> {
  const local = readLocalSettings().workspaceLocal ?? {};
  return Object.keys(local).some((k) => local[k]?.path === path && k !== exceptId);
}

// Create: identity → API, checkout row → local.
export async function createWorkspace(w: {
  id: string; name: string; repoOwner: string; repoName: string; defaultBranch?: string; path: string;
}): Promise<void> {
  await api.post('/workspaces', {
    id: w.id, name: w.name, repoOwner: w.repoOwner, repoName: w.repoName, defaultBranch: w.defaultBranch ?? 'main',
  });
  setWorkspaceLocal(w.id, { path: w.path });
}

// The Telegram reply mode used to be set here, per workspace. It is an ordinary
// synced setting now (`speech.telegramReply`), so it rides `PATCH /settings` with
// everything else and needs nothing of its own — see agent-core/voiceReply.ts.

export async function removeWorkspace(id: string): Promise<void> {
  await api.del(`/workspaces/${encodeURIComponent(id)}`);
  const cur = readLocalSettings();
  if (cur.workspaceLocal?.[id]) { delete cur.workspaceLocal[id]; writeLocalSettings(cur); }
}

export function setUpHere(id: string, path: string): void {
  setWorkspaceLocal(id, { path });
}

export function forgetLocal(id: string): void {
  const cur = readLocalSettings();
  if (cur.workspaceLocal?.[id]) { delete cur.workspaceLocal[id]; writeLocalSettings(cur); }
}

export function setSyncEnabled(id: string, enabled: boolean): void {
  setWorkspaceLocal(id, { syncEnabled: enabled });
}
