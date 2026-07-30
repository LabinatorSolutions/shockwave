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
// WHICH fields are credentials is declared once, in agent-core — the only code
// bundled into both this build and the companion's. See agent-core/credentials.js.
import {
  SETTINGS_CREDENTIALS, AGENT_SECRET_CREDENTIALS,
  getPath, deletePath, setPathCopy, isSet,
} from '../../agent-core/credentials.js';

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
  chatSidebarOpen: true,
  viewMode: 'live',
  treeSortOrder: 'name-asc',
  bookmarkFilterActive: false,
  cron: { enabled: false, maxCatchupHours: 36, maxRunMinutes: 30 },
};

/**
 * Strip every credential, replacing each with a "is one saved?" flag.
 *
 * Applied at the ONLY two places settings cross into the renderer — the
 * `settings:read` IPC and the `settings:changed` push. Main itself keeps the real
 * values: it needs them to run the agent, push to GitHub, and mint the voice
 * token. This is the main→renderer hop, not companion→main.
 *
 * The renderer never used the values for anything but painting them into a box, so
 * nothing loses a capability. What it loses is the ability to send one back — and
 * that was the actual hazard: it held every key and resent them on unrelated
 * edits, so any stale copy could overwrite the real thing.
 *
 * `has*` flags are what the boxes render dots from. A flag is not a secret.
 */
function stripCredentials(settings: any): any {
  if (!settings || typeof settings !== 'object') return settings;
  let out: any = { ...settings };

  for (const c of SETTINGS_CREDENTIALS) {
    const value = getPath(out, c.path);
    if (c.wildcard) {
      // An open-ended map (provider slug -> key). The flag is a map too, so the
      // box can show dots for whichever provider is selected.
      const flags = Object.fromEntries(
        Object.entries((value ?? {}) as Record<string, unknown>)
          .filter(([, v]) => isSet(v))
          .map(([k]) => [k, true]),
      );
      out = setPathCopy(deletePath(out, c.path), parentOf(c.path, c.flag), flags);
    } else {
      out = setPathCopy(deletePath(out, c.path), parentOf(c.path, c.flag), isSet(value));
    }
  }

  if (Array.isArray(out.agentSecrets)) {
    out.agentSecrets = out.agentSecrets.map((entry: any) => {
      let next: any = { ...entry };
      for (const c of AGENT_SECRET_CREDENTIALS) {
        // accessToken/refreshToken get a flag too, though nothing renders them —
        // the point is that they leave, not that they're reported.
        next = setPathCopy(deletePath(next, c.path), parentOf(c.path, c.flag), isSet(getPath(next, c.path)));
      }
      return next;
    });
  }

  return out;
}

/** `a.b.c` + flag `hasC` -> `a.b.hasC`. Keeps a flag beside the value it replaces. */
function parentOf(path: string, flag: string): string {
  const parts = path.split('.');
  parts[parts.length - 1] = flag;
  return parts.join('.');
}

// Broadcasts changed top-level keys + a fresh read to the renderer, for
// main-initiated writes (OAuth refresh, window bounds, cron). Credentials are
// stripped — this is one of the two doors to the renderer.
// Returns whether the broadcast actually went out. A failed read means the
// companion is unreachable, and the ONLY safe response is to send nothing: the
// degraded read returns an empty workspace list, so broadcasting it would clear
// the renderer's good copy. Callers that need the push to land (the
// became-reachable refresh in main.ts) retry on `false`.
async function emitChanged(keys: string[]): Promise<boolean> {
  if (!keys.length) return false;
  try {
    const settings = stripCredentials(await readSettings());
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('settings:changed', { keys, settings });
    }
    return true;
  } catch (err: any) {
    console.warn('[settings] could not emit change event:', err?.message ?? err);
    return false;
  }
}

/**
 * The renderer's copy: real settings, no credentials. The other door is
 * `emitChanged` above.
 *
 * THIS IS THE ONLY READ AN IPC HANDLER MAY RETURN. `readSettings` and
 * `readSettingsSafe` carry live credentials — they exist for main's own use (the
 * agent, git, the voice token) and returning either from a handler leaks every key
 * you have to the screen. That distinction lived in a comment, which is the same
 * shape of mistake as the certificate check that "trusted anyway": a policy nobody
 * enforces. `tests/rendererSettingsDoor.test.js` now asserts it by scanning
 * main.ts, so a new handler that reaches for the wrong one fails the suite.
 */
export async function readSettingsForRenderer(): Promise<{ settings: any; online: boolean; reason?: string }> {
  const r = await readSettingsSafe();
  return { ...r, settings: stripCredentials(r.settings) };
}

// Overlay the machine-local settings (userData file) onto the DB settings. Each
// local key takes its file value if present, else its local default. This is the
// only place defaults are applied, and only for local keys — never DB settings.
function overlayLocal(merged: any, identities: any[], opts: { authoritative?: boolean } = {}) {
  const local = readLocalSettings();
  for (const k of LOCAL_KEYS) {
    (merged as any)[k] = (local as any)[k] !== undefined ? (local as any)[k] : LOCAL_DEFAULTS[k];
  }
  merged.activeWorkspaceId = local.activeWorkspaceId ?? null;
  // Prune ONLY against a list we actually received. `identities` is [] on the
  // degraded path (readSettingsSafe, when the companion is unreachable or its
  // certificate isn't approved) — and pruning against [] deletes every
  // workspace's checkout path from local-settings.json AND WRITES THE FILE. One
  // network blip at boot and the paths are gone for good: the workspaces still
  // exist on the companion, so the app shows them with no path and every one has
  // to be re-located by hand via "Set up here".
  //
  // An empty list from a SUCCESSFUL read is different — that genuinely means no
  // workspaces, and pruning is right. The two cases are indistinguishable from
  // the array alone, which is exactly why this is a flag and not a length check.
  if (opts.authoritative) pruneWorkspaceLocal(identities.map((w: any) => w.id));
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
  // The companion answered, so this list is the truth — safe to prune against.
  return overlayLocal(rest, identities, { authoritative: true });
}

// Boot/UI-safe read: never throws. On an unconfigured/offline server there are no
// DB settings to us, so it returns only the machine-local settings (which need no
// server) and the app boots to a "connect your companion" state.
// `reason` carries WHY the read failed, so a caller can report the real cause
// instead of inventing one. Without it, an unreachable or un-approved companion
// surfaced as "Connect a GitHub account first" or "Voice transcription not
// configured" — both false, and both sending the user to fix the wrong thing.
export async function readSettingsSafe(): Promise<{ settings: any; online: boolean; reason?: string }> {
  try {
    return { settings: await readSettings(), online: true };
  } catch (err: any) {
    return { settings: overlayLocal({}, []), online: false, reason: err?.message ?? String(err) };
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
  // Root segments, not the raw keys. A patch may be dotted (`sync.pat`, how a
  // credential delete addresses one leaf without republishing its siblings) and the
  // renderer applies changed TOP-LEVEL keys — so emitting the dotted key notifies
  // nothing and the screen keeps showing a credential that is no longer stored.
  if (opts.notify !== false) await emitChanged([...new Set(Object.keys(patch).map((k) => k.split('.')[0]))]);
}

export async function patchAgentSecretOAuth(name: string, patch: Record<string, any>): Promise<void> {
  await api.post(`/oauth/${encodeURIComponent(name)}`, patch);
  await emitChanged(['agentSecrets']);
}

/** @returns whether the push landed — see `emitChanged`. */
export async function notifyWorkspacesChanged(): Promise<boolean> {
  return emitChanged(['workspaces', 'activeWorkspaceId']);
}

// Obsolete — data lives on the server now. No-op so the boot call site is unchanged.
export async function importLegacySettingsIfNeeded(): Promise<boolean> {
  return false;
}
