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
  workspace, setting, agentSecret, secretValue, chatTable, message, cronState, telegramAccount,
} from './schema.js';
import { and, eq, lt, gt, desc, asc, ilike, like, sql, inArray } from 'drizzle-orm';

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
  // Delete ONLY the agent secrets that are gone from the list, and only their
  // own encrypted rows (owner = the agent-secret name). Never a table-wide wipe:
  // secret_value is shared with the `settings` and `telegram` owners, and a
  // "delete everything not in this list" reconcile clobbered the telegram token
  // on every save.
  const existing = (await c.select({ name: agentSecret.name }).from(agentSecret)).map((r) => r.name);
  const removed = existing.filter((n) => !keep.includes(n));
  if (removed.length) {
    await c.delete(agentSecret).where(inArray(agentSecret.name, removed));
    await c.delete(secretValue).where(inArray(secretValue.owner, removed));
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
  chatId: chatTable.chatId, workspaceId: chatTable.workspaceId, title: chatTable.title,
  systemPrompt: chatTable.systemPrompt, model: chatTable.model, source: chatTable.source,
  sourceId: chatTable.sourceId, machine: chatTable.machine, createdAt: chatTable.createdAt,
  updatedAt: chatTable.updatedAt, archived: chatTable.archived, starred: chatTable.starred,
  running: chatTable.running, runningMachine: chatTable.runningMachine,
  transcriptUpdatedAt: chatTable.transcriptUpdatedAt,
};

export async function listChats(db: Db, workspaceId: string, opts: { limit?: number; before?: number } = {}) {
  const limit = Math.min(opts.limit ?? 30, 100);
  const conds = [eq(chatTable.workspaceId, workspaceId), eq(chatTable.archived, false), eq(chatTable.starred, false), eq(chatTable.deleted, false)];
  if (typeof opts.before === 'number') conds.push(lt(chatTable.updatedAt, opts.before));
  return db.select(sessionSelect).from(chatTable).where(and(...conds)).orderBy(desc(chatTable.updatedAt)).limit(limit);
}

export async function listStarred(db: Db, workspaceId: string) {
  return db.select(sessionSelect).from(chatTable)
    .where(and(eq(chatTable.workspaceId, workspaceId), eq(chatTable.archived, false), eq(chatTable.starred, true), eq(chatTable.deleted, false)))
    .orderBy(desc(chatTable.updatedAt));
}

// Title-only search (content search can come later via tsvector).
export async function searchChats(db: Db, workspaceId: string, query: string, opts: { limit?: number } = {}) {
  const limit = Math.min(opts.limit ?? 30, 100);
  const pattern = `%${String(query).replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
  const rows = await db.select({ chatId: chatTable.chatId, title: chatTable.title, updatedAt: chatTable.updatedAt })
    .from(chatTable)
    .where(and(eq(chatTable.workspaceId, workspaceId), eq(chatTable.deleted, false), ilike(chatTable.title, pattern)))
    .orderBy(desc(chatTable.updatedAt)).limit(limit);
  return rows.map((r) => ({ chatId: r.chatId, title: r.title, updatedAt: r.updatedAt, snippet: r.title ?? '' }));
}

export async function getChat(db: Db, chatId: string) {
  const rows = await db.select(sessionSelect).from(chatTable)
    .where(and(eq(chatTable.chatId, chatId), eq(chatTable.deleted, false)));
  return rows[0] ?? null;
}

// The whole chat, or — with `after` — only what's newer than a seq the caller
// already has. One call serves a cold open, a catch-up, and a reconnect gap.
export async function getMessages(db: Db, chatId: string, after?: number) {
  const conds = [eq(message.chatId, chatId)];
  if (typeof after === 'number') conds.push(gt(message.seq, after));
  return db.select({
    chatId: message.chatId, seq: message.seq, entryId: message.entryId, role: message.role,
    content: message.content, reasoning: message.reasoning, toolCalls: message.toolCalls,
    toolCallId: message.toolCallId, toolName: message.toolName, createdAt: message.createdAt,
  }).from(message).where(and(...conds)).orderBy(asc(message.seq));
}

export async function upsertChat(db: Db, row: {
  chatId: string; workspaceId: string; systemPrompt?: string | null; model?: string | null;
  source?: string | null; sourceId?: string | null; machine?: string | null; now: number;
}) {
  await db.insert(chatTable)
    .values({
      chatId: row.chatId, workspaceId: row.workspaceId, systemPrompt: row.systemPrompt ?? null,
      model: row.model ?? null, source: row.source ?? 'desktop', sourceId: row.sourceId ?? null,
      machine: row.machine ?? null, createdAt: row.now, updatedAt: row.now,
    })
    .onConflictDoUpdate({ target: chatTable.chatId, set: { updatedAt: row.now } });
}

export async function setChatTitle(db: Db, chatId: string, title: string) {
  await db.update(chatTable).set({ title }).where(eq(chatTable.chatId, chatId));
}
export async function setChatStarred(db: Db, chatId: string, starred: boolean) {
  await db.update(chatTable).set({ starred }).where(eq(chatTable.chatId, chatId));
}
export async function deleteChat(db: Db, chatId: string) {
  // Tombstone so a delete propagates to other machines on pull.
  await db.update(chatTable).set({ deleted: true, updatedAt: now() }).where(eq(chatTable.chatId, chatId));
}

// Cross-client execution flag. `machine` non-null → running; null → stopped.
// Cleared only AFTER the turn's rows + transcript are uploaded (caller ordering),
// so running=false means "done and uploaded".
export async function setRunning(db: Db, chatId: string, machine: string | null) {
  await db.update(chatTable)
    .set({ running: machine != null, runningMachine: machine, updatedAt: now() })
    .where(eq(chatTable.chatId, chatId));
}

// Append message rows, one per pi SessionEntry, as they happen.
//
// Idempotent by (session_id, entry_id) — a conflict means "pi already told us
// about this exact message", so a retry or a bulk re-send is a true no-op. `seq`
// is assigned HERE (max+1), never by the caller: it is a read cursor, not an
// identity. The chat_session row is locked for the duration so two concurrent
// appends to one chat can't pick the same seq.
export async function appendMessages(db: Db, chatId: string, rows: any[]): Promise<number> {
  if (!Array.isArray(rows) || !rows.length) return 0;
  let inserted = 0;
  await db.transaction(async (c) => {
    // Serialize per session (also proves the session exists before we insert).
    const lock = await c.execute(sql`select 1 from chat where id = ${chatId} for update`);
    if (!lock.rowCount) return;
    const cur = await c.execute<{ max: number | null }>(
      sql`select max(seq) as max from message where chat_id = ${chatId}`,
    );
    let next = (cur.rows[0]?.max ?? -1) + 1;
    for (const m of rows) {
      const res = await c.insert(message).values({
        chatId, seq: next, entryId: m.entryId ?? null, parentId: m.parentId ?? null,
        role: m.role, content: m.content ?? null, reasoning: m.reasoning ?? null,
        toolCalls: m.toolCalls ?? null, toolCallId: m.toolCallId ?? null, toolName: m.toolName ?? null,
        createdAt: m.createdAt ?? now(),
      }).onConflictDoNothing({ target: [message.chatId, message.entryId] });
      const n = res.rowCount ?? 0;
      inserted += n;
      next += n; // a skipped duplicate must not burn a seq
    }
    if (inserted) await c.update(chatTable).set({ updatedAt: now() }).where(eq(chatTable.chatId, chatId));
  });
  return inserted;
}

// ── Chat transcript (pi's own session JSONL, whole) ──────────────────────────
// Not what the UI renders — this is what lets another machine continue the chat.

// Returns the new `transcript_updated_at`. Callers keep it as the version they
// last wrote, so they can tell when ANOTHER machine has since advanced the chat.
export async function putTranscript(db: Db, chatId: string, content: string): Promise<number> {
  const stamp = now();
  await db.update(chatTable)
    .set({ transcript: content, transcriptUpdatedAt: stamp })
    .where(eq(chatTable.chatId, chatId));
  return stamp;
}

export async function getTranscript(db: Db, chatId: string): Promise<string | null> {
  const rows = await db.select({ content: chatTable.transcript }).from(chatTable).where(eq(chatTable.chatId, chatId));
  return rows[0]?.content ?? null;
}

// ── Cron run history ─────────────────────────────────────────────────────────

export async function recordCronRun(db: Db, workspaceId: string, jobName: string, o: { chatId?: string | null; error?: string | null }) {
  const vals = { workspaceId, jobName, lastRunAt: now(), lastError: o.error ?? null, lastChatId: o.chatId ?? null, updatedAt: now() };
  await db.insert(cronState).values(vals).onConflictDoUpdate({
    target: [cronState.workspaceId, cronState.jobName],
    set: { lastRunAt: vals.lastRunAt, lastError: vals.lastError, lastChatId: vals.lastChatId, updatedAt: vals.updatedAt },
  });
}

export async function getCronState(db: Db, workspaceId: string) {
  return db.select().from(cronState).where(eq(cronState.workspaceId, workspaceId));
}

// ── Telegram account ─────────────────────────────────────────────────────────

const TG = 'telegram'; // secret_value owner

export async function getTelegramAccount(db: Db) {
  const rows = await db.select().from(telegramAccount).where(eq(telegramAccount.id, 'default'));
  return rows[0] ?? null;
}

// The bot token / webhook secret (encrypted). field: 'botToken' | 'webhookSecret'.
export async function getTelegramSecret(db: Db, key: Buffer, field: string): Promise<string> {
  return getSecret(db, key, TG, field);
}

// Connect/update: encrypt token + secret, upsert the metadata row.
export async function saveTelegramAccount(
  db: Db, key: Buffer,
  meta: { authorizedTgUserId: number; dmChatId: number; botUsername: string | null; enabled: boolean },
  secrets: { botToken: string; webhookSecret: string },
) {
  await db.transaction(async (c) => {
    await putSecret(c, key, TG, 'botToken', secrets.botToken);
    await putSecret(c, key, TG, 'webhookSecret', secrets.webhookSecret);
    await c.insert(telegramAccount).values({
      id: 'default', authorizedTgUserId: meta.authorizedTgUserId, dmChatId: meta.dmChatId,
      botUsername: meta.botUsername, enabled: meta.enabled, lastUpdateId: 0, updatedAt: now(),
    }).onConflictDoUpdate({
      target: telegramAccount.id,
      set: { authorizedTgUserId: meta.authorizedTgUserId, dmChatId: meta.dmChatId, botUsername: meta.botUsername, enabled: meta.enabled, updatedAt: now() },
    });
  });
}

export async function clearTelegramAccount(db: Db) {
  await db.transaction(async (c) => {
    await c.delete(secretValue).where(eq(secretValue.owner, TG));
    await c.delete(telegramAccount).where(eq(telegramAccount.id, 'default'));
  });
}

export async function setTelegramActiveChat(db: Db, chatId: string | null) {
  await db.update(telegramAccount).set({ activeChatId: chatId, updatedAt: now() }).where(eq(telegramAccount.id, 'default'));
}

// Which workspace Telegram runs against. Switching always starts a fresh chat —
// a chat belongs to one workspace, so carrying the old one over would be wrong.
export async function setTelegramActiveWorkspace(db: Db, workspaceId: string) {
  await db.update(telegramAccount)
    .set({ activeWorkspaceId: workspaceId, activeChatId: null, updatedAt: now() })
    .where(eq(telegramAccount.id, 'default'));
}

// Dedup: advance the high-water mark only if this update_id is newer. Returns
// true if it's new (process it), false if a duplicate/replay (drop it).
export async function markTelegramUpdate(db: Db, updateId: number): Promise<boolean> {
  const res = await db.update(telegramAccount)
    .set({ lastUpdateId: updateId })
    .where(and(eq(telegramAccount.id, 'default'), lt(telegramAccount.lastUpdateId, updateId)));
  return (res.rowCount ?? 0) > 0;
}

// ── Chat search (the agent's `search_chats` tool) ────────────────────────────
// Postgres full-text over user+assistant text; tool output isn't indexed (see
// init.sql). Ranked by ts_rank, optionally biased by time.

const SEARCH_POOL = 50; // widened before dedupe, so N results are N distinct chats

/** Messages `window` either side of `around` (or the tail when it's absent). */
export async function readChatWindow(db: Db, chatId: string, around: number | undefined, window: number) {
  const chat = await getChat(db, chatId);
  if (!chat) return null;
  const all = await getMessages(db, chatId);
  if (!all.length) return { title: chat.title, updatedAt: chat.updatedAt, total: 0, first: 0, last: 0, messages: [] };
  const centre = around == null
    ? all.length - 1
    : Math.max(0, all.findIndex((m) => m.seq >= around) === -1 ? all.length - 1 : all.findIndex((m) => m.seq >= around));
  const from = Math.max(0, centre - window);
  const slice = all.slice(from, Math.min(all.length, centre + window + 1));
  return {
    title: chat.title, updatedAt: chat.updatedAt, total: all.length,
    first: slice[0]?.seq ?? 0, last: slice[slice.length - 1]?.seq ?? 0, messages: slice,
  };
}

export async function recentChats(db: Db, workspaceId: string, limit: number, excludeChatId?: string) {
  const rows = await listChats(db, workspaceId, { limit: limit + 1 });
  return Promise.all(rows.filter((r) => r.chatId !== excludeChatId).slice(0, limit).map(async (r) => ({
    chatId: r.chatId, title: r.title, updatedAt: r.updatedAt,
    total: (await getMessages(db, r.chatId)).length,
  })));
}

export async function searchChatMessages(
  db: Db, workspaceId: string, query: string, limit: number,
  sort?: 'newest' | 'oldest', excludeChatId?: string,
) {
  // websearch_to_tsquery takes what a person would actually type (quoted
  // phrases, OR, -word) and never throws on odd punctuation the way
  // to_tsquery does — so a user's words can be passed through as-is.
  const order = sort === 'newest' ? sql`c.updated_at DESC, rank DESC`
    : sort === 'oldest' ? sql`c.updated_at ASC, rank DESC`
    : sql`rank DESC`;
  const hits = await db.execute<{ chat_id: string; seq: number }>(sql`
    SELECT m.chat_id, m.seq,
           ts_rank(m.search_text, websearch_to_tsquery('english', ${query})) AS rank
      FROM message m JOIN chat c ON c.id = m.chat_id
     WHERE c.workspace_id = ${workspaceId} AND c.deleted = false
       AND m.search_text @@ websearch_to_tsquery('english', ${query})
     ORDER BY ${order}
     LIMIT ${SEARCH_POOL}
  `);

  // One result per CONVERSATION — eight hits in one chat is one answer, not eight.
  const seen = new Map<string, number>();
  for (const h of hits.rows) {
    if (h.chat_id === excludeChatId || seen.has(h.chat_id)) continue;
    seen.set(h.chat_id, h.seq);
    if (seen.size >= limit) break;
  }

  return Promise.all([...seen].map(async ([chatId, matchSeq]) => {
    const chat = await getChat(db, chatId);
    const all = await getMessages(db, chatId);
    const at = Math.max(0, all.findIndex((m) => m.seq === matchSeq));
    // The bookends are what make a mid-conversation hit legible: the opening
    // says what the chat was about, the closing how it ended.
    return {
      chatId, title: chat?.title, updatedAt: chat?.updatedAt, total: all.length, matchSeq,
      opening: all.slice(0, 3),
      around: all.slice(Math.max(0, at - 5), at + 6),
      closing: all.length > 8 ? all.slice(-3) : [],
    };
  }));
}
