# Shockwave — Postgres + API rebuild

Status: **design agreed, not started.** Supersedes `docs/companion.md` (the SQLite/local-remote
companion design), which is now obsolete — this replaces the local DB entirely.

## Architecture

```
Desktop  = renderer + agent runtime + userData file + HTTP client   (NO local database)
API      = Express + Postgres  (holds all shared data + the master key + OAuth)
Postgres = the API's PRIVATE backend — never exposed to clients
```

The desktop talks to the API over HTTPS with a single **API_KEY**. It never talks to Postgres.
That's the whole simplification: one gateway, one credential, no local DB, no store seam, no
mirror, no machine-local DB tables.

## What lives where

**userData file (per machine, never synced):**
- window bounds, sidebar widths, chat-sidebar open/width, view mode, tree sort, bookmark filter
- active workspace id
- per-workspace machine bits: **checkout path** and **sync-toggle**, keyed by workspace id,
  **pruned on read** (drop entries for workspaces that no longer exist — the fix for the old
  `disabledWorkspaceIds` orphan bug)
- cron timing (`nextRunAt`/`lastRunAt` per job)
- the API connection: URL + API_KEY

**Postgres (shared only — the API owns it):**
- `workspace` — identity: id, name, repo_owner, repo_name, default_branch, sort_order
- `setting` — non-secret scalars (model/provider/thinking, appearance)
- `agent_secret` — credential metadata *(API role only)*
- `secret_value` — encrypted values *(API role only)*
- `chat_session`, `message`

**Gone entirely:** `workspace_local`, `cron_state`, any `machine`/hostname column. The DB has zero
machine concept.

## Schema port (SQLite → Postgres, done once, server-side)

- `secret_value.iv` / `.tag` `blob` → **`bytea`**
- integer-ms timestamp columns → **`bigint`** (keep epoch-ms; no app change) 
- `message.id` autoincrement → **identity**
- `message_fts` (FTS5) → **title-only search** for v1 (drop the virtual table + triggers); revisit
  `tsvector`/`pg_trgm` later if content search is wanted
- the `workspace_local.active` partial-unique + NULL-distinct hack → **deleted** (table's gone)

## The API surface (Express, Bearer API_KEY)

- `GET /health` — unauth.
- **Settings** — `GET /settings` (assembled server-side, secrets decrypted), `PATCH /settings`
  (dotted-leaf patch, same shape the renderer's `buildPatch` already emits).
- **Secrets / agent tools** — `GET /secrets` (metadata), `GET /secret/:name` (a usable credential;
  OAuth → fresh token, refreshed server-side). These back `list_agent_secrets` / `get_agent_secret`.
- **OAuth** — `POST /oauth/exchange` (desktop hands over the auth code → API exchanges + stores),
  `POST /oauth/refresh`, `POST /oauth/disconnect`. Presets can stay client-side (non-secret).
- **Workspaces (identity)** — list / create / rename+reorder / delete.
- **Chats** — list / search (title) / get session / star / rename / delete; `GET /chat/:id/messages`;
  `POST /chat/:id/messages` (the `persistMessages` append — send new rows past the stored count).
- Auth: `crypto.timingSafeEqual` on the API_KEY; helmet; rate limit; non-leaking errors; pino.

Messages return in the **exact current row shape** (`role`/`seq`/`content`/`reasoning`/`toolCalls`
-as-JSON/`toolCallId`) so `chatStore.hydrateMessages` is untouched.

## Desktop conversion (handler by handler)

The renderer is already insulated behind `window.api.*` — it barely changes. The work is main-side:

| Today (local DB) | After |
|---|---|
| `settings:read/write` → `readSettings`/`writeSettings` (store seam) | → API `GET/PATCH /settings`; machine-local keys → userData |
| `chat:*` → `db/index` functions | → API chat endpoints |
| `workspace:*` (git + DB) | git work stays local; identity → API; checkout path → userData |
| `oauth:*` | browser+loopback stays; code → API to exchange/store; refresh → API |
| cron | job defs from `<ws>/cron.json` (git, unchanged); timing → userData; runs locally |
| agent-tokens bridge → `getFreshToken`/`getAgentToken` | → API `GET /secret/:name` |

**Deletes on the desktop:** `src/main/db/` (connection + schema + all query fns), `better-sqlite3`
+ `electron-rebuild` postinstall + electron-builder native-unpack + `drizzle/` shipment,
`masterKey.ts`, `workspaceBackfill.js`, the whole `src/main/store/` seam + the mirror + reachability
fallback, half of `settingsStore.ts` (the local secret/read/write bodies + legacy import), the dead
`getCronState`/`touchSession`. `oauth.ts` splits (browser half stays, token half → API).

**Reuse, not rebuild:** the `companion/` Express server becomes this API (swap SQLite→Postgres,
add chat + oauth-token endpoints); `shared/store/core.ts` + `crypto.ts` move server-side and go
async; `store/remote.ts` becomes the desktop's API client.

## Offline posture (simple, no fallback)

No local DB → nothing to fall back to. API reachable → works. Unreachable → the operation fails and
the app shows a **notification**. The one care needed: the renderer's boot `Promise.all` (settings
read) must tolerate a failed/absent API instead of wedging boot — show "can't reach server, retry."

## Security

- Postgres is **private** to the compose network — not internet-exposed, so no client-facing DB
  TLS, no connection-string handout, no `shockwave_app` role. Only the API reaches it.
- Client ↔ API: HTTPS + API_KEY. IP-only + self-signed to start (`sslmode` moot — it's HTTP TLS on
  the API, standard).
- Secrets stay AES-256-GCM at rest under the API's master key (server-side); clients never see
  ciphertext.

## Phases

1. **API + Postgres up.** Port schema; settings + secret/agent-tools + OAuth-token endpoints.
   Desktop settings + agent-tokens bridge → API. Machine-local settings → userData.
2. **Chats → API.** Sessions + messages + title search; `persistMessages` append endpoint.
3. **Workspaces → API.** Identity CRUD; checkout path + sync-toggle → userData (prune-on-read);
   active workspace → userData.
4. **OAuth split.** Desktop code → API exchange/refresh/store.
5. **Delete the dead desktop DB layer + deps.** Drop `better-sqlite3`, `db/`, `store/`, `masterKey`,
   the mirror, the companion config sealing.

## Future (parked)

Per-workspace databases the agent can query directly (scoped read-only role) — the only thing that
ever wanted direct Postgres access. Layers on cleanly once the single-DB core is proven.
