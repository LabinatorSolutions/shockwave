// Drizzle schema — the single source of truth for the Postgres tables. The query
// layer (store.ts) is built on these definitions; `drizzle-kit push`/`generate`
// (see drizzle.config.ts) syncs them to the database. `bytea` has no built-in
// drizzle type, so it's declared once as a customType.

import { pgTable, text, integer, doublePrecision, boolean, bigint, primaryKey, index, customType } from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() { return 'bytea'; },
});

// Epoch-ms timestamps. mode:'number' + the global int8 type parser (db.ts) keep
// these as JS numbers on the way out.
const epochMs = (name: string) => bigint(name, { mode: 'number' });

// Workspace IDENTITY — a GitHub repo. Checkout path / active / sync-toggle are
// machine-local (desktop userData), not here.
export const workspace = pgTable('workspace', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  repoOwner: text('repo_owner').notNull(),
  repoName: text('repo_name').notNull(),
  defaultBranch: text('default_branch').notNull().default('main'),
  sortOrder: doublePrecision('sort_order').notNull(),
  // How the agent's Telegram replies come back for this workspace: 'text' |
  // 'voice' | 'both'. HERE and not in the workspace's own `.shockwave/
  // workspace.json`, because /voice is a slash command — answered straight from
  // this database with no checkout prepared, like every other command. A file in
  // the checkout would have made a preference change cost a clone.
  voiceReply: text('voice_reply').notNull().default('text'),
}, (t) => [
  index('idx_workspace_sort').on(t.sortOrder),
  index('idx_workspace_repo').on(t.repoOwner, t.repoName),
]);

// Non-secret scalar settings, one row per dotted leaf key.
export const setting = pgTable('setting', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  type: text('type').notNull(),      // 'string' | 'number' | 'boolean' | 'json'
  updatedAt: epochMs('updated_at').notNull(),
});

// Agent-secret ENTITY metadata (no crypto columns).
export const agentSecret = pgTable('agent_secret', {
  name: text('name').primaryKey(),
  description: text('description'),
  kind: text('kind'),                // 'static' | 'oauth'
  oauthProvider: text('oauth_provider'),
  oauthClientId: text('oauth_client_id'),
  oauthAuthUrl: text('oauth_auth_url'),
  oauthTokenUrl: text('oauth_token_url'),
  oauthScopes: text('oauth_scopes'), // JSON array
  oauthExpiresAt: epochMs('oauth_expires_at'),
  oauthStatus: text('oauth_status'), // 'disconnected' | 'connected' | 'expired'
  oauthAccountEmail: text('oauth_account_email'),
  createdAt: epochMs('created_at').notNull(),
  updatedAt: epochMs('updated_at').notNull(),
});

// EVERY encrypted value. Crypto columns NOT NULL so a plaintext credential is
// unrepresentable. bytea for the GCM iv/tag.
export const secretValue = pgTable('secret_value', {
  owner: text('owner').notNull(),    // 'settings' or an agent_secret.name
  field: text('field').notNull(),
  ciphertext: text('ciphertext').notNull(), // base64, AES-256-GCM
  iv: bytea('iv').notNull(),
  tag: bytea('tag').notNull(),
  keyVersion: integer('key_version').notNull(),
  updatedAt: epochMs('updated_at').notNull(),
}, (t) => [primaryKey({ columns: [t.owner, t.field] })]);

// Chats. `running`/`running_machine` are the cross-client execution flag: the
// executing machine sets them on agent_start and clears them AFTER uploading the
// turn (rows + transcript), so running=false means "done and uploaded".
export const chatTable = pgTable('chat', {
  chatId: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  title: text('title'),
  systemPrompt: text('system_prompt'),
  model: text('model'),
  source: text('source'),            // 'desktop' | 'cron' | ...
  sourceId: text('source_id'),
  machine: text('machine'),          // hostname that created it (provenance)
  createdAt: epochMs('created_at').notNull(),
  updatedAt: epochMs('updated_at').notNull(),
  archived: boolean('archived').notNull().default(false),
  pinned: boolean('pinned').notNull().default(false),
  deleted: boolean('deleted').notNull().default(false),
  running: boolean('running').notNull().default(false),
  runningMachine: text('running_machine'),
  // How far the review sweep has already looked: the `message.seq` it
  // had reached. Tool calls after this point are what make a chat due. Moved
  // forward when a run STARTS, not when it succeeds — otherwise a chat whose
  // review keeps failing is picked again on every tick.
  lastReviewedSeq: integer('last_reviewed_seq').notNull().default(0),
  lastMemorySeq: integer('last_memory_seq').notNull().default(0),
  // pi's OWN session JSONL, whole — how a chat moves between machines. NOT what
  // the UI renders (that's `message`). A column, not a 1:1 side table; Postgres
  // TOASTs it out of line and never reads it unless selected.
  transcript: text('transcript'),
  transcriptUpdatedAt: epochMs('transcript_updated_at'),
  /** When this chat's work last finished being checked in — success or failure.
   *  NULL forever on a desktop chat, which never checks in. See init.sql. */
  checkedInAt: epochMs('checked_in_at'),
}, (t) => [index('idx_chat_ws_updated').on(t.workspaceId, t.updatedAt)]);

// Telegram integration — a single account (one authorized user, DM-only). The
// bot token + webhook secret are encrypted in secret_value (owner 'telegram'),
// same as every other credential; this holds the non-secret metadata. active
// chat id makes a Telegram conversation continue one chat; last_update_id
// dedups webhook retries.
export const telegramAccount = pgTable('telegram_account', {
  id: text('id').primaryKey().default('default'),
  authorizedTgUserId: bigint('authorized_tg_user_id', { mode: 'number' }),
  dmChatId: bigint('dm_chat_id', { mode: 'number' }),
  activeChatId: text('active_chat_id'),
  activeWorkspaceId: text('active_workspace_id'),
  lastUpdateId: bigint('last_update_id', { mode: 'number' }).notNull().default(0),
  botUsername: text('bot_username'),
  enabled: boolean('enabled').notNull().default(false),
  updatedAt: epochMs('updated_at').notNull(),
});

// What each bot message SAID, keyed by Telegram's own message number. A reaction
// update carries only that number — never the content — so speaking a reacted
// message back needs this lookup. Written when a reply lands (final chunks, not
// mid-stream edits); rows expire after TELEGRAM_SENT_TTL_MS (pruned on insert).
export const telegramSent = pgTable('telegram_sent', {
  chatId: bigint('chat_id', { mode: 'number' }).notNull(),
  messageId: bigint('message_id', { mode: 'number' }).notNull(),
  content: text('content').notNull(),
  createdAt: epochMs('created_at').notNull(),
}, (t) => [primaryKey({ columns: [t.chatId, t.messageId] })]);

// Cron run HISTORY only (per workspace + job). croner computes next-run in
// memory, so nothing scheduling-related is persisted here — just what the desktop
// UI shows: when it last ran, the last error, and which chat it produced.
export const cronState = pgTable('cron_state', {
  workspaceId: text('workspace_id').notNull(),
  jobName: text('job_name').notNull(),
  lastRunAt: epochMs('last_run_at'),
  lastError: text('last_error'),
  lastChatId: text('last_chat_id'),
  updatedAt: epochMs('updated_at').notNull(),
}, (t) => [primaryKey({ columns: [t.workspaceId, t.jobName] })]);

// One row per pi message, appended as pi emits it. IDENTITY is `entryId` (pi's
// own SessionEntry id, unique + stable for the life of the chat); `seq` is only
// the ordering/read cursor and is assigned server-side. See init.sql for why
// that split matters.
export const message = pgTable('message', {
  chatId: text('chat_id').notNull().references(() => chatTable.chatId, { onDelete: 'cascade' }),
  seq: integer('seq').notNull(),
  entryId: text('entry_id'),         // pi SessionEntry.id — null only on pre-existing rows
  parentId: text('parent_id'),       // pi SessionEntry.parentId
  role: text('role').notNull(),      // 'user' | 'assistant' | 'tool'
  content: text('content'),
  reasoning: text('reasoning'),
  toolCalls: text('tool_calls'),     // JSON array
  toolCallId: text('tool_call_id'),
  toolName: text('tool_name'),
  createdAt: epochMs('created_at').notNull(),
}, (t) => [primaryKey({ columns: [t.chatId, t.seq] })]);

// Images the USER sent with a message — what the chat UI draws. Written from the
// same append that stores the message, so both clients are covered by one path:
// desktop and Telegram alike hand images to pi, and `entryToRow` in agent-core
// keeps them on the row instead of dropping them.
//
// Keyed by `entryId`, not `seq`: entry id is the message's identity (seq is
// assigned server-side, later), and it's the only handle the writer has at the
// moment the row is built.
//
// The bytes also exist inside `chat.transcript` — that's pi's own session file,
// an opaque third-party format we store whole and never parse. This table is our
// copy, in a shape we can serve one image at a time.
export const attachment = pgTable('attachment', {
  id: text('id').primaryKey(),
  chatId: text('chat_id').notNull().references(() => chatTable.chatId, { onDelete: 'cascade' }),
  entryId: text('entry_id').notNull(),   // the message's pi SessionEntry.id
  idx: integer('idx').notNull(),         // ordinal within that message
  mimeType: text('mime_type').notNull(),
  bytes: bytea('bytes').notNull(),
  createdAt: epochMs('created_at').notNull(),
}, (t) => [index('idx_attachment_msg').on(t.chatId, t.entryId)]);
