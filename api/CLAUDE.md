# CLAUDE.md — companion server (`api/`)

The **companion** is the backend the desktop app talks to over HTTP. It is the **single source of truth** for everything synced: settings, secrets, workspaces (identity), chats + transcripts, and Telegram/cron state. It also *runs the coding agent server-side* for Telegram messages and scheduled (cron) jobs, using the same `agent-core` runtime the desktop bundles. Postgres is private to the compose network; the companion holds the one master encryption key. Read the root `CLAUDE.md` first for terminology and the desktop side.

Node 22 + Express 5 + Postgres (drizzle). Source is TypeScript + a couple of pure `.js` policy modules; esbuild bundles `src/` **and** `../agent-core` into `dist/server.js`.

## Install (`install.sh`)

One-liner for a fresh Linux box: `curl -fsSL https://raw.githubusercontent.com/stephengpope/shockwave/main/api/install.sh | sh`. Installs docker via get.docker.com if missing, sets up a ufw firewall (default-deny inbound; allows every configured sshd port + 80/443 — host hardening, the companion's surface is unchanged), fetches the compose file + traefik config + `init.sql` into `/opt/shockwave-companion`, generates `.env` secrets (never overwritten after first run), **resolves this server's public address once and records it as `COMPANION_HOST`**, installs the `shockwave` command on PATH, pulls the prebuilt image, waits for `/health`, then prints the server URL, API key, and — in self-signed mode — **the certificate fingerprint to approve in the desktop**.

Re-running is the update path. Secrets are never regenerated, and **only flags you actually pass are updated** (`env_set` rewrites one key in place), so `--domain=` on a re-run adds a domain to an existing install — it used to be silently ignored, leaving no supported way to move off self-signed. `COMPANION_HOST` is refreshed if the public IP changed.

Flags: `--domain=`, `--cert-email=`, `--yes`, `--no-firewall`. (`--cert-email` ↔ `COMPANION_CERT_EMAIL`: env vars carry a project prefix since they share a global namespace, flags don't since they're already scoped — strip the prefix and the two should be the same word. The old pair was `--email` ↔ `ACME_EMAIL`, which matched on neither count and named a protocol nobody filling in the field has heard of.) Test hooks: `SHOCKWAVE_DIR`, `SHOCKWAVE_RAW_BASE` (point at a `file://` checkout).

The image is `ghcr.io/stephengpope/shockwave-companion` — published multi-arch by `.github/workflows/companion-image.yml` on the **same `v*` tag** that cuts a desktop release, tagged `<tag>` + `latest`, with the tag baked in as `APP_VERSION` (surfaced by `GET /health` as `version`; `'dev'` for local builds). Compose has both `image:` and `build:` with `pull_policy: missing`: plain `docker compose up -d` pulls (install path), `docker compose up -d --build` builds from source (dev path). The image ref is `:${SHOCKWAVE_TAG:-latest}` — fresh installs run `latest`; a remote upgrade (below) pins `SHOCKWAVE_TAG` in `.env` so the compose/traefik files and the image are always the same release.

## Remote upgrade (`updater/`, `POST /update`)

The desktop compares its own version against `GET /health`'s and, when the companion is behind, offers a one-click upgrade → `POST /update {tag}` (bearer-authed; tag strictly `^v\d+\.\d+\.\d+$`). The route writes the tag to `UPDATE_TRIGGER_DIR` (the `updater-trigger` volume); the **`updater` compose service** (stock `docker:27-cli` + `updater/watch.sh`, holds the docker socket, deliberately zero network surface — the trigger is a file, not a listener) picks it up and spawns a **detached one-shot helper** running `updater/apply.sh` (detached so `up -d` recreating the updater itself can't kill the run). `apply.sh`: stage-fetch that tag's runtime files from raw.githubusercontent.com (all-or-nothing; `SHOCKWAVE_RAW_BASE` test hook, `file://` supported) → pull the tag's image **using the staged compose** (nothing on disk changes until the image is on the box) → `mv` files into place (rename, never cp — apply.sh replaces itself) → pin `SHOCKWAVE_TAG` in `.env` → `docker compose up -d --remove-orphans`. Every failure aborts with the old stack untouched. Schema migrations ride along (the image carries `init.sql`; `ensureSchema` re-applies on boot). A 503 `updater-unavailable` from `POST /update` = a pre-sidecar deployment; the desktop tells the user to re-run install.sh once. Not covered (by design): a release adding a **required** `.env` secret still needs the install one-liner.

## Deploy model (`docker-compose.yml`)

Six services (postgres, api, traefik-config, traefik, updater, autoheal):

- **postgres** (`postgres:16-alpine`) — private to the compose network, **not** port-mapped by default. `init.sql` is mounted into `/docker-entrypoint-initdb.d` (runs once on a fresh `pg-data` volume); `ensureSchema` re-applies it idempotently on every boot.
- **api** — built from the **repo root** (`context: ..`, `dockerfile: api/Dockerfile`) so the build can pull in `../agent-core`. Bound to **`127.0.0.1:8080` only** — localhost, never a public surface. Reaches Postgres over the compose net. Shares the `traefik-dynamic` volume (writes a self-signed cert + `tls.yml` there in self-signed mode).
- **traefik-config** (`alpine`, `restart: no`) — one-shot sidecar; `gen-router.sh` writes the Traefik dynamic router from `$COMPANION_DOMAIN`, then exits.
- **traefik** (`traefik:v3.3`) — the **only** public surface; `:80`→`:443`, terminates TLS, reverse-proxies to `http://api:8080`. Self-signed by default; real Let's Encrypt when `COMPANION_DOMAIN` is a domain.
- **updater** (`docker:27-cli` + `updater/watch.sh`) — the remote-upgrade sidecar. Holds the docker socket and has **deliberately zero network surface**: its trigger is a file on the `updater-trigger` volume, not a listener. See "Remote upgrade" above.
- **autoheal** (`willfarrell/autoheal`) — restarts any container labeled `autoheal=true` (today: `api`) once Docker marks it unhealthy, via the api's Dockerfile `HEALTHCHECK`. Compose's own `restart:` policy only covers a *crashed* process, not a wedged one, and there is no operator on the box to notice a companion that stopped answering.

**Three exposure modes:** (a) localhost dev on `127.0.0.1:8080`; (b) public via Traefik TLS on `:443` — self-signed cert for `COMPANION_HOST` with no domain, Let's Encrypt with `COMPANION_DOMAIN`; (c) **ngrok raw tunnel** straight to `127.0.0.1:8080` (ngrok brings its own trusted cert, so set `COMPANION_DOMAIN` to the ngrok host and Traefik/self-signed is bypassed).

### TLS is settled at boot, before the server answers (`settleTls`)

- **No domain** → create-or-reuse the self-signed certificate for `COMPANION_HOST`. **A failure is fatal**, exiting like a missing `MASTER_KEY` does. Coming up anyway means Traefik serves its own throwaway certificate, desktops approve *that*, and the real one replaces it later — a server whose identity is about to change is worse than one that didn't start.
- **Domain set** → `removeSelfSignedCert()`. Let's Encrypt owns the certificate, so a spare private key claiming to be this server, still registered as Traefik's default, is pure risk with nothing using it.

`/telegram/connect` **reads** the certificate (`readCertPem`) and never creates one. It used to create it, which meant a fresh install had no certificate of ours at all — Traefik served its throwaway, the desktop approved that, and connecting Telegram swapped it. The fingerprint changed on a routine action, and a user who meets the desktop's identity-changed warning during normal setup learns to click through the one prompt that catches a real attack. Reuse is also why `certUsable` exists: regenerating when nothing changed would move the server's identity for no reason and force every desktop to approve again.

**One command on PATH: `shockwave`** (`api/host/shockwave`, symlinked once from the install dir into `/usr/local/bin`). Subcommands: `fingerprint` prints the certificate's fingerprint — the value the desktop asks you to compare against — `rotate-cert` deletes it and restarts the api so boot makes a fresh one (one code path, no second implementation), plus `status` / `logs` / `version`. Rotating is the recovery for a stolen private key; there is no detection for that, and rotating forces re-approval on every desktop, which is the point.

> **Add subcommands to `host/shockwave`; never add a second file to `/usr/local/bin`.** This used to be one generated script per command, each written by `install.sh` from a heredoc and symlinked separately. Those scripts existed nowhere but inside the installer, and upgrades only fetch a fixed file list — so no upgrade could ever deliver them. A box installed before a command existed simply never had it, with no way to find out but typing it. Now the symlink's target path never changes, so replacing one file IS the update, and `apply.sh` never needs to write outside the install dir (it can't: `watch.sh` mounts only that dir into the helper). `tests/hostArtifacts.test.js` pins all of it — one symlink in `install.sh`, none in `apply.sh`, and every file `install.sh` fetches must also be in `apply.sh`'s `FILES`.

**Env (`.env`, see `.env.example`):** required `POSTGRES_PASSWORD`, `MASTER_KEY` (32 bytes base64 — validated at boot, process exits if missing/wrong length), `API_KEY` (bearer token; the server stores only its SHA-256 hash). `COMPANION_HOST` — this server's public address, **written by the installer** and required in self-signed mode (the certificate is issued for it at boot). Optional `COMPANION_DOMAIN` (domain or ngrok host; empty ⇒ self-signed mode), `COMPANION_CERT_EMAIL` (Let's Encrypt expiry warnings), plus tunables `PORT`, `CRON_ENABLED`, `CRON_REFRESH_SCHEDULE`, `CRON_MAX_RUN_MINUTES`, `RUN_DIR_TTL_DAYS`. `api/.env` is git-ignored — never commit it.

> **An IP in `COMPANION_DOMAIN` is normalized to `COMPANION_HOST`, in three places.** The two variables are one thing — this server's address — split by which TLS mode you want, and nothing checked that the value suited the variable. An IP in the domain slot took the worst path available: `settleTls` deletes the self-signed certificate because a real one is supposedly coming, Let's Encrypt can never issue for a bare IP so none arrives, and Traefik falls back to the throwaway certificate it regenerates at **every startup** — a new fingerprint for every desktop to approve after every restart, which is how you teach someone to click through the one prompt that catches a real attack. An IP can only mean self-signed, so `normalizeTlsEnv` (`server.ts`, before any reader), `gen-router.sh` (different container, can't see the first), and `install.sh --domain=` all map it to the host and say so. The check rejects non-IP characters first so a hostname that merely starts like one (`10.0.0.1.nip.io`) keeps its real certificate.

**The three secrets are deleted from `process.env` right after boot reads them** (`server.ts`). pi spawns the agent's `bash` with `{ ...process.env }`, and `gitFixer`/`git.ts` inherit it too — so without this, anything the agent could be told to run could `env` and read the master key that decrypts every row in `secret_value`, the bearer key, and the Postgres password. Telegram and cron turns run unattended, so that instruction can arrive as a file in a repo, a `cron.json` prompt, or a DM. Not complete on Linux (`/proc/<pid>/environ` still holds the originals from exec); it closes `env`/`printenv`, and the full fix is to stop passing them as env at all.

**`COMPANION_HOST` is not looked up at runtime.** The installer already resolves the public IP to print your Server URL, and the certificate must be issued for the exact address you type into the desktop — two independent lookups can disagree, and then the certificate is for one address while you connect to another. One lookup, at install, written down.

## Files

- `server.ts` — Express app: boots the pool + companion agent runtime, registers all routes + the bearer-auth middleware, the SSE feed, scheduler + sweeper, graceful shutdown.
- `db.ts` — pg `Pool` + drizzle wiring; `int8`→`Number` parser (epoch-ms); `ensureSchema` (idempotent `init.sql` re-apply on boot).
- `schema.ts` — drizzle table definitions (source of truth); `bytea` custom type + `epochMs` bigint helper.
- `store.ts` — the data layer: every drizzle query; seals/unseals secrets; `readSettings`/`writeSettings`, chats, transcripts, cron history, telegram account.
- `crypto.ts` — AES-256-GCM `seal`/`unseal` under `MASTER_KEY`; fresh 12-byte IV per write; returns `''` on decrypt failure.
- `keys.js` — **pure** key policy (no db/electron import, unit-testable): which `(owner, field)` pairs are secret, agent-secret field lists, OAuth-owned fields, settings flatten/`setPath`, agent-secret split/join, value encode/decode. It does **not** declare which fields are credentials — it derives all three lists from `agent-core/credentials.js` (`settingsCredentialPatterns()`, `agentSecretFields()`, `oauthOwnedFields()`), the one declaration bundled into both builds. Add a credential there, not here.
- `oauth.ts` — server-side token minting: `mintToken(name)` → a static token or a fresh (refreshed) OAuth access token; `patchOAuth` writes tokens back. (The desktop runs the *interactive* OAuth browser flow; the companion stores + mints.)
- `agentHost.ts` — builds the companion `AgentHost` for `agent-core`: persistence → store, events → feed, per-run scratch dir (`AGENT_DATA_DIR`, on the `agent-data` volume — the Dockerfile pre-creates + chowns it so the volume inherits `node` ownership), `send_message` tool, `getToken` → `mintToken`.
- `feed.ts` — in-memory ephemeral SSE pub/sub, ONE global channel (not per chat). A desktop can't subscribe per chat: the point is to hear about turns it doesn't know exist yet (Telegram, cron, another machine). Every event carries its `chatId`, so the client routes. Never stored — it mirrors what the `message` table already holds, so a client that misses events re-reads with `?after=`.
- `scheduler.ts` — croner scheduler: one fire-cron per `cron.json` entry + a refresh cron that reconciles registrations non-destructively (ETag).
- `cronRun.ts` — executes one cron run: checkout → agent turn (stream to feed) → deterministic check-in (git-fixer on conflict).
- `git.ts` — server-side git CLI: `prepareCheckout` (reuse-or-shallow-clone), `checkIn` (add/commit → `syncAndPush`), `syncAndPush` (fetch/merge/push, one retry), `cleanup`. **The PAT is never in the remote URL.** `clone` and `remote set-url` both persist whatever URL they're given into `<dir>/.git/config`, and `<dir>` is the agent's own cwd for the turn — so an embedded PAT was a file the agent could read (`git remote -v`), granting write access to every repo the token covers, for `RUN_DIR_TTL_DAYS` after the run. Auth now goes through a `GITHUB_PAT` child env (`gitEnv`) answered by a credential helper passed **on the command line** — nothing on disk, same mechanism as the desktop's `src/main/sync.ts`. Existing checkouts predating this still hold the old URL — `prepareCheckout` rewrites it on reuse, but wipe `WORK_BASE` on deploy to be sure. **Every PAT-carrying call also gets `guards()`** — see the boxed rule below.
- `gitFixer.ts` — bounded LLM tool-loop (single `run_git` tool, `MAX_STEPS=12`) that recovers merge conflicts and independently verifies the tree is clean with no surviving markers — trusting nothing the model claims. It holds **no credentials**: it resolves and commits locally, and the caller pushes afterwards via `syncAndPush`. Deliberate — `run_git` is a model-controlled shell running over conflict text that came from outside, which is the last place a PAT should be reachable.
- `github.ts` — `fetchCronJson` over the GitHub Contents API, ETag-conditional (304 = unchanged, free).
- `sweeper.ts` — boot + hourly TTL sweep of per-run working dirs (checkouts + pi scratch), keyed by mtime.
- `telegram/webhook.ts` — connect/disconnect/status + the webhook handler and out-of-band turn runner.
- `telegram/commands.ts` — the slash commands (`/help`, `/new`, `/chats`, `/chat n`, `/workspaces`, `/workspace n`, `/status`, `/btw`) + `BOT_COMMANDS` + `activeWorkspace`. Answer in-chat, run no turn.
- `telegram/btw.ts` — `/btw <question>`: one short model call over the chat's stored messages. Not a turn — it never steers, never joins the conversation, touches no files, and works WHILE a job is running (which is the point). It can see an in-flight job only because messages are stored as pi completes each one.
- `telegram/transcribe.ts` — AssemblyAI transcription for voice notes, using the same `transcription.apiKey` the desktop mic uses. Telegram sends OGG/Opus, which AssemblyAI takes as-is.
- `telegram/client.ts` — minimal Telegram Bot API client over `fetch` (one 429 retry) + `splitMessage` (4096-char chunker that carries code fences).
- `telegram/stream.ts` — renders the agent event stream to Telegram (typing indicator, per-tool line, in-place streamed text, authoritative final from `agent_end`).
- `telegram/selfSigned.ts` — the self-signed certificate + Traefik dynamic-TLS config (public server, no domain). `ensureSelfSignedCert` create-or-reuses for `configuredHost()` (= `COMPANION_HOST`); `readCertPem` is what `/telegram/connect` uses to hand Telegram a copy; `removeSelfSignedCert` deletes it when a domain is set. **Created once, at boot** (`settleTls` in `server.ts`), and a failure there is fatal — see the boxed note below.
- `gitRemote.js` — **pure** remote-URL policy (`remoteUrl`, `hasEmbeddedCredentials`), unit-tested by `tests/gitRemote.test.js`. Pins the "no credentials in the URL" property that `git.ts` depends on.
- `telegram/sendTool.ts` — `sendTelegramMessage(pool, key, text)`: the one place a DM is actually sent (the bot token lives only here). Two callers — the `send_message` agent tool (`agent-core/sendMessage.ts`) and `POST /telegram/send`, which is how the *desktop's* copy of that tool reaches it.

### The PAT runs git inside a directory the agent controls — `guards()` is what makes that safe

The checkout is the agent's own cwd for the turn, and `checkIn`/`syncAndPush` run git **in that same directory afterwards** with the PAT in the child's environment. So anything git can be made to execute at that moment can read the token. `guards()` in `git.ts` precedes **every** PAT-carrying call (`git()` applies it whenever `auth` is passed, and the `clone` in `prepareCheckout` passes it explicitly). Command-line `-c` beats repository config, which is the whole point — every value below is one the agent could otherwise set in `.git/config`:

| Guard | What it closes |
|---|---|
| `credential.helper=` (empty, **first**) | the setting is a LIST; assigning empty resets it, so a helper planted in the repo can't run ahead of ours |
| `credential.https://github.com.helper=…` | **host-scoped on purpose.** `url.<base>.insteadOf` rewrites the URL *after* `remote.origin.url` is pinned, and no `-c` can clear it (the subsection name is the agent's to choose) — so the request can leave for any host. Scoping means git asks that host's credentials and finds no helper. A bare `credential.helper` answered everyone, because the helper echoes the PAT without reading the host git hands it on stdin |
| `remote.origin.url=…` | left to the repo it can be `ext::sh -c …`, a command rather than an address. Pinning also keeps refs at `origin/<branch>` — a bare URL lands in `FETCH_HEAD` and quietly changes what the merge compares against |
| `core.hooksPath=/dev/null` | **not a directory.** Git looks up `<hooksPath>/<hookname>`; under the null device that is ENOTDIR, always. This used to name an empty directory under `WORK_BASE`, sitting beside the agent's own checkout and owned by the same user — empty only until the agent drops a file in. `--no-verify` covers `pre-push` alone, not `post-checkout` (clone) or `reference-transaction` (fetch) |
| `core.fsmonitor=` / `core.sshCommand=` | both name a command git runs |

`checkIn` and `syncAndPush` also pass `--no-verify` on `commit`/`merge`/`push`, so two independent things would have to be wrong for a planted hook to see the token. `prepareCheckout` additionally deletes `.git/hooks` on reuse — `reset --hard` + `clean -fd` never touch `.git`, so yesterday's hook would otherwise still be sitting there; the hooksPath guard already neuters it, this just stops it waiting for a call that forgets the guard.

**`gitFixer.ts` gets no credentials at all** and the push happens after it, in `syncAndPush`. Its `run_git` is a model-controlled shell running over conflict text that came from outside — the last place a PAT should be reachable.

`tests/gitGuards.test.js` pins all of this against **real git**: each attack is planted and an actual push is run, because the claim is "git does not execute the agent's code while holding the token", and only git can settle that. It also checks the helper still answers for github.com — without that, a scoping typo would break sync silently instead of failing a test.

## HTTP API (`server.ts`)

**Public (no bearer):**
- `GET /health` — `SELECT 1`; 200/503, plus `version` (the image's release tag; `'dev'` locally). Registered before auth.
- `POST /telegram/webhook` — Telegram inbound. Auth is the per-account `X-Telegram-Bot-Api-Secret-Token` header, checked **inside** `handleWebhook`. Registered before the bearer middleware, with its own JSON parser.

**Auth:** `authed` middleware compares `Bearer <token>` SHA-256 against the stored `API_KEY` hash with `timingSafeEqual` (401 otherwise). `app.use(authed, limiter, express.json())` protects + rate-limits (600/60s) + parses everything below.

**Protected:** `POST /update` (remote upgrade — see above); `GET/PATCH /settings`; `GET /agent-secrets`, `GET /agent-secret/:name/token` (mint), `POST /oauth/:name`; chats (`GET /chats`, `/chats/pinned`, `/chats/search`, `/chat/:id`(+`/messages` — `?after=<seq>` for just the newer ones, `/transcript`, `/running`), `POST /chat`, `POST /chat/:id/messages`, `PATCH /chat/:id/{title,pinned}`, `DELETE /chat/:id`); live feed (**`GET /events`** — one SSE stream for every chat; `POST /chat/:id/events` for a client relaying its own local run); cron (`POST /workspace/:id/cron/:job/run`, `GET /workspace/:id/cron/state`); workspaces (`GET/POST/PATCH /workspaces`, `DELETE /workspaces/:id`); telegram (`POST /telegram/{connect,disconnect,send,workspace}`, `GET /telegram/status` — `send` backs the desktop's `send_message` tool: `{text}` in, `{ok}`/`{ok:false,error}` out; `workspace` sets the bot's active workspace from the desktop's Telegram settings page, same start-a-fresh-chat semantics as `/workspace` in the bot; `status` includes the resolved `workspaceId`/`workspaceName`). The `handle()` wrapper returns `{result}` and never leaks error detail (`500 {error:'request failed'}`).

## Data model (`schema.ts` / `init.sql`)

- **workspace** — identity = a GitHub repo: `id`, `name`, `repo_owner`, `repo_name`, `default_branch`, `sort_order`. (Checkout path / active / sync-toggle are machine-local — they live on the desktop, not here.)
- **setting** — non-secret scalar settings, one row per dotted leaf key: `key`, `value`, `type` (`string|number|boolean|json`), `updated_at`.
- **agent_secret** — agent-secret entity metadata (no crypto columns): `name`, `description`, `kind` (`static|oauth`), the `oauth_*` columns, timestamps.
- **secret_value** — **every** encrypted value: PK `(owner, field)`, `ciphertext` (base64), `iv`+`tag` (`bytea`, `NOT NULL`), `key_version`, `updated_at`. `owner` ∈ {`settings`, `telegram`, an `agent_secret.name`}.
- **chat** / **message** — chats: session metadata + `source` (`desktop|cron|telegram`)/`source_id`/`machine` provenance + `running`/`running_machine` cross-client flag, plus the whole pi JSONL in a **`transcript` column** (it was a 1:1 `chat_transcript` side table, which bought nothing — Postgres TOASTs a big text column out of line and never reads it unless selected). `message` holds one row per pi session ENTRY, appended as pi completes it; identity is `entry_id` (pi's own id), and `seq` is an ordering/read cursor **assigned by the server**. It also carries a GENERATED `search_text` tsvector (user+assistant content only — tool output is deliberately unindexed) with a GIN index, backing the agent's `search_chats` tool.
- **telegram_account** — single row (`id='default'`): authorized user, dm chat id, active chat, **active workspace** (switchable via `/workspace`; falls back to the first workspace by `sort_order` — the top of the desktop's list), `last_update_id` (dedup), bot username, enabled. Token + webhook secret are encrypted in `secret_value` under owner `telegram`.
- **cron_state** — run **history** only, PK `(workspace_id, job_name)`: `last_run_at`/`last_error`/`last_chat_id`. Next-run is computed in memory by croner, never persisted.

## Settings + secrets

`readSettings` builds the object from `setting` rows (decoded by `type`), splices decrypted `secret_value` rows owned by `settings` at their field paths, and attaches `agentSecrets` + `workspaces`. **No defaults are applied — it returns exactly what is stored.** (The desktop merged defaults on read and faked unset values; that is gone. See "Defaults" below.)

`writeSettings` flattens a patch to dotted leaf keys and, in one transaction, routes each via `isSettingsSecretKey` → `putSecret(owner='settings', field=key)` or an upserted `setting` row, then reconciles `codingAgent.providerKeys` and `agentSecrets`. `putSecret` with empty plaintext **deletes** the row (absent = unset), else `seal` + upsert on `(owner, field)`.

**Encryption (`crypto.ts`):** AES-256-GCM under the single `MASTER_KEY`. Fresh 12-byte IV per write; `iv`/`tag` are `NOT NULL` in `secret_value`, so a plaintext credential is structurally unrepresentable. `unseal` returns `''` on failure so one bad row can't fail a whole read.

**Routing policy (`keys.js`, derived from `agent-core/credentials.js`):** `SETTINGS_SECRET_PATTERNS` = `codingAgent.providerKeys.<slug>`, `transcription.apiKey`, `sync.pat` (owner `settings`). `AGENT_SECRET_FIELDS` = `token`, `oauth.{clientSecret,accessToken,refreshToken}` (owner = the secret's `name`). `OAUTH_OWNED_FIELDS` (`oauth.accessToken`/`refreshToken`) are written **only** by the OAuth flow — a bulk `writeSettings` can't author them, so a client echoing pre-refresh state can't clobber a token the server just rotated.

### `secret_value` is shared — reconciliation must be SCOPED

`secret_value` holds three owner kinds: `settings`, `telegram`, and each agent-secret `name`. Any reconciliation must delete **only its own owners** — never "everything not in this list". Two guards, both in `store.ts`:

- **`writeAgentSecrets`** deletes only the agent secrets *removed from the incoming list*: it reads existing `agent_secret` names, computes `removed = existing − keep`, and deletes strictly `agent_secret`/`secret_value WHERE owner IN removed`. It is **not** a table-wide wipe. A previous version deleted every `secret_value` row except a hardcoded safelist, which clobbered the `telegram` `botToken`/`webhookSecret` on every settings save and broke the bot. **Never reintroduce a "delete all owners except X" here.**
- **`reconcileProviderKeys`** is likewise confined to owner `settings` + `like 'codingAgent.providerKeys.%'`.

## Defaults — there are none on read

The companion applies **no** defaults. A setting is set (a row exists) or unset. Consumers handle it in two ways:

- **Required** — no default; error if unset. `sync.pat` → `cronRun.ts` throws, `webhook.ts` replies in-chat, `scheduler.ts` skips. `codingAgent.provider`/`model` + the provider API key are read straight through; `agent-core` errors if empty ("provider not configured").
- **Optional** — fall back **at the point of use** in the consumer, not on read: `timezone → 'UTC'` and `thinkingLevel → 'off'` in both `cronRun.ts` and `telegram/webhook.ts` (and `scheduler.ts` for timezone).

Do **not** add a defaults object or seed default rows. The desktop learned this the hard way — a client-side default layer made an unset value look configured while the server (reading the DB directly) saw the hole and failed.

## Telegram

**Commands** (`telegram/commands.ts`, registered with `setMyCommands`): `/help` (what the bot is + every command), `/new`, `/chats` + `/chat n`, `/workspaces` + `/workspace n`, `/status` (workspace, chat, busy or idle, model), `/btw <question>`. Switching workspace starts a fresh chat — a chat belongs to one workspace. Which workspace Telegram runs against is `telegram_account.active_workspace_id` — set by `/workspace n` in the bot or the desktop's Telegram settings page (`POST /telegram/workspace`) — falling back to the first workspace by `sort_order` (the top of the desktop's workspace list). There is no env var for this; an earlier `TELEGRAM_DEFAULT_WORKSPACE` env fallback is gone. The `/new`, `/chat n`, `/workspace n`, and `/status` replies all name the workspace, so the user knows where the work lands.

**Voice notes**: a message with no text but `voice`/`audio` is downloaded (declined over 20 MB — Telegram's bot ceiling), transcribed, echoed back as `🎤 "…"` so the user sees what was heard, then run as the prompt. No key configured → says so rather than ignoring the message.

**Setup** (desktop Settings → `/telegram/{connect,disconnect,status}`): `connect` validates the token (`getMe`), mints a random webhook secret, registers the webhook (`allowed_updates:['message']`), and saves the account (botToken + webhookSecret encrypted under owner `telegram`; `dmChatId = authorizedTgUserId`, since private chats). `server.ts` resolves the public URL/cert first: `COMPANION_DOMAIN` set → `https://<domain>` (trusted, no PEM); unset → detect public IP + self-signed cert (Traefik serves it) → `https://<ip>` with the PEM uploaded to Telegram.

**Webhook (`handleWebhook`):** account enabled? → secret-token header timing-safe-checked (403 on mismatch) → sender must be `authorizedTgUserId` (single user, DM-only; unknown senders silently 200) → `markTelegramUpdate` dedups retries → **fast-ack 200**, then run the turn out-of-band.

**Concurrency — a second message while the agent is working.** The chat is marked busy for the whole job. A message arriving meanwhile is relayed into the RUNNING turn (pi delivers it at its next step), acknowledged with `⌛ Got it — after I finish the last task.` replied under the offending message, and then the handler **returns**. It must not fall through to the finish-up steps: those belong to the turn still in flight, and running them early committed half-edited files and abandoned the first reply mid-sentence. `agent-core` checks for a steer BEFORE validating provider/model, so the relay can pass none.

**Turn (`runTurn` → `runTurnInner`):** `runTurn` wraps the inner run in try/catch so **any failure replies in-chat** (`⚠️ Something went wrong running the agent:\n<message>`) and then rethrows for server logging — a silent failure reads as the bot ignoring you. `runTurnInner` handles `/new`,`/status`,`/help`; picks the workspace via `activeWorkspace` (in-chat error only when no workspaces exist); requires `sync.pat` (in-chat error if absent); `prepareCheckout` clones/refreshes via `git.ts`; runs `runtime.agentSend` under a `CRON_MAX_RUN_MINUTES` watchdog; dual-publishes each event to the `feed` (desktop watches live) and the Telegram sink; `checkIn`s the work afterward. `source: 'telegram'`, `sourceId` = DM chat id.

## Cron

`scheduler.ts` (gated by `CRON_ENABLED`): one croner per enabled `cron.json` entry (`protect:true`, workspace timezone), plus a refresh croner that `reconcileAll`s — fetches each workspace's `cron.json` via `fetchCronJson` (ETag/304) and updates registrations **non-destructively** (unchanged jobs keep running; changed schedules are replaced; vanished jobs dropped). `fireJob` mints a chatId, runs `runCronJob`, records history to `cron_state`. `cronRun.ts` is shared by the scheduler and the manual `POST …/cron/:job/run`: checkout → read the job prompt from the checkout's `cron.json` → agent turn streamed to the feed (watchdog) → deterministic `checkIn`, handing a `'conflict'` to `gitFix`. Checkout dirs are keyed by chatId (re-runs reuse) and reclaimed by `sweeper.ts`.

## Agent execution (`agentHost.ts`)

`makeCompanionRuntime(pool, key)` builds an `AgentHost` and calls `agent-core`'s `createAgentRuntime` — the same runtime the desktop implements, but wired to direct I/O instead of IPC: persistence → the drizzle store, events → `feed`, a per-run scratch `dataDir` keyed by chatId (isolates concurrent runs' pi `settings.json`), `extraTools = [send_message]` (built from `agent-core/sendMessage.ts` with `sendTelegramMessage` injected — the desktop offers the same tool, backed by `POST /telegram/send`), `getAgentSecrets` from `readSettings`, `getToken` → `mintToken`. Both cron and Telegram drive it via `runtime.agentSend(payload, emit)` / `runtime.agentAbort(chatId)`. The git-fixer (`gitFixer.ts`) runs a **separate** pi session from the turn.

## When you touch this

- **Adding a settings field:** it's just a `setting` row (or a `secret_value` row if it's a credential — declare it in `agent-core/credentials.js`, which `keys.js` derives from; editing `keys.js` itself is the wrong layer and desyncs the desktop's strip + send guard). No default to register anywhere — required fields error at their consumer, optional fields fall back at point of use.
- **Adding a `secret_value` owner category:** every reconciliation that deletes from `secret_value` must be scoped to its own owners (see the boxed rule above).
- **Schema change:** edit `schema.ts` *and* `init.sql` (both are re-applied idempotently). Keep them in sync.
