// The API's data layer — drizzle over Postgres. Every function takes the drizzle
// `Db` + (for secret ops) the master key. Secrets are sealed/unsealed here;
// clients never see ciphertext.

import type { Db } from './db.js';
import { seal, unseal } from './crypto.js';
import {
  isSettingsSecretKey, SETTINGS_SECRET_OWNER, AGENT_SECRET_FIELDS, isOAuthOwnedField,
  flattenInto, setPath, typeOf, encodeValue, decodeValue,
  isPlainObject, splitAgentSecret, joinAgentSecret,
} from './keys.js';
import {
  workspace, setting, agentSecret, secretValue, chatSession, chatTranscript, message,
} from './schema.js';
import { and, eq, ne, lt, desc, asc, ilike, like, sql, notInArray } from 'drizzle-orm';

const KEY_VERSION = 1;
const now = () => Date.now();

// A drizzle transaction context has the same query API as the top-level db, so
// helpers accept either.
type Tx = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

// ── secret_value helpers ─────────────────────────────────────────────────────

async function putSecret(c: Tx, key: Buffer, owner: string, field: string, plain: string) {
  if (!plain) {
    await c.delete(secretValue).where(and(eq(secretValue.owner, owner), eq(secretValue.field, field)));
    return;
  }
  const s = seal(key, plain);
  await c.insert(secretValue)
    .values({ owner, field, ciphertext: s.value, iv: s.iv, tag: s.tag, keyVersion: KEY_VERSION, updatedAt: now() })
    .onConflictDoUpdate({
      target: [secretValue.owner, secretValue.field],
      set: { ciphertext: s.value, iv: s.iv, tag: s.tag, keyVersion: KEY_VERSION, updatedAt: now() },
    });
}

// owner -> { field: plaintext }
async function loadSecrets(db: Db, key: Buffer): Promise<Map<string, Record<string, string>>> {
  const rows = await db.select().from(secretValue);
  const out = new Map<string, Record<string, string>>();
  for (const r of rows) {
    const bucket = out.get(r.owner) ?? {};
    bucket[r.field] = unseal(key, { value: r.ciphertext, iv: r.iv, tag: r.tag });
    out.set(r.owner, bucket);
  }
  return out;
}

// ── Narrow secret reads (agent tools) ────────────────────────────────────────

export async function getSecret(db: Db, key: Buffer, owner: string, field: string): Promise<string> {
  const rows = await db.select({ ciphertext: secretValue.ciphertext, iv: secretValue.iv, tag: secretValue.tag })
    .from(secretValue).where(and(eq(secretValue.owner, owner), eq(secretValue.field, field)));
  if (!rows[0]) return '';
  return unseal(key, { value: rows[0].ciphertext, iv: rows[0].iv, tag: rows[0].tag });
}

export async function listSecretNames(db: Db): Promise<Array<{ owner: string; field: string }>> {
  const rows = await db.select({ owner: secretValue.owner, field: secretValue.field }).from(secretValue);
  return rows.map((r) => ({ owner: r.owner, field: r.field }));
}

// Agent-secret metadata — no decryption.
export async function listAgentSecretMeta(db: Db): Promise<any[]> {
  const rows = await db.select().from(agentSecret).orderBy(asc(agentSecret.createdAt), asc(agentSecret.name));
  return rows.map((r) => joinAgentSecret(r, {}));
}

// ── Read the whole settings object (decrypted) ───────────────────────────────

export async function readSettings(db: Db, key: Buffer): Promise<any> {
  const merged: any = {};
  const secrets = await loadSecrets(db, key);

  const settingRows = await db.select({ key: setting.key, value: setting.value, type: setting.type }).from(setting);
  for (const r of settingRows) setPath(merged, r.key, decodeValue(r.value, r.type));

  for (const [field, plain] of Object.entries(secrets.get(SETTINGS_SECRET_OWNER) ?? {})) {
    setPath(merged, field, plain);
  }

  const secretRows = await db.select().from(agentSecret).orderBy(asc(agentSecret.createdAt), asc(agentSecret.name));
  merged.agentSecrets = secretRows.map((r) => joinAgentSecret(r, secrets.get(r.name) ?? {}));

  merged.workspaces = await listWorkspaces(db);
  return merged;
}

// ── Write a settings patch ───────────────────────────────────────────────────

export async function writeSettings(db: Db, key: Buffer, patch: any): Promise<any> {
  if (!patch || typeof patch !== 'object') return readSettings(db, key);

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

  await db.transaction(async (c) => {
    for (const [k, value] of flat) {
      if (isSettingsSecretKey(k)) {
        await putSecret(c, key, SETTINGS_SECRET_OWNER, k, typeof value === 'string' ? value : '');
        continue;
      }
      const type = typeOf(value);
      await c.insert(setting)
        .values({ key: k, value: encodeValue(value, type), type, updatedAt: now() })
        .onConflictDoUpdate({ target: setting.key, set: { value: encodeValue(value, type), type, updatedAt: now() } });
    }
    if (providerKeysPatch) await reconcileProviderKeys(c, key, providerKeysPatch);
    if (agentSecretsPatch) await writeAgentSecrets(c, key, agentSecretsPatch);
  });
  return readSettings(db, key);
}

async function reconcileProviderKeys(c: Tx, key: Buffer, map: Record<string, any>) {
  const prefix = 'codingAgent.providerKeys.';
  const keep = new Set(Object.keys(map).map((s) => `${prefix}${s}`));
  const rows = await c.select({ field: secretValue.field }).from(secretValue)
    .where(and(eq(secretValue.owner, SETTINGS_SECRET_OWNER), like(secretValue.field, `${prefix}%`)));
  for (const r of rows) {
    if (!keep.has(r.field)) {
      await c.delete(secretValue).where(and(eq(secretValue.owner, SETTINGS_SECRET_OWNER), eq(secretValue.field, r.field)));
    }
  }
  for (const [slug, val] of Object.entries(map)) {
    await putSecret(c, key, SETTINGS_SECRET_OWNER, `${prefix}${slug}`, typeof val === 'string' ? val : '');
  }
}

async function writeAgentSecrets(c: Tx, key: Buffer, list: any[]) {
  const keep = list.filter((s) => s?.name).map((s) => s.name as string);
  if (keep.length) {
    await c.delete(agentSecret).where(notInArray(agentSecret.name, keep));
    await c.delete(secretValue).where(notInArray(secretValue.owner, [...keep, SETTINGS_SECRET_OWNER]));
  } else {
    await c.delete(agentSecret);
    await c.delete(secretValue).where(ne(secretValue.owner, SETTINGS_SECRET_OWNER));
  }
  for (const entry of list) {
    if (!entry?.name) continue;
    const { row, secrets } = splitAgentSecret(entry);
    const vals = {
      name: row.name, description: row.description ?? null, kind: row.kind ?? null,
      oauthProvider: row.oauthProvider ?? null, oauthClientId: row.oauthClientId ?? null,
      oauthAuthUrl: row.oauthAuthUrl ?? null, oauthTokenUrl: row.oauthTokenUrl ?? null,
      oauthScopes: row.oauthScopes ?? null, oauthExpiresAt: row.oauthExpiresAt ?? null,
      oauthStatus: row.oauthStatus ?? null, oauthAccountEmail: row.oauthAccountEmail ?? null,
      createdAt: row.createdAt || now(), updatedAt: now(),
    };
    await c.insert(agentSecret).values(vals).onConflictDoUpdate({
      target: agentSecret.name,
      set: {
        description: vals.description, kind: vals.kind, oauthProvider: vals.oauthProvider,
        oauthClientId: vals.oauthClientId, oauthAuthUrl: vals.oauthAuthUrl, oauthTokenUrl: vals.oauthTokenUrl,
        oauthScopes: vals.oauthScopes, updatedAt: vals.updatedAt,
      },
    });
    for (const field of AGENT_SECRET_FIELDS) {
      if (isOAuthOwnedField(field)) continue;
      if (!(field in secrets)) continue;
      await putSecret(c, key, entry.name, field, (secrets as any)[field] ?? '');
    }
  }
}

// ── Targeted OAuth write (token exchange/refresh persist through here) ────────

export async function patchOAuth(db: Db, key: Buffer, name: string, patch: Record<string, any>): Promise<void> {
  await db.transaction(async (c) => {
    const set: any = { updatedAt: now() };
    if ('expiresAt' in patch) set.oauthExpiresAt = patch.expiresAt ?? null;
    if ('status' in patch) set.oauthStatus = patch.status ?? null;
    if ('accountEmail' in patch) set.oauthAccountEmail = patch.accountEmail ?? null;
    if ('provider' in patch) set.oauthProvider = patch.provider ?? null;
    if ('clientId' in patch) set.oauthClientId = patch.clientId ?? null;
    if ('scopes' in patch) set.oauthScopes = patch.scopes ? JSON.stringify(patch.scopes) : null;
    await c.update(agentSecret).set(set).where(eq(agentSecret.name, name));
    for (const [k, field] of [['accessToken', 'oauth.accessToken'], ['refreshToken', 'oauth.refreshToken'], ['clientSecret', 'oauth.clientSecret']] as const) {
      if (k in patch) await putSecret(c, key, name, field, patch[k] ?? '');
    }
  });
}

// ── Workspace identity ───────────────────────────────────────────────────────

export async function listWorkspaces(db: Db) {
  const rows = await db.select().from(workspace).orderBy(asc(workspace.sortOrder));
  return rows.map((r) => ({
    id: r.id, name: r.name, repoOwner: r.repoOwner, repoName: r.repoName,
    defaultBranch: r.defaultBranch, sortOrder: r.sortOrder,
  }));
}

export async function upsertWorkspace(db: Db, w: { id: string; name: string; repoOwner: string; repoName: string; defaultBranch?: string }) {
  await db.transaction(async (c) => {
    const [{ m }] = await c.select({ m: sql<number>`COALESCE(MAX(${workspace.sortOrder}),0)` }).from(workspace);
    const next = Number(m) + 1;
    await c.insert(workspace)
      .values({ id: w.id, name: w.name, repoOwner: w.repoOwner, repoName: w.repoName, defaultBranch: w.defaultBranch ?? 'main', sortOrder: next })
      .onConflictDoUpdate({ target: workspace.id, set: { name: w.name, repoOwner: w.repoOwner, repoName: w.repoName } });
  });
}

export async function deleteWorkspace(db: Db, id: string) {
  await db.delete(workspace).where(eq(workspace.id, id));
}

export async function updateWorkspaceOrder(db: Db, list: Array<{ id: string; name: string }>) {
  await db.transaction(async (c) => {
    for (let i = 0; i < list.length; i++) {
      const w = list[i];
      if (!w?.id) continue;
      await c.update(workspace).set({ name: w.name ?? '', sortOrder: i + 1 }).where(eq(workspace.id, w.id));
    }
  });
}

// ── Chats ────────────────────────────────────────────────────────────────────

// The camelCase session projection returned to clients (includes running state).
const sessionSelect = {
  sessionId: chatSession.sessionId, workspaceId: chatSession.workspaceId, title: chatSession.title,
  systemPrompt: chatSession.systemPrompt, model: chatSession.model, source: chatSession.source,
  sourceId: chatSession.sourceId, machine: chatSession.machine, createdAt: chatSession.createdAt,
  updatedAt: chatSession.updatedAt, archived: chatSession.archived, starred: chatSession.starred,
  running: chatSession.running, runningMachine: chatSession.runningMachine,
};

export async function listSessions(db: Db, workspaceId: string, opts: { limit?: number; before?: number } = {}) {
  const limit = Math.min(opts.limit ?? 30, 100);
  const conds = [eq(chatSession.workspaceId, workspaceId), eq(chatSession.archived, false), eq(chatSession.starred, false), eq(chatSession.deleted, false)];
  if (typeof opts.before === 'number') conds.push(lt(chatSession.updatedAt, opts.before));
  return db.select(sessionSelect).from(chatSession).where(and(...conds)).orderBy(desc(chatSession.updatedAt)).limit(limit);
}

export async function listStarred(db: Db, workspaceId: string) {
  return db.select(sessionSelect).from(chatSession)
    .where(and(eq(chatSession.workspaceId, workspaceId), eq(chatSession.archived, false), eq(chatSession.starred, true), eq(chatSession.deleted, false)))
    .orderBy(desc(chatSession.updatedAt));
}

// Title-only search (content search can come later via tsvector).
export async function searchSessions(db: Db, workspaceId: string, query: string, opts: { limit?: number } = {}) {
  const limit = Math.min(opts.limit ?? 30, 100);
  const pattern = `%${String(query).replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
  const rows = await db.select({ sessionId: chatSession.sessionId, title: chatSession.title, updatedAt: chatSession.updatedAt })
    .from(chatSession)
    .where(and(eq(chatSession.workspaceId, workspaceId), eq(chatSession.deleted, false), ilike(chatSession.title, pattern)))
    .orderBy(desc(chatSession.updatedAt)).limit(limit);
  return rows.map((r) => ({ sessionId: r.sessionId, title: r.title, updatedAt: r.updatedAt, snippet: r.title ?? '' }));
}

export async function getSession(db: Db, sessionId: string) {
  const rows = await db.select(sessionSelect).from(chatSession)
    .where(and(eq(chatSession.sessionId, sessionId), eq(chatSession.deleted, false)));
  return rows[0] ?? null;
}

export async function getMessages(db: Db, sessionId: string) {
  return db.select({
    sessionId: message.sessionId, seq: message.seq, role: message.role, content: message.content,
    reasoning: message.reasoning, toolCalls: message.toolCalls, toolCallId: message.toolCallId,
    toolName: message.toolName, createdAt: message.createdAt,
  }).from(message).where(eq(message.sessionId, sessionId)).orderBy(asc(message.seq));
}

export async function upsertSession(db: Db, row: {
  sessionId: string; workspaceId: string; systemPrompt?: string | null; model?: string | null;
  source?: string | null; sourceId?: string | null; machine?: string | null; now: number;
}) {
  await db.insert(chatSession)
    .values({
      sessionId: row.sessionId, workspaceId: row.workspaceId, systemPrompt: row.systemPrompt ?? null,
      model: row.model ?? null, source: row.source ?? 'desktop', sourceId: row.sourceId ?? null,
      machine: row.machine ?? null, createdAt: row.now, updatedAt: row.now,
    })
    .onConflictDoUpdate({ target: chatSession.sessionId, set: { updatedAt: row.now } });
}

export async function setSessionTitle(db: Db, sessionId: string, title: string) {
  await db.update(chatSession).set({ title }).where(eq(chatSession.sessionId, sessionId));
}
export async function setSessionStarred(db: Db, sessionId: string, starred: boolean) {
  await db.update(chatSession).set({ starred }).where(eq(chatSession.sessionId, sessionId));
}
export async function deleteSession(db: Db, sessionId: string) {
  // Tombstone so a delete propagates to other machines on pull.
  await db.update(chatSession).set({ deleted: true, updatedAt: now() }).where(eq(chatSession.sessionId, sessionId));
}

// Cross-client execution flag. `machine` non-null → running; null → stopped.
// Cleared only AFTER the turn's rows + transcript are uploaded (caller ordering),
// so running=false means "done and uploaded".
export async function setRunning(db: Db, sessionId: string, machine: string | null) {
  await db.update(chatSession)
    .set({ running: machine != null, runningMachine: machine, updatedAt: now() })
    .where(eq(chatSession.sessionId, sessionId));
}

// Append new message rows. Idempotent by (session_id, seq). Touches updated_at.
export async function persistMessages(db: Db, sessionId: string, rows: any[]): Promise<number> {
  if (!Array.isArray(rows) || !rows.length) return 0;
  let inserted = 0;
  await db.transaction(async (c) => {
    for (const m of rows) {
      const res = await c.insert(message).values({
        sessionId, seq: m.seq, role: m.role, content: m.content ?? null, reasoning: m.reasoning ?? null,
        toolCalls: m.toolCalls ?? null, toolCallId: m.toolCallId ?? null, toolName: m.toolName ?? null,
        createdAt: m.createdAt ?? now(),
      }).onConflictDoNothing({ target: [message.sessionId, message.seq] });
      inserted += res.rowCount ?? 0;
    }
    if (inserted) await c.update(chatSession).set({ updatedAt: now() }).where(eq(chatSession.sessionId, sessionId));
  });
  return inserted;
}

// ── Chat transcript (the pi JSONL, whole) ────────────────────────────────────

export async function putTranscript(db: Db, sessionId: string, content: string): Promise<void> {
  await db.insert(chatTranscript)
    .values({ sessionId, content, updatedAt: now() })
    .onConflictDoUpdate({ target: chatTranscript.sessionId, set: { content, updatedAt: now() } });
}

export async function getTranscript(db: Db, sessionId: string): Promise<string | null> {
  const rows = await db.select({ content: chatTranscript.content }).from(chatTranscript).where(eq(chatTranscript.sessionId, sessionId));
  return rows[0]?.content ?? null;
}
