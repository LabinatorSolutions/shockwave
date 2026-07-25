// The API's data layer — async Postgres port of the old core.ts. Every function
// takes the pool + the master key. Secrets are sealed/unsealed here; clients
// never see ciphertext. Parameterized SQL throughout.

import type { DB } from './db.js';
import { tx } from './db.js';
import type pg from 'pg';
import { seal, unseal } from './crypto.js';
import {
  isSettingsSecretKey, SETTINGS_SECRET_OWNER, AGENT_SECRET_FIELDS, isOAuthOwnedField,
  OAUTH_OWNED_COLUMNS, flattenInto, setPath, typeOf, encodeValue, decodeValue,
  isPlainObject, splitAgentSecret, joinAgentSecret,
} from './keys.js';

const KEY_VERSION = 1;
const now = () => Date.now();

type Runner = DB | pg.PoolClient;
const q = (r: Runner, text: string, params: any[] = []) => r.query(text, params);

// ── secret_value helpers ─────────────────────────────────────────────────────

async function putSecret(c: pg.PoolClient, key: Buffer, owner: string, field: string, plain: string) {
  if (!plain) {
    await q(c, 'DELETE FROM secret_value WHERE owner=$1 AND field=$2', [owner, field]);
    return;
  }
  const s = seal(key, plain);
  await q(c,
    `INSERT INTO secret_value (owner,field,ciphertext,iv,tag,key_version,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (owner,field) DO UPDATE SET
       ciphertext=EXCLUDED.ciphertext, iv=EXCLUDED.iv, tag=EXCLUDED.tag,
       key_version=EXCLUDED.key_version, updated_at=EXCLUDED.updated_at`,
    [owner, field, s.value, s.iv, s.tag, KEY_VERSION, now()]);
}

// owner -> { field: plaintext }
async function loadSecrets(pool: DB, key: Buffer): Promise<Map<string, Record<string, string>>> {
  const { rows } = await q(pool, 'SELECT owner,field,ciphertext,iv,tag FROM secret_value');
  const out = new Map<string, Record<string, string>>();
  for (const r of rows) {
    const bucket = out.get(r.owner) ?? {};
    bucket[r.field] = unseal(key, { value: r.ciphertext, iv: r.iv, tag: r.tag });
    out.set(r.owner, bucket);
  }
  return out;
}

// ── Narrow secret reads (agent tools) ────────────────────────────────────────

export async function getSecret(pool: DB, key: Buffer, owner: string, field: string): Promise<string> {
  const { rows } = await q(pool, 'SELECT ciphertext,iv,tag FROM secret_value WHERE owner=$1 AND field=$2', [owner, field]);
  if (!rows[0]) return '';
  return unseal(key, { value: rows[0].ciphertext, iv: rows[0].iv, tag: rows[0].tag });
}

export async function listSecretNames(pool: DB): Promise<Array<{ owner: string; field: string }>> {
  const { rows } = await q(pool, 'SELECT owner,field FROM secret_value');
  return rows.map((r: any) => ({ owner: r.owner, field: r.field }));
}

// Agent-secret metadata — no decryption. Shaped like the old joinAgentSecret
// minus the secret fields, so the desktop's list_agent_secrets renders unchanged.
export async function listAgentSecretMeta(pool: DB): Promise<any[]> {
  const { rows } = await q(pool, 'SELECT * FROM agent_secret ORDER BY created_at, name');
  return rows.map((r: any) => joinAgentSecret(camelRow(r), {}));
}

// ── Read the whole settings object (decrypted) ───────────────────────────────

export async function readSettings(pool: DB, key: Buffer): Promise<any> {
  const merged: any = {};
  const secrets = await loadSecrets(pool, key);

  const { rows: settingRows } = await q(pool, 'SELECT key,value,type FROM setting');
  for (const r of settingRows) setPath(merged, r.key, decodeValue(r.value, r.type));

  for (const [field, plain] of Object.entries(secrets.get(SETTINGS_SECRET_OWNER) ?? {})) {
    setPath(merged, field, plain);
  }

  const { rows: secretRows } = await q(pool, 'SELECT * FROM agent_secret ORDER BY created_at, name');
  merged.agentSecrets = secretRows.map((r: any) => joinAgentSecret(camelRow(r), secrets.get(r.name) ?? {}));

  const { rows: wsRows } = await q(pool,
    'SELECT id,name,repo_owner,repo_name,default_branch,sort_order FROM workspace ORDER BY sort_order');
  merged.workspaces = wsRows.map((r: any) => ({
    id: r.id, name: r.name, repoOwner: r.repo_owner, repoName: r.repo_name,
    defaultBranch: r.default_branch, sortOrder: r.sort_order,
  }));

  return merged;
}

// ── Write a settings patch ───────────────────────────────────────────────────

export async function writeSettings(pool: DB, key: Buffer, patch: any): Promise<any> {
  if (!patch || typeof patch !== 'object') return readSettings(pool, key);

  const flat = new Map<string, any>();
  let agentSecretsPatch: any[] | null = null;
  let providerKeysPatch: Record<string, any> | null = null;

  if (isPlainObject(patch['codingAgent.providerKeys'])) {
    providerKeysPatch = patch['codingAgent.providerKeys'];
    delete patch['codingAgent.providerKeys'];
  }
  for (const [k, value] of Object.entries(patch)) {
    if (k === 'agentSecrets') { agentSecretsPatch = Array.isArray(value) ? value : []; continue; }
    if (k === 'workspaces') continue; // identity via its own endpoint
    if (k === 'codingAgent' && isPlainObject(value)) {
      const { providerKeys, ...rest } = value as any;
      if (isPlainObject(providerKeys)) providerKeysPatch = providerKeys;
      flattenInto(k, rest, flat);
      continue;
    }
    flattenInto(k, value, flat);
  }

  await tx(pool, async (c) => {
    for (const [k, value] of flat) {
      if (isSettingsSecretKey(k)) {
        await putSecret(c, key, SETTINGS_SECRET_OWNER, k, typeof value === 'string' ? value : '');
        continue;
      }
      const type = typeOf(value);
      await q(c,
        `INSERT INTO setting (key,value,type,updated_at) VALUES ($1,$2,$3,$4)
         ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, type=EXCLUDED.type, updated_at=EXCLUDED.updated_at`,
        [k, encodeValue(value, type), type, now()]);
    }
    if (providerKeysPatch) await reconcileProviderKeys(c, key, providerKeysPatch);
    if (agentSecretsPatch) await writeAgentSecrets(c, key, agentSecretsPatch);
  });
  return readSettings(pool, key);
}

async function reconcileProviderKeys(c: pg.PoolClient, key: Buffer, map: Record<string, any>) {
  const prefix = 'codingAgent.providerKeys.';
  const keep = new Set(Object.keys(map).map((s) => `${prefix}${s}`));
  const { rows } = await q(c,
    'SELECT field FROM secret_value WHERE owner=$1 AND field LIKE $2', [SETTINGS_SECRET_OWNER, `${prefix}%`]);
  for (const r of rows) {
    if (!keep.has(r.field)) await q(c, 'DELETE FROM secret_value WHERE owner=$1 AND field=$2', [SETTINGS_SECRET_OWNER, r.field]);
  }
  for (const [slug, val] of Object.entries(map)) {
    await putSecret(c, key, SETTINGS_SECRET_OWNER, `${prefix}${slug}`, typeof val === 'string' ? val : '');
  }
}

async function writeAgentSecrets(c: pg.PoolClient, key: Buffer, list: any[]) {
  const keep = list.filter((s) => s?.name).map((s) => s.name as string);
  if (keep.length) {
    await q(c, `DELETE FROM agent_secret WHERE name <> ALL($1)`, [keep]);
    await q(c, `DELETE FROM secret_value WHERE owner <> ALL($1)`, [[...keep, SETTINGS_SECRET_OWNER]]);
  } else {
    await q(c, 'DELETE FROM agent_secret');
    await q(c, 'DELETE FROM secret_value WHERE owner <> $1', [SETTINGS_SECRET_OWNER]);
  }
  for (const entry of list) {
    if (!entry?.name) continue;
    const { row, secrets } = splitAgentSecret(entry);
    await q(c,
      `INSERT INTO agent_secret (name,description,kind,oauth_provider,oauth_client_id,oauth_auth_url,
         oauth_token_url,oauth_scopes,oauth_expires_at,oauth_status,oauth_account_email,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (name) DO UPDATE SET
         description=EXCLUDED.description, kind=EXCLUDED.kind, oauth_provider=EXCLUDED.oauth_provider,
         oauth_client_id=EXCLUDED.oauth_client_id, oauth_auth_url=EXCLUDED.oauth_auth_url,
         oauth_token_url=EXCLUDED.oauth_token_url, oauth_scopes=EXCLUDED.oauth_scopes, updated_at=EXCLUDED.updated_at`,
      [row.name, row.description, row.kind, row.oauthProvider, row.oauthClientId, row.oauthAuthUrl,
       row.oauthTokenUrl, row.oauthScopes, row.oauthExpiresAt, row.oauthStatus, row.oauthAccountEmail,
       row.createdAt || now(), now()]);
    for (const field of AGENT_SECRET_FIELDS) {
      if (isOAuthOwnedField(field)) continue;
      if (!(field in secrets)) continue;
      await putSecret(c, key, entry.name, field, (secrets as any)[field] ?? '');
    }
  }
}

// ── Targeted OAuth write (token exchange/refresh persist through here) ────────

export async function patchOAuth(pool: DB, key: Buffer, name: string, patch: Record<string, any>): Promise<void> {
  await tx(pool, async (c) => {
    const sets: string[] = ['updated_at=$2'];
    const vals: any[] = [name, now()];
    const add = (col: string, v: any) => { vals.push(v); sets.push(`${col}=$${vals.length}`); };
    if ('expiresAt' in patch) add('oauth_expires_at', patch.expiresAt ?? null);
    if ('status' in patch) add('oauth_status', patch.status ?? null);
    if ('accountEmail' in patch) add('oauth_account_email', patch.accountEmail ?? null);
    if ('provider' in patch) add('oauth_provider', patch.provider ?? null);
    if ('clientId' in patch) add('oauth_client_id', patch.clientId ?? null);
    if ('scopes' in patch) add('oauth_scopes', patch.scopes ? JSON.stringify(patch.scopes) : null);
    await q(c, `UPDATE agent_secret SET ${sets.join(', ')} WHERE name=$1`, vals);
    for (const [k, field] of [['accessToken', 'oauth.accessToken'], ['refreshToken', 'oauth.refreshToken'], ['clientSecret', 'oauth.clientSecret']] as const) {
      if (k in patch) await putSecret(c, key, name, field, patch[k] ?? '');
    }
  });
}

// ── Workspace identity ───────────────────────────────────────────────────────

export async function listWorkspaces(pool: DB) {
  const { rows } = await q(pool, 'SELECT id,name,repo_owner,repo_name,default_branch,sort_order FROM workspace ORDER BY sort_order');
  return rows.map((r: any) => ({ id: r.id, name: r.name, repoOwner: r.repo_owner, repoName: r.repo_name, defaultBranch: r.default_branch, sortOrder: r.sort_order }));
}

export async function upsertWorkspace(pool: DB, w: { id: string; name: string; repoOwner: string; repoName: string; defaultBranch?: string }) {
  await tx(pool, async (c) => {
    const { rows } = await q(c, 'SELECT COALESCE(MAX(sort_order),0) AS m FROM workspace');
    const next = Number(rows[0].m) + 1;
    await q(c,
      `INSERT INTO workspace (id,name,repo_owner,repo_name,default_branch,sort_order)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, repo_owner=EXCLUDED.repo_owner, repo_name=EXCLUDED.repo_name`,
      [w.id, w.name, w.repoOwner, w.repoName, w.defaultBranch ?? 'main', next]);
  });
}

export async function deleteWorkspace(pool: DB, id: string) {
  await q(pool, 'DELETE FROM workspace WHERE id=$1', [id]);
}

export async function updateWorkspaceOrder(pool: DB, list: Array<{ id: string; name: string }>) {
  await tx(pool, async (c) => {
    for (let i = 0; i < list.length; i++) {
      const w = list[i];
      if (!w?.id) continue;
      await q(c, 'UPDATE workspace SET name=$1, sort_order=$2 WHERE id=$3', [w.name ?? '', i + 1, w.id]);
    }
  });
}

// snake_case pg row -> camelCase for the joinAgentSecret shape.
function camelRow(r: any) {
  return {
    name: r.name, description: r.description, kind: r.kind,
    oauthProvider: r.oauth_provider, oauthClientId: r.oauth_client_id, oauthAuthUrl: r.oauth_auth_url,
    oauthTokenUrl: r.oauth_token_url, oauthScopes: r.oauth_scopes, oauthExpiresAt: r.oauth_expires_at,
    oauthStatus: r.oauth_status, oauthAccountEmail: r.oauth_account_email,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
