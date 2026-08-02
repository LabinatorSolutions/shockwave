-- Shockwave API — Postgres schema (Phase 1: shared data only).
--
-- Mounted into Postgres's /docker-entrypoint-initdb.d, so it runs once on a
-- fresh data directory. Idempotent (IF NOT EXISTS) so it's safe to re-run.
-- Later schema changes move to a real migration runner; this bootstraps a fresh
-- DB. No machine-local tables (workspace_local, cron_state) and no hostname
-- columns — all machine-local state lives in the desktop's userData file.
--
-- Type ports from the old SQLite schema:
--   blob  -> bytea         (secret_value.iv / .tag)
--   integer-ms timestamps -> bigint  (kept as epoch-ms; no app change)
--   text primary keys, defaults -> unchanged

-- Workspace IDENTITY. A workspace IS a GitHub repo. Checkout path / active /
-- sync-toggle are machine-local and live in userData, not here.
CREATE TABLE IF NOT EXISTS workspace (
  id             text PRIMARY KEY,
  name           text NOT NULL,
  repo_owner     text NOT NULL,
  repo_name      text NOT NULL,
  default_branch text NOT NULL DEFAULT 'main',
  sort_order     double precision NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workspace_sort ON workspace (sort_order);
CREATE INDEX IF NOT EXISTS idx_workspace_repo ON workspace (repo_owner, repo_name);

-- Non-secret scalar settings, one row per dotted leaf key.
CREATE TABLE IF NOT EXISTS setting (
  key        text PRIMARY KEY,
  value      text NOT NULL,
  type       text NOT NULL,          -- 'string' | 'number' | 'boolean' | 'json'
  updated_at bigint NOT NULL
);

-- Agent-secret ENTITY metadata (no crypto columns). API role only.
CREATE TABLE IF NOT EXISTS agent_secret (
  name                text PRIMARY KEY,
  description         text,
  kind               text,           -- 'static' | 'oauth'
  oauth_provider     text,
  oauth_client_id    text,
  oauth_auth_url     text,
  oauth_token_url    text,
  oauth_scopes       text,           -- JSON array
  oauth_expires_at   bigint,
  oauth_status       text,           -- 'disconnected' | 'connected' | 'expired'
  oauth_account_email text,
  created_at         bigint NOT NULL,
  updated_at         bigint NOT NULL
);

-- EVERY encrypted value. Crypto columns NOT NULL so a plaintext credential is
-- unrepresentable. API role only. bytea for the GCM iv/tag.
CREATE TABLE IF NOT EXISTS secret_value (
  owner       text   NOT NULL,       -- 'settings' or an agent_secret.name
  field       text   NOT NULL,
  ciphertext  text   NOT NULL,       -- base64, AES-256-GCM
  iv          bytea  NOT NULL,
  tag         bytea  NOT NULL,
  key_version integer NOT NULL,
  updated_at  bigint NOT NULL,
  PRIMARY KEY (owner, field)
);

-- ── Rename: session → chat ───────────────────────────────────────────────────
-- A chat is a chat. "Session" now means ONLY pi's own session file (its working
-- memory for a chat), which is a different thing with a different lifetime.
--
-- This MUST come before the CREATE TABLE below: on an existing database the data
-- lives in `chat_session`, and `CREATE TABLE IF NOT EXISTS chat` would otherwise
-- happily create a second, empty table beside it. Renames are metadata-only —
-- no data moves, and foreign keys and indexes follow their columns automatically.
-- Each step is guarded, so re-running this file (every boot) is a no-op.
DO $$ BEGIN
  IF to_regclass('public.chat_session') IS NOT NULL AND to_regclass('public.chat') IS NULL THEN
    ALTER TABLE chat_session RENAME TO chat;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='chat' AND column_name='session_id') THEN
    ALTER TABLE chat RENAME COLUMN session_id TO id;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='message' AND column_name='session_id') THEN
    ALTER TABLE message RENAME COLUMN session_id TO chat_id;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='telegram_account' AND column_name='active_session_id') THEN
    ALTER TABLE telegram_account RENAME COLUMN active_session_id TO active_chat_id;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='cron_state' AND column_name='last_session_id') THEN
    ALTER TABLE cron_state RENAME COLUMN last_session_id TO last_chat_id;
  END IF;
  -- Constraint and index NAMES don't follow a column rename; tidy them so
  -- nothing left in the schema still says "session".
  IF to_regclass('public.chat_session_pkey') IS NOT NULL THEN ALTER INDEX chat_session_pkey RENAME TO chat_pkey; END IF;
  IF to_regclass('public.idx_chat_session_ws_updated') IS NOT NULL THEN ALTER INDEX idx_chat_session_ws_updated RENAME TO idx_chat_ws_updated; END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname='message_session_id_fkey') THEN ALTER TABLE message RENAME CONSTRAINT message_session_id_fkey TO message_chat_id_fkey; END IF;
END $$;

-- Chats. `workspace_id` references the shared workspace identity (NOT a local
-- path). The pi transcript lives in a column here (see below). `deleted` is a
-- tombstone so a delete propagates to other machines on pull.
CREATE TABLE IF NOT EXISTS chat (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL,
  title         text,
  system_prompt text,
  model         text,
  source        text,          -- 'desktop' | 'cron' | ...
  source_id     text,
  machine       text,          -- hostname that created it (provenance only)
  created_at    bigint NOT NULL,
  updated_at    bigint NOT NULL,
  archived      boolean NOT NULL DEFAULT false,
  pinned        boolean NOT NULL DEFAULT false,
  deleted       boolean NOT NULL DEFAULT false,
  -- Cross-client execution flag. The executing machine sets running=true on
  -- agent_start and clears it AFTER uploading the turn, so running=false means
  -- "done and uploaded". running_machine names which client is executing.
  running         boolean NOT NULL DEFAULT false,
  running_machine text,
  -- How far the self-improvement sweep has already looked at this chat: the
  -- `message.seq` it had reached. Work since then is what triggers a review, so
  -- this moves forward when a run STARTS — a run that fails must not make the
  -- same chat eligible again on the very next tick, forever.
  last_reviewed_seq integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_chat_ws_updated ON chat (workspace_id, updated_at);
-- Existing volumes (table already created before these columns) get them here.
ALTER TABLE chat ADD COLUMN IF NOT EXISTS running boolean NOT NULL DEFAULT false;
ALTER TABLE chat ADD COLUMN IF NOT EXISTS running_machine text;
-- Existing chats start at 0, which would make every one of them eligible the
-- first time the sweep runs. Seeding to the chat's current high-water mark means
-- the loop starts from "nothing owed" and only reviews work done from here on.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'chat' AND column_name = 'last_reviewed_seq'
  ) THEN
    ALTER TABLE chat ADD COLUMN last_reviewed_seq integer NOT NULL DEFAULT 0;
    UPDATE chat SET last_reviewed_seq = COALESCE(
      (SELECT max(seq) FROM message WHERE message.chat_id = chat.id), 0
    );
  END IF;
END $$;
-- Rename: starred → pinned (the feature is "pinned chats" now). Guarded so
-- re-running this file (every boot) is a no-op; fresh DBs create `pinned` above.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='chat' AND column_name='starred') THEN
    ALTER TABLE chat RENAME COLUMN starred TO pinned;
  END IF;
END $$;

-- The pi transcript JSONL, stored whole (Postgres TOAST handles multi-MB text,
-- and an unselected column is never read). This is pi's OWN session file — how a
-- chat moves between machines — not what the UI renders; that's `message`. It is
-- a COLUMN, not a table: it was strictly one row per session, so a 1:1 side table
-- bought nothing.
ALTER TABLE chat ADD COLUMN IF NOT EXISTS transcript text;
ALTER TABLE chat ADD COLUMN IF NOT EXISTS transcript_updated_at bigint;
-- Fold the old side table in, once, then retire it.
DO $$ BEGIN
  IF to_regclass('public.chat_transcript') IS NOT NULL THEN
    UPDATE chat c SET transcript = t.content, transcript_updated_at = t.updated_at
      FROM chat_transcript t WHERE t.session_id = c.id AND c.transcript IS NULL;
    DROP TABLE chat_transcript;
  END IF;
END $$;

-- Telegram integration (single account, one authorized user, DM-only). The bot
-- token + webhook secret live encrypted in secret_value (owner 'telegram'); this
-- holds the non-secret metadata + dedup high-water mark + active session.
-- `active_workspace_id` is which workspace Telegram runs against, switchable from
-- the chat with /workspace. Falls back to TELEGRAM_DEFAULT_WORKSPACE when unset,
-- so an existing install keeps working with no change.
CREATE TABLE IF NOT EXISTS telegram_account (
  id                    text PRIMARY KEY DEFAULT 'default',
  authorized_tg_user_id bigint,
  dm_chat_id            bigint,
  active_chat_id        text,
  active_workspace_id   text,
  last_update_id        bigint NOT NULL DEFAULT 0,
  bot_username          text,
  enabled               boolean NOT NULL DEFAULT false,
  updated_at            bigint NOT NULL
);

-- Cron run history (per workspace + job). croner computes next-run in memory, so
-- only what the UI shows is persisted: last run / error / chat.
ALTER TABLE telegram_account ADD COLUMN IF NOT EXISTS active_workspace_id text;

CREATE TABLE IF NOT EXISTS cron_state (
  workspace_id    text NOT NULL,
  job_name        text NOT NULL,
  last_run_at     bigint,
  last_error      text,
  last_chat_id    text,
  updated_at      bigint NOT NULL,
  PRIMARY KEY (workspace_id, job_name)
);

-- One row per pi message, appended the moment pi emits it.
--
-- IDENTITY is `entry_id` — pi's own SessionEntry id, stable and unique for the
-- life of the chat. `seq` is ONLY an ordering/read cursor and is assigned by the
-- server (max+1 per session), never by the client.
--
-- This split is load-bearing. `seq` used to be the message's index in pi's live
-- in-memory array, inserted ON CONFLICT DO NOTHING. That array is the resolved
-- LLM context, which legitimately shrinks (compaction), rewinds (branching), and
-- gets spliced on a failed turn — so a later message could land on a slot an
-- earlier, DIFFERENT message already held, and the insert silently dropped it.
-- Keyed by entry_id a conflict means "same message, already stored", so re-sends
-- and retries are safe and two messages can never collide.
CREATE TABLE IF NOT EXISTS message (
  chat_id      text NOT NULL REFERENCES chat(id) ON DELETE CASCADE,
  seq          integer NOT NULL,
  entry_id     text,              -- pi SessionEntry.id (null only on pre-existing rows)
  parent_id    text,              -- pi SessionEntry.parentId
  role         text NOT NULL,     -- 'user' | 'assistant' | 'tool'
  content      text,
  reasoning    text,
  tool_calls   text,              -- JSON array
  tool_call_id text,
  tool_name    text,
  created_at   bigint NOT NULL,
  PRIMARY KEY (chat_id, seq)
);
ALTER TABLE message ADD COLUMN IF NOT EXISTS entry_id  text;
ALTER TABLE message ADD COLUMN IF NOT EXISTS parent_id text;
-- NULLs don't conflict in Postgres, so legacy rows (no entry_id) coexist.
CREATE UNIQUE INDEX IF NOT EXISTS idx_message_entry ON message (chat_id, entry_id);

-- Full-text search over chat messages, for the agent's `search_chats` tool.
--
-- Indexed content is USER AND ASSISTANT text only. Tool output is deliberately
-- excluded: a single directory listing is larger than a whole conversation, so
-- indexing it would bury real matches under file dumps.
--
-- The tsvector is GENERATED, so Postgres maintains it on every insert and update
-- — it can never drift from the row the way a trigger-updated copy can.
ALTER TABLE message ADD COLUMN IF NOT EXISTS search_text tsvector
  GENERATED ALWAYS AS (
    CASE WHEN role IN ('user','assistant')
         THEN to_tsvector('english', coalesce(content,''))
         ELSE NULL END
  ) STORED;
CREATE INDEX IF NOT EXISTS idx_message_search ON message USING gin (search_text);

-- Images the user sent with a message — what the chat UI draws.
--
-- Keyed by entry_id, NOT seq: entry_id is the message's identity, and seq is
-- assigned by the server after the fact, so it isn't known to whoever builds the
-- row. Inserted in the same transaction as the message, and only when that
-- message actually inserted, so a re-sent turn can't duplicate its images.
--
-- These bytes also sit inside chat.transcript — pi's own session file, which we
-- store whole and never parse. This table is our copy, in a shape that can be
-- served one image at a time instead of by downloading a whole conversation.
CREATE TABLE IF NOT EXISTS attachment (
  id         text PRIMARY KEY,
  chat_id    text NOT NULL REFERENCES chat(id) ON DELETE CASCADE,
  entry_id   text NOT NULL,      -- the message's pi SessionEntry.id
  idx        integer NOT NULL,   -- ordinal within that message
  mime_type  text NOT NULL,
  bytes      bytea NOT NULL,
  created_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attachment_msg ON attachment (chat_id, entry_id);
