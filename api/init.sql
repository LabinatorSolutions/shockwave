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

-- Chats. `workspace_id` references the shared workspace identity (NOT a local
-- path). The transcript JSONL stays machine-local (derived from session_id on
-- the desktop), so it isn't a column here. `deleted` is a tombstone.
CREATE TABLE IF NOT EXISTS chat_session (
  session_id    text PRIMARY KEY,
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
  starred       boolean NOT NULL DEFAULT false,
  deleted       boolean NOT NULL DEFAULT false,
  -- Cross-client execution flag. The executing machine sets running=true on
  -- agent_start and clears it AFTER uploading the turn, so running=false means
  -- "done and uploaded". running_machine names which client is executing.
  running         boolean NOT NULL DEFAULT false,
  running_machine text
);
CREATE INDEX IF NOT EXISTS idx_chat_session_ws_updated ON chat_session (workspace_id, updated_at);
-- Existing volumes (table already created before these columns) get them here.
ALTER TABLE chat_session ADD COLUMN IF NOT EXISTS running boolean NOT NULL DEFAULT false;
ALTER TABLE chat_session ADD COLUMN IF NOT EXISTS running_machine text;

-- The pi transcript JSONL, stored whole (Postgres TOAST handles multi-MB text
-- fine — the "files not blobs" rule was a SQLite limitation). Lets any machine
-- continue any chat. One row per session.
CREATE TABLE IF NOT EXISTS chat_transcript (
  session_id text PRIMARY KEY REFERENCES chat_session(session_id) ON DELETE CASCADE,
  content    text NOT NULL,
  updated_at bigint NOT NULL
);

-- One row per pi message. Keyed by (session_id, seq) — globally unique because
-- session_id is a UUID and a chat has one writer. No autoincrement needed.
CREATE TABLE IF NOT EXISTS message (
  session_id   text NOT NULL REFERENCES chat_session(session_id) ON DELETE CASCADE,
  seq          integer NOT NULL,
  role         text NOT NULL,     -- 'user' | 'assistant' | 'tool'
  content      text,
  reasoning    text,
  tool_calls   text,              -- JSON array
  tool_call_id text,
  tool_name    text,
  created_at   bigint NOT NULL,
  PRIMARY KEY (session_id, seq)
);
