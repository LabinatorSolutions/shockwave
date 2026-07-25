// One-time migration: read the existing local SQLite (secrets decrypted with
// this machine's master key) and push everything to the API. Idempotent-ish —
// re-running re-PATCHes the same values. Runs inside the desktop (it needs
// safeStorage + the local DB), triggered by the api:migrate IPC.
//
// Uses the still-present db/index + masterKey directly rather than the rewired
// settingsStore. Machine-local bits (checkout path, active workspace, window
// state) stay local — this only moves the shared, synced data.

import { getDb } from '../db/index.js';
import { setting, agentSecret, secretValue, workspace, workspaceLocal } from '../db/schema.js';
import { unseal } from '../masterKey.js';
import { setPath, decodeValue, joinAgentSecret } from '../settingsKeys.js';
import { setWorkspaceLocal } from './localSettings.js';
import { api } from './client.js';

export async function migrateSqliteToApi(): Promise<{ ok: boolean; workspaces: number; agentSecrets: number; error?: string }> {
  try {
    const db = getDb();

    // secrets: owner -> { field: plaintext }
    const secrets = new Map<string, Record<string, string>>();
    for (const r of db.select().from(secretValue).all() as any[]) {
      const b = secrets.get(r.owner) ?? {};
      b[r.field] = unseal({ value: r.ciphertext, iv: r.iv as Buffer, tag: r.tag as Buffer });
      secrets.set(r.owner, b);
    }

    // Assemble a settings patch from the setting rows + settings-owned secrets.
    const patch: any = {};
    for (const r of db.select().from(setting).all() as any[]) setPath(patch, r.key, decodeValue(r.value, r.type));
    for (const [field, plain] of Object.entries(secrets.get('settings') ?? {})) setPath(patch, field, plain);

    // agentSecrets: entity rows + their credential fields.
    const agentSecrets = (db.select().from(agentSecret).all() as any[])
      .map((row) => joinAgentSecret(row, secrets.get(row.name) ?? {}));
    patch.agentSecrets = agentSecrets;

    // Push settings (codingAgent incl. providerKeys, sync.pat, transcription,
    // appearance, agentSecrets). Machine-local keys aren't in the SQLite settings
    // table meaningfully; the API ignores anything it doesn't own.
    await api.patch('/settings', patch);

    // Workspaces: identity → API, checkout path → local.
    const rows = db.select().from(workspace).all() as any[];
    for (const w of rows) {
      await api.post('/workspaces', {
        id: w.id, name: w.name, repoOwner: w.repoOwner, repoName: w.repoName, defaultBranch: w.defaultBranch ?? 'main',
      });
    }
    // The local checkout paths come from the old workspace_local table.
    for (const wl of db.select().from(workspaceLocal).all() as any[]) {
      if (wl.path) setWorkspaceLocal(wl.workspaceId, { path: wl.path, syncEnabled: !wl.syncDisabled });
    }

    return { ok: true, workspaces: rows.length, agentSecrets: agentSecrets.length };
  } catch (err: any) {
    return { ok: false, workspaces: 0, agentSecrets: 0, error: err?.message ?? String(err) };
  }
}
