// The API's data layer — drizzle over Postgres. Every function takes the drizzle
// `Db` + (for secret ops) the master key. Secrets are sealed/unsealed here;
// clients never see ciphertext.

import crypto from 'node:crypto';
import type { Db } from './db.js';
import { seal, unseal } from './crypto.js';
import { publishSettingsChanged } from './feed.js';
import {
  normalizeVoiceReply, DEFAULT_VOICE_REPLY, type VoiceReply,
} from '../../agent-core/voiceReply.js';
import {
  isSettingsSecretKey, SETTINGS_SECRET_OWNER, AGENT_SECRET_FIELDS, isOAuthOwnedField,
  WILDCARD_MAP_PATHS,
  flattenInto, setPath, typeOf, encodeValue, decodeValue,
  isPlainObject, splitAgentSecret, joinAgentSecret,
} from './keys.ts';
import {
  workspace, setting, agentSecret, secretValue, chatTable, message, cronState, telegramAccount,
  telegramSent, attachment,
} from './schema.js';
import { and, eq, lt, gt, desc, asc, ilike, like, sql, inArray } from 'drizzle-orm';

/**
 * Tell every connected desktop that something here changed.
 *
 * In the STORE and not in the routes, because the routes are one door and the
 * bot's slash commands are another — both come through these functions, so this
 * is the only place that covers both by construction. A writer added later is
 * covered by calling the mutator, not by remembering to announce.
 *
 * Fire-and-forget and contentless: the desktop re-reads and pushes a full
 * snapshot. Sending the value here would be a second copy of the truth taking a
 * different route, which is the thing worth not having. The desktop that made the
 * change hears its own announcement too — one idempotent re-read, and the price
 * of not having to know who asked.
 */
function announce(): void {
  try { publishSettingsChanged(); } catch { /* a lost notification is not worth failing a write over */ }
}

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

// ── One-time migration: legacy voice keys ────────────────────────────────────

/**
 * Move any leftover voice key stored under its OLD name into `voiceKeys.<vendor>`.
 *
 * The `secret_value` half of this is done in SQL at the end of `init.sql` — a
 * rename of an already-encrypted row, which needs no key. This half cannot be:
 * a key that ended up as a PLAINTEXT `setting` row has to be encrypted on the way
 * across, and only this process holds the master key.
 *
 * That case is real and was found by running it: a Deepgram key sat in `setting`
 * in the clear. Whatever wrote it, leaving it there after the rename is the worst
 * of both worlds — nothing reads the old path any more, so the key is dead, AND
 * it is no longer a declared credential, so the strip stops covering it and it
 * crosses to the renderer in plaintext.
 *
 * Idempotent: after the first run there are no rows left to match. Never
 * overwrites an existing `voiceKeys.<vendor>` — a value the user has since set
 * through the current path wins over one recovered from the old one.
 */
const LEGACY_VOICE_KEYS: Array<{ old: string; vendor: string }> = [
  { old: 'transcription.apiKey', vendor: 'assemblyai' },
  { old: 'transcription.deepgramApiKey', vendor: 'deepgram' },
];

export async function migrateLegacyVoiceKeys(db: Db, key: Buffer, log?: any): Promise<void> {
  for (const { old, vendor } of LEGACY_VOICE_KEYS) {
    const rows = await db.select({ value: setting.value }).from(setting).where(eq(setting.key, old));
    if (!rows.length) continue;

    const plain = String(rows[0].value ?? '');
    const field = `voiceKeys.${vendor}`;
    const existing = await db.select({ owner: secretValue.owner }).from(secretValue)
      .where(and(eq(secretValue.owner, SETTINGS_SECRET_OWNER), eq(secretValue.field, field)));

    await db.transaction(async (c) => {
      if (plain && !existing.length) await putSecret(c, key, SETTINGS_SECRET_OWNER, field, plain);
      // Delete either way. An empty value was never a key, and a row we declined
      // to move is one the user has already replaced — in both cases leaving the
      // plaintext behind is a credential nothing reads and nothing protects.
      await c.delete(setting).where(eq(setting.key, old));
    });

    log?.warn({ from: old, to: field, moved: !!plain && !existing.length },
      'migrated a voice key that was stored in the clear — consider rotating it');
  }
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
  // path -> the slots present in this patch. Merged, never treated as complete.
  const mapPatches = new Map<string, Record<string, any>>();

  // Dotted form — how the renderer's settings diff sends a whole map (MAP_KEYS in
  // settingsDiff.ts). Covers a top-level map (`voiceKeys`) in the same pass.
  for (const path of WILDCARD_MAP_PATHS) {
    if (isPlainObject(patch[path])) {
      mapPatches.set(path, patch[path] as Record<string, any>);
      delete patch[path];
    }
  }

  for (const [k, value] of Object.entries(patch)) {
    if (k === 'agentSecrets') { agentSecretsPatch = Array.isArray(value) ? value : []; continue; }
    if (k === 'workspaces') continue; // identity via its own endpoint

    // Nested form — the same map arriving inside its parent object
    // (`codingAgent: { providerKeys: {…} }`). Lifted out before the rest of the
    // parent is flattened, or the keys would be written as ordinary leaf rows in
    // the clear.
    const nested = WILDCARD_MAP_PATHS.filter((p) => p.startsWith(`${k}.`));
    if (nested.length && isPlainObject(value)) {
      const rest: any = { ...(value as any) };
      for (const p of nested) {
        const leaf = p.slice(k.length + 1);
        if (isPlainObject(rest[leaf])) mapPatches.set(p, rest[leaf]);
        delete rest[leaf];
      }
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
    for (const [path, map] of mapPatches) await reconcileCredentialMap(c, key, path, map);
    if (agentSecretsPatch) await writeAgentSecrets(c, key, agentSecretsPatch);
  });
  announce();
  return readSettings(db, key);
}

// Write the slots PRESENT in the patch. Absent slots are left alone.
//
// One function for every wildcard credential map (`codingAgent.providerKeys`,
// `voiceKeys`), because the merge rule is a property of the shape, not of which
// map it is — and a per-map copy is how one starts deleting rows the other owns.
//
// This used to treat the map as the complete list and delete every slot missing
// from it, which is why the desktop had to resend all of them on every unrelated
// edit — change a model, and the whole key map rode along or the keys were gone.
// That made it impossible to stop handing the keys to the renderer: the first
// save after would have arrived with an empty map and wiped them.
//
// Deleting is still possible and still explicit — an empty string deletes the row
// (see putSecret), which is what `settings:deleteCredential` sends. Absent and
// empty are different things, and only one of them destroys anything.
async function reconcileCredentialMap(c: Tx, key: Buffer, path: string, map: Record<string, any>) {
  for (const [slug, val] of Object.entries(map)) {
    await putSecret(c, key, SETTINGS_SECRET_OWNER, `${path}.${slug}`, typeof val === 'string' ? val : '');
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
  announce();
}

// ── Workspace identity ───────────────────────────────────────────────────────

export async function listWorkspaces(db: Db) {
  const rows = await db.select().from(workspace).orderBy(asc(workspace.sortOrder));
  return rows.map((r) => ({
    id: r.id, name: r.name, repoOwner: r.repoOwner, repoName: r.repoName,
    defaultBranch: r.defaultBranch, sortOrder: r.sortOrder,
    voiceReply: normalizeVoiceReply(r.voiceReply),
  }));
}

/** One workspace row, for callers that have an id rather than the whole list. */
export async function getWorkspace(db: Db, id: string) {
  const rows = await db.select().from(workspace).where(eq(workspace.id, id));
  return rows[0] ?? null;
}

/**
 * How this workspace's Telegram replies come back. Normalized on read, because
 * the column is plain text and `/voice` is not the only thing that could write it.
 */
export async function getVoiceReply(db: Db, workspaceId: string | null | undefined): Promise<VoiceReply> {
  if (!workspaceId) return DEFAULT_VOICE_REPLY;
  const row = await getWorkspace(db, workspaceId);
  return normalizeVoiceReply(row?.voiceReply);
}

export async function setVoiceReply(db: Db, workspaceId: string, mode: VoiceReply): Promise<void> {
  await db.update(workspace)
    .set({ voiceReply: normalizeVoiceReply(mode) })
    .where(eq(workspace.id, workspaceId));
  announce();
}

export async function upsertWorkspace(db: Db, w: { id: string; name: string; repoOwner: string; repoName: string; defaultBranch?: string }) {
  await db.transaction(async (c) => {
    const [{ m }] = await c.select({ m: sql<number>`COALESCE(MAX(${workspace.sortOrder}),0)` }).from(workspace);
    const next = Number(m) + 1;
    await c.insert(workspace)
      .values({ id: w.id, name: w.name, repoOwner: w.repoOwner, repoName: w.repoName, defaultBranch: w.defaultBranch ?? 'main', sortOrder: next })
      .onConflictDoUpdate({ target: workspace.id, set: { name: w.name, repoOwner: w.repoOwner, repoName: w.repoName } });
  });
  announce();
}

export async function deleteWorkspace(db: Db, id: string) {
  await db.delete(workspace).where(eq(workspace.id, id));
  announce();
}

export async function updateWorkspaceOrder(db: Db, list: Array<{ id: string; name: string }>) {
  await db.transaction(async (c) => {
    for (let i = 0; i < list.length; i++) {
      const w = list[i];
      if (!w?.id) continue;
      await c.update(workspace).set({ name: w.name ?? '', sortOrder: i + 1 }).where(eq(workspace.id, w.id));
    }
  });
  announce();
}

// ── Chats ────────────────────────────────────────────────────────────────────

// The camelCase session projection returned to clients (includes running state).
const sessionSelect = {
  chatId: chatTable.chatId, workspaceId: chatTable.workspaceId, title: chatTable.title,
  systemPrompt: chatTable.systemPrompt, model: chatTable.model, source: chatTable.source,
  sourceId: chatTable.sourceId, machine: chatTable.machine, createdAt: chatTable.createdAt,
  updatedAt: chatTable.updatedAt, archived: chatTable.archived, pinned: chatTable.pinned,
  running: chatTable.running, runningMachine: chatTable.runningMachine,
  transcriptUpdatedAt: chatTable.transcriptUpdatedAt,
};

export async function listChats(db: Db, workspaceId: string, opts: { limit?: number; before?: number } = {}) {
  const limit = Math.min(opts.limit ?? 30, 100);
  const conds = [eq(chatTable.workspaceId, workspaceId), eq(chatTable.archived, false), eq(chatTable.pinned, false), eq(chatTable.deleted, false)];
  if (typeof opts.before === 'number') conds.push(lt(chatTable.updatedAt, opts.before));
  return db.select(sessionSelect).from(chatTable).where(and(...conds)).orderBy(desc(chatTable.updatedAt)).limit(limit);
}

export async function listPinned(db: Db, workspaceId: string) {
  return db.select(sessionSelect).from(chatTable)
    .where(and(eq(chatTable.workspaceId, workspaceId), eq(chatTable.archived, false), eq(chatTable.pinned, true), eq(chatTable.deleted, false)))
    .orderBy(desc(chatTable.updatedAt));
}

// Every pinned chat's id, across all workspaces — what the TTL sweep needs, on
// both sides of the wire (the companion's sweeper calls this directly, the
// desktop reaches it through `GET /chats/pinned-ids`). Not `listPinned`, which
// is one workspace's worth of full rows for the sidebar; a sweep walks
// directories that carry no workspace, so it has to ask about all of them.
//
// Tombstoned chats are excluded on purpose: a deleted chat is not coming back,
// so its working dirs should age out even if it was pinned when it died.
export async function pinnedChatIds(db: Db): Promise<string[]> {
  const rows = await db.select({ chatId: chatTable.chatId }).from(chatTable)
    .where(and(eq(chatTable.pinned, true), eq(chatTable.deleted, false)));
  return rows.map((r) => r.chatId);
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
  const rows = await db.select({
    chatId: message.chatId, seq: message.seq, entryId: message.entryId, role: message.role,
    content: message.content, reasoning: message.reasoning, toolCalls: message.toolCalls,
    toolCallId: message.toolCallId, toolName: message.toolName, createdAt: message.createdAt,
  }).from(message).where(and(...conds)).orderBy(asc(message.seq));

  // Attachment METADATA only — never the bytes. A chat read must not carry every
  // image in the conversation; the client fetches each one from
  // `GET /attachment/:id` when it actually draws it.
  const entryIds = rows.map((r) => r.entryId).filter((id): id is string => !!id);
  if (!entryIds.length) return rows.map((r) => ({ ...r, attachments: [] }));

  const atts = await db.select({
    id: attachment.id, entryId: attachment.entryId, idx: attachment.idx, mimeType: attachment.mimeType,
  }).from(attachment)
    .where(and(eq(attachment.chatId, chatId), inArray(attachment.entryId, entryIds)))
    .orderBy(asc(attachment.idx));

  const byEntry = new Map<string, { id: string; mimeType: string }[]>();
  for (const a of atts) {
    const list = byEntry.get(a.entryId) ?? [];
    list.push({ id: a.id, mimeType: a.mimeType });
    byEntry.set(a.entryId, list);
  }
  return rows.map((r) => ({ ...r, attachments: (r.entryId && byEntry.get(r.entryId)) || [] }));
}

// One image, by id. Returns the raw bytes + type for the HTTP route to stream.
export async function getAttachment(db: Db, id: string) {
  const rows = await db.select({ mimeType: attachment.mimeType, bytes: attachment.bytes })
    .from(attachment).where(eq(attachment.id, id));
  return rows[0] ?? null;
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

/**
 * Copy a chat into a new one for a background run to continue.
 *
 * This is what makes a review or memory run a RESUME rather than a fresh chat
 * handed a description of one. The agent picks up the actual conversation —
 * every tool call with its arguments, the reasoning, the images — because it is
 * literally the same pi session, reopened under a new id. The alternative we ran
 * before flattened the conversation to text and dropped the tool arguments, so
 * the run read a command's output with no idea what command produced it.
 *
 * FOUR fields are copied and the rest are deliberately not:
 *
 *   transcript    the conversation itself — the whole point
 *   systemPrompt  so the run reads under the same instructions the work was done
 *                 under. Also the reason a stored prompt has to be usable
 *                 verbatim: there is nothing here to rebuild it from.
 *   workspaceId   same workspace, by definition
 *   model         same model the work was done with
 *
 * `source` is the one that must NOT be copied and is the reason this is a
 * function rather than a spread. Both sweep queries exclude chats whose source
 * is 'review' or 'memory'; a run that inherited 'desktop' would cross its own
 * threshold, come due, and review itself — forever. The watermarks are likewise
 * fresh: they belong to the chat being examined, not to the examination.
 */
export async function cloneChatForBackground(db: Db, opts: {
  sourceChatId: string; newChatId: string; source: 'review' | 'memory'; title: string;
}): Promise<{ workspaceId: string; workspacePathHint: null }> {
  const [src] = await db.select({
    workspaceId: chatTable.workspaceId,
    systemPrompt: chatTable.systemPrompt,
    model: chatTable.model,
    transcript: chatTable.transcript,
  }).from(chatTable).where(eq(chatTable.chatId, opts.sourceChatId));

  if (!src) throw new Error(`Chat ${opts.sourceChatId} not found.`);
  // Both are required to continue the conversation, and a run that silently
  // started from empty would look like a review that found nothing to say.
  if (!src.transcript) throw new Error(`Chat ${opts.sourceChatId} has no stored conversation to review.`);
  if (!src.systemPrompt) throw new Error(`Chat ${opts.sourceChatId} has no stored system prompt.`);

  const ts = now();
  await db.insert(chatTable).values({
    chatId: opts.newChatId,
    workspaceId: src.workspaceId,
    systemPrompt: src.systemPrompt,
    model: src.model,
    transcript: src.transcript,
    transcriptUpdatedAt: ts,
    title: opts.title,
    source: opts.source,
    sourceId: opts.sourceChatId,
    createdAt: ts,
    updatedAt: ts,
  });
  return { workspaceId: src.workspaceId, workspacePathHint: null };
}

/**
 * Stamp when this chat's work finished being checked in.
 *
 * Called whether the push succeeded or failed: it records "we finished trying".
 * A chat that is never stamped is never reviewed again, and a failed check-in is
 * a conversation worth learning from, not one to freeze out.
 */
export async function setCheckedInAt(db: Db, chatId: string, at = now()) {
  await db.update(chatTable).set({ checkedInAt: at }).where(eq(chatTable.chatId, chatId));
}

export async function setChatTitle(db: Db, chatId: string, title: string) {
  await db.update(chatTable).set({ title }).where(eq(chatTable.chatId, chatId));
}
export async function setChatPinned(db: Db, chatId: string, pinned: boolean) {
  await db.update(chatTable).set({ pinned }).where(eq(chatTable.chatId, chatId));
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

// ── Reviews sweep ───────────────────────────────────────────────────

/**
 * Chats with at least `threshold` tool calls since they were last reviewed.
 *
 * A tool call is one `role='tool'` row — pi emits exactly one per tool result
 * (`entryToRow` in agent-core), so counting rows is counting calls, with no
 * separate counter to drift.
 *
 * Excluded, and each for its own reason:
 *   • `source='review'` and `source='memory'` — a background run makes tool
 *     calls and holds a conversation like any chat, so without this it crosses
 *     the threshold and examines itself, forever. BOTH are excluded from BOTH
 *     sweeps: the memory run's messages must not make it due for review either.
 *   • `running` — the conversation isn't finished; reviewing a half-written turn
 *     reads a partial. It becomes eligible again on the next tick.
 *   • deleted chats — nothing to learn from, and the checkout is gone.
 *
 * Ordered oldest-first so a backlog drains in the order the work happened.
 */
/**
 * Is this chat's work safely in GitHub, so a background run may open it?
 *
 * `running` clears when the agent stops talking, which is BEFORE the check-in.
 * Without this a chat whose push is still in flight looks finished: the run
 * would clone a checkout missing that work, and two agents would be pushing to
 * the same repo at once.
 *
 * Two ways to qualify:
 *
 *   checked_in_at > the chat's newest message — the check-in that finished after
 *     the conversation's last word must be this turn's, since nothing else
 *     pushes for this chat.
 *   checked_in_at IS NULL — a desktop chat, which never checks in at all. Its
 *     work reaches GitHub through the sync engine on a timer, unconnected to any
 *     chat, so there is nothing to wait for. Without this arm, desktop chats —
 *     most of them — would never be reviewed again.
 */
const checkInSettled = sql`(
  c.checked_in_at is null
  or c.checked_in_at > (select max(created_at) from message where chat_id = c.id)
)`;

export async function chatsDueForReview(db: Db, threshold: number, limit = 5) {
  const rows = await db.execute(sql`
    select c.id            as "chatId",
           c.workspace_id  as "workspaceId",
           count(m.seq)::int as "count",
           -- The chat's OWN high-water mark, not max(m.seq): the join is
           -- filtered to tool rows, so that would stop short of the assistant's
           -- closing message. The run reads the whole conversation, so the mark
           -- has to record the whole conversation or it understates what was
           -- reviewed.
           (select max(seq) from message where chat_id = c.id)::int as "maxSeq",
           -- When the oldest unexamined row landed. The one tick runs at most
           -- one thing, so it needs a way to pick fairly between two due chats;
           -- without this, whichever process is asked first always wins and the
           -- other starves behind a permanent backlog.
           min(m.created_at)::bigint as "oldest"
      from chat c
      join message m
        on m.chat_id = c.id
       and m.seq > ${selfSaveMark('last_reviewed_seq', 'manage_skill')}
       and m.role = 'tool'
     where c.deleted = false
       and c.running = false
       and coalesce(c.source, '') not in ('review', 'memory')
       and ${checkInSettled}
     group by c.id, c.workspace_id
    having count(m.seq) >= ${threshold}
     order by min(m.created_at) asc
     limit ${limit}
  `);
  return (rows.rows ?? []) as unknown as DueChat[];
}

/**
 * Chats with enough of the USER's messages since the memory pass last looked.
 *
 * Deliberately a near-copy of `chatsDueForReview` rather than one function with
 * a role parameter. The two are separate processes and the queries differ in
 * what they count (`role='user'` vs `role='tool'`), which mark they read, and
 * which self-save clears them — three of the five moving parts. Merging them
 * would put a branch in each of those spots, which is how the next change to one
 * process silently lands in the other.
 */
export async function chatsDueForMemory(db: Db, threshold: number, limit = 5) {
  const rows = await db.execute(sql`
    select c.id            as "chatId",
           c.workspace_id  as "workspaceId",
           count(m.seq)::int as "count",
           (select max(seq) from message where chat_id = c.id)::int as "maxSeq",
           min(m.created_at)::bigint as "oldest"
      from chat c
      join message m
        on m.chat_id = c.id
       and m.seq > ${selfSaveMark('last_memory_seq', 'memory')}
       and m.role = 'user'
     where c.deleted = false
       and c.running = false
       and coalesce(c.source, '') not in ('review', 'memory')
       and ${checkInSettled}
     group by c.id, c.workspace_id
    having count(m.seq) >= ${threshold}
     order by min(m.created_at) asc
     limit ${limit}
  `);
  return (rows.rows ?? []) as unknown as DueChat[];
}

export interface DueChat { chatId: string; workspaceId: string; count: number; maxSeq: number; oldest: number }

/**
 * The point past which work counts: the stored mark, OR wherever the agent last
 * did this job ITSELF in an ordinary chat, whichever is further along.
 *
 * hermes resets the equivalent counter whenever the foreground agent calls the
 * tool (`tool_executor.py`), and we never ported that half — so a chat where the
 * user said "remember that" and the agent did was still counted as owing the
 * work, and got a background run to learn something already learned.
 *
 * Computed rather than stored, from `message.tool_name`, which we already write
 * per tool row. Nothing has to reach back from `agent-core` into Postgres to
 * move a counter, which is what made this cheap enough to be worth having.
 */
function selfSaveMark(markColumn: 'last_reviewed_seq' | 'last_memory_seq', toolName: 'manage_skill' | 'memory') {
  return sql`greatest(
    c.${sql.raw(markColumn)},
    coalesce((select max(x.seq) from message x
               where x.chat_id = c.id and x.role = 'tool' and x.tool_name = ${toolName}), 0)
  )`;
}

/** Move a chat's review watermark forward. Called before the run, not after. */
export async function setLastReviewedSeq(db: Db, chatId: string, seq: number) {
  await db.update(chatTable)
    .set({ lastReviewedSeq: seq })
    .where(eq(chatTable.chatId, chatId));
}

/** Move a chat's memory watermark forward. Called before the run, not after.
 *  Only ever this mark — a memory run must never advance the review's. */
export async function setLastMemorySeq(db: Db, chatId: string, seq: number) {
  await db.update(chatTable)
    .set({ lastMemorySeq: seq })
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

      // Images ride the message row (agent-core keeps them on it). Insert ONLY
      // when the message itself inserted: a retry or a re-sent turn hits the
      // conflict above and must not add a second copy of the same pictures.
      if (n && Array.isArray(m.images) && m.images.length && m.entryId) {
        await c.insert(attachment).values(m.images.map((img: any, i: number) => ({
          id: crypto.randomUUID(),
          chatId,
          entryId: m.entryId,
          idx: i,
          mimeType: String(img?.mimeType || 'application/octet-stream'),
          bytes: Buffer.from(String(img?.data ?? ''), 'base64'),
          createdAt: m.createdAt ?? now(),
        })));
      }
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
  announce();
}

export async function clearTelegramAccount(db: Db) {
  await db.transaction(async (c) => {
    await c.delete(secretValue).where(eq(secretValue.owner, TG));
    await c.delete(telegramAccount).where(eq(telegramAccount.id, 'default'));
  });
  announce();
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
  announce();
}

// Dedup: advance the high-water mark only if this update_id is newer. Returns
// true if it's new (process it), false if a duplicate/replay (drop it).
export async function markTelegramUpdate(db: Db, updateId: number): Promise<boolean> {
  const res = await db.update(telegramAccount)
    .set({ lastUpdateId: updateId })
    .where(and(eq(telegramAccount.id, 'default'), lt(telegramAccount.lastUpdateId, updateId)));
  return (res.rowCount ?? 0) > 0;
}

// ── Sent-message lookup (🎉 reaction → speak it back) ────────────────────────

// How long a bot message stays speakable. Past this, reacting does nothing —
// same as reacting to a message sent before the table existed.
const TELEGRAM_SENT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// Upsert, because the streamed bubble is EDITED into its final text — the same
// message number can be recorded again with better content. Pruning rides on the
// insert: one user's message volume makes a scheduled sweep more machinery than
// the table is worth.
export async function recordTelegramSent(db: Db, chatId: number, messageId: number, content: string) {
  await db.insert(telegramSent)
    .values({ chatId, messageId, content, createdAt: now() })
    .onConflictDoUpdate({ target: [telegramSent.chatId, telegramSent.messageId], set: { content, createdAt: now() } });
  await db.delete(telegramSent).where(lt(telegramSent.createdAt, now() - TELEGRAM_SENT_TTL_MS));
}

export async function getTelegramSent(db: Db, chatId: number, messageId: number): Promise<string | null> {
  const rows = await db.select().from(telegramSent)
    .where(and(eq(telegramSent.chatId, chatId), eq(telegramSent.messageId, messageId)));
  return rows[0]?.content ?? null;
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
