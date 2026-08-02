# CLAUDE.md — companion server (`api/`)

The **companion** is the backend the desktop app talks to over HTTP. It is the **single source of truth** for everything synced: settings, secrets, workspaces (identity), chats + transcripts, and Telegram/cron state. It also *runs the coding agent server-side* for Telegram messages and scheduled (cron) jobs, using the same `agent-core` runtime the desktop bundles. Postgres is private to the compose network; the companion holds the one master encryption key. Read the root `CLAUDE.md` first for terminology and the desktop side.

Node 22 + Express 5 + Postgres (drizzle). Source is TypeScript throughout — the pure policy modules (`keys.ts`, `gitRemote.ts`, `telegram/attachmentPolicy.ts`) used to be plain `.js` and no longer are. esbuild bundles `src/` **and** `../agent-core` into `dist/server.js`.

**`npm run typecheck` here is the only thing that checks this tree.** esbuild strips types without looking at them, and the root tsconfig's `include` is `src/**` with nothing under it importing `api/`, so tsc never reached a single file in this directory. `api/tsconfig.json` covers `api/src/**` plus `../agent-core/**` — the latter deliberately, since this tree compiles agent-core into the server bundle and it should be checked against *this* manifest's dependency versions, not only the desktop's. Run it before you ship; the build will not tell you.

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

**Env (`.env`, see `.env.example`):** required `POSTGRES_PASSWORD`, `MASTER_KEY` (32 bytes base64 — validated at boot, process exits if missing/wrong length), `API_KEY` (bearer token; the server stores only its SHA-256 hash). `COMPANION_HOST` — this server's public address, **written by the installer** and required in self-signed mode (the certificate is issued for it at boot). Optional `COMPANION_DOMAIN` (domain or ngrok host; empty ⇒ self-signed mode), `COMPANION_CERT_EMAIL` (Let's Encrypt expiry warnings), plus tunables `PORT`, `CRON_ENABLED`, `CRON_REFRESH_SCHEDULE`, `REVIEW_ENABLED`, `REVIEW_SCHEDULE`. `PI_CACHE_RETENTION: long` is set in compose and read by pi-ai straight from the environment: its default holds the Anthropic prompt cache for 5 minutes after the last message, which is shorter than the gaps in an ordinary Telegram conversation, so most turns re-read the whole system prompt and history from scratch. The trade is asymmetric — a cache write costs 2× base instead of 1.25×, but that applies only to the one new message, while a miss reprocesses everything before it and that grows with the conversation. (The per-run watchdog and the working-dir TTL used to be env here; they are now the synced settings `codingAgent.maxRunMinutes` / `codingAgent.scratchTtlDays`, so the desktop can set them and the desktop's own scratch cleanup expires on the same number.) `api/.env` is git-ignored — never commit it.

> **An IP in `COMPANION_DOMAIN` is normalized to `COMPANION_HOST`, in three places.** The two variables are one thing — this server's address — split by which TLS mode you want, and nothing checked that the value suited the variable. An IP in the domain slot took the worst path available: `settleTls` deletes the self-signed certificate because a real one is supposedly coming, Let's Encrypt can never issue for a bare IP so none arrives, and Traefik falls back to the throwaway certificate it regenerates at **every startup** — a new fingerprint for every desktop to approve after every restart, which is how you teach someone to click through the one prompt that catches a real attack. An IP can only mean self-signed, so `normalizeTlsEnv` (`server.ts`, before any reader), `gen-router.sh` (different container, can't see the first), and `install.sh --domain=` all map it to the host and say so. The check rejects non-IP characters first so a hostname that merely starts like one (`10.0.0.1.nip.io`) keeps its real certificate.

**The three secrets are deleted from `process.env` right after boot reads them** (`server.ts`). pi spawns the agent's `bash` with `{ ...process.env }`, and `gitFixer`/`git.ts` inherit it too — so without this, anything the agent could be told to run could `env` and read the master key that decrypts every row in `secret_value`, the bearer key, and the Postgres password. Telegram and cron turns run unattended, so that instruction can arrive as a file in a repo, a `cron.json` prompt, or a DM. Not complete on Linux (`/proc/<pid>/environ` still holds the originals from exec); it closes `env`/`printenv`, and the full fix is to stop passing them as env at all.

**`COMPANION_HOST` is not looked up at runtime.** The installer already resolves the public IP to print your Server URL, and the certificate must be issued for the exact address you type into the desktop — two independent lookups can disagree, and then the certificate is for one address while you connect to another. One lookup, at install, written down.

## Logging (`log.ts`)

One pino root; every subsystem logs through `logger(sub)` — a child with a `sub` field (`git`, `fixer`, `cron`, `telegram`, `agent`, `sweeper`, `http`) — so `docker compose logs api` (or `shockwave logs`) is the single place to look and one grep follows a run across subsystems by `chatId`. Don't `import pino` anywhere else.

**What gets a line: every boundary result.** A turn started/finished, a check-in's outcome, a fixer attempt's verdict, a git call that failed *and its stderr* (`errStr` prefers `e.stderr` — the part that says why). Not per-step chatter. The rule that matters: **a failure that is caught and converted into a status (`'error'`, `'conflict'`, a silent retry) must log before the conversion.** The catch blocks in `git.ts`/`gitFixer.ts` used to swallow the only evidence of why a run failed — a fixer whose model provider was unreachable produced exactly the same visible outcome as a merge it genuinely couldn't resolve. Related: a cron run whose check-in returns `'conflict'`/`'error'` no longer records as a clean run — `fireJob` writes it to `cron_state.last_error`, since work that never reached GitHub is a failed run even though nothing threw.

**Never log a payload that can carry secrets whole** (settings objects, agent run payloads — they hold API keys). Pick fields.

## Files

- `log.ts` — the one pino root + `logger(sub)` + `errStr`. See "Logging" above.
- `server.ts` — Express app: boots the pool + companion agent runtime, registers all routes + the bearer-auth middleware, the SSE feed, scheduler + sweeper, graceful shutdown.
- `db.ts` — pg `Pool` + drizzle wiring; `int8`→`Number` parser (epoch-ms); `ensureSchema` (idempotent `init.sql` re-apply on boot).
- `schema.ts` — drizzle table definitions (source of truth); `bytea` custom type + `epochMs` bigint helper.
- `store.ts` — the data layer: every drizzle query; seals/unseals secrets; `readSettings`/`writeSettings`, chats, transcripts, cron history, telegram account.
- `crypto.ts` — AES-256-GCM `seal`/`unseal` under `MASTER_KEY`; fresh 12-byte IV per write; returns `''` on decrypt failure.
- `keys.ts` — **pure** key policy (no db/electron import, unit-testable): which `(owner, field)` pairs are secret, agent-secret field lists, OAuth-owned fields, settings flatten/`setPath`, agent-secret split/join, value encode/decode. It does **not** declare which fields are credentials — it derives all three lists from `agent-core/credentials.ts` (`settingsCredentialPatterns()`, `agentSecretFields()`, `oauthOwnedFields()`), the one declaration bundled into both builds. Add a credential there, not here.
- `oauth.ts` — server-side token minting: `mintToken(name)` → a static token or a fresh (refreshed) OAuth access token; `patchOAuth` writes tokens back. (The desktop runs the *interactive* OAuth browser flow; the companion stores + mints.)
- `agentHost.ts` — builds the companion `AgentHost` for `agent-core`: persistence → store, events → feed, per-run scratch dir (`AGENT_DATA_DIR`, on the `agent-data` volume — the Dockerfile pre-creates + chowns it so the volume inherits `node` ownership), `send_message` tool, `getToken` → `mintToken`.
- `feed.ts` — in-memory ephemeral SSE pub/sub, ONE global channel (not per chat). A desktop can't subscribe per chat: the point is to hear about turns it doesn't know exist yet (Telegram, cron, another machine). Every event carries its `chatId`, so the client routes. Never stored — it mirrors what the `message` table already holds, so a client that misses events re-reads with `?after=`.
- `scheduler.ts` — croner scheduler: one fire-cron per `cron.json` entry + a refresh cron that reconciles registrations non-destructively (ETag).
- `cronRun.ts` — executes one cron run: checkout → agent turn (stream to feed) → deterministic check-in (git-fixer on conflict).
- `reviewSweeper.ts` — the review trigger: a croner tick that finds a chat which has done enough work and reviews it. See "Reviews" below.
- `reviewRun.ts` — executes one review run. `cronRun.ts` with a different trigger; same checkout → turn → `checkInWithFixer` shape.
- `git.ts` — server-side git CLI: `prepareCheckout` (claim-or-reuse-or-shallow-clone), `cloneFresh`/`refreshPristine` (shared with the checkout queue), `checkIn` (add/commit → `syncAndPush`), `syncAndPush` (fetch/merge/push, one retry), `landed`, `cleanup`. **`WORK_BASE` is `DATA_BASE/work`** — on the `agent-data` volume beside `runs/` and `files/`. It used to read a `CRON_WORK_DIR` env var that was set nowhere, so it fell back to the container's temp dir: the one thing here expensive to rebuild was the only one not kept, and every restart or `POST /update` made the next message in every chat re-clone. Derived from `DATA_BASE` now, so there is no variable to forget. **The PAT is never in the remote URL.** `clone` and `remote set-url` both persist whatever URL they're given into `<dir>/.git/config`, and `<dir>` is the agent's own cwd for the turn — so an embedded PAT was a file the agent could read (`git remote -v`), granting write access to every repo the token covers, for `RUN_DIR_TTL_DAYS` after the run. Auth now goes through a `GITHUB_PAT` child env (`gitEnv`) answered by a credential helper passed **on the command line** — nothing on disk, same mechanism as the desktop's `src/main/sync.ts`. Existing checkouts predating this still hold the old URL — `prepareCheckout` rewrites it on reuse, but wipe `WORK_BASE` on deploy to be sure. **Every PAT-carrying call also gets `guards()`** — see the boxed rule below.
- `gitFixer.ts` — LLM tool-loop (single `run_git` tool) that recovers merge conflicts and independently verifies the tree is clean with no surviving markers — trusting nothing the model claims. Retries up to `codingAgent.maxFixAttempts` (unset ⇒ 3), bounded overall by `codingAgent.maxRunMinutes`. It holds **no credentials**: it resolves and commits locally, and the caller pushes afterwards via `syncAndPush`. Deliberate — `run_git` is a model-controlled shell running over conflict text that came from outside, which is the last place a PAT should be reachable. Also exports **`checkInWithFixer`** — see the boxed rules below.
- `github.ts` — `fetchCronJson` over the GitHub Contents API, ETag-conditional (304 = unchanged, free).
- `sweeper.ts` — boot + hourly TTL sweep of per-run working dirs (checkouts + pi scratch), keyed by mtime. Sweeps `work/`, `runs/` and `files/`; the queue's `pool/` is a sibling it deliberately does not touch (the tick owns those).
- `checkoutPool.ts` — stocks the warm-checkout queue (the *taking* is `claimWarmCheckout` in `git.ts`). See "Starting a new chat shouldn't begin with a download" below.
- `telegram/webhook.ts` — connect/disconnect/status + the webhook handler and out-of-band turn runner.
- `telegram/commands.ts` — the slash commands (`/help`, `/new`, `/chats`, `/chat n`, `/workspaces`, `/workspace n`, `/status`, `/btw`) + `BOT_COMMANDS` + `activeWorkspace`. Answer in-chat, run no turn.
- `telegram/btw.ts` — `/btw <question>`: one short model call over the chat's stored messages. Not a turn — it never steers, never joins the conversation, touches no files, and works WHILE a job is running (which is the point). It can see an in-flight job only because messages are stored as pi completes each one. **The setup and the question are separate messages**: the role, the facts and the rendered conversation are the `systemPrompt`, and the user message is just `Here is the question: …`. One user turn carrying all of it left the instructions competing for attention with the transcript they were meant to be read against — and the role is stated as what the reader IS (an observer who has been handed a conversation and is about to be asked about it), not as a list of what it isn't. Tool rows stay summarised as `[ran bash]`: `/btw` answers about the shape of the work, not its contents. **`get_agent_secret`'s live output is named and never quoted** (`SECRET_OUTPUT_TOOLS`) — the result is a usable token and this answer goes out as a Telegram message. That is a name match on the tool, not a judgement: the output is never read into the prompt, so there is nothing for the model to decide. `list_agent_secrets` returns metadata only and is deliberately not on the list.
- `telegram/transcribe.ts` — AssemblyAI transcription for voice notes, using the same `transcription.apiKey` the desktop mic uses. Telegram sends OGG/Opus, which AssemblyAI takes as-is.
- `telegram/client.ts` — minimal Telegram Bot API client over `fetch` (one 429 retry) + `splitMessage` (4096-char chunker that carries code fences).
- `telegram/stream.ts` — renders the agent event stream to Telegram (placeholder bubble, per-tool line, in-place streamed text, authoritative final from `agent_end`). Starts no typing indicator — `runTurn` owns that.
- `telegram/selfSigned.ts` — the self-signed certificate + Traefik dynamic-TLS config (public server, no domain). `ensureSelfSignedCert` create-or-reuses for `configuredHost()` (= `COMPANION_HOST`); `readCertPem` is what `/telegram/connect` uses to hand Telegram a copy; `removeSelfSignedCert` deletes it when a domain is set. **Created once, at boot** (`settleTls` in `server.ts`), and a failure there is fatal — see the boxed note below.
- `gitRemote.ts` — **pure** remote-URL policy (`remoteUrl`, `hasEmbeddedCredentials`), unit-tested by `tests/gitRemote.test.js`. Pins the "no credentials in the URL" property that `git.ts` depends on.
- `telegram/sendTool.ts` — `sendTelegramMessage(pool, key, text)` and `sendTelegramFile(pool, key, path, kind)`: the one place a DM is actually sent (the bot token lives only here). Callers — the `send_message` agent tool (`agent-core/sendMessage.ts`), `POST /telegram/send` (how the *desktop's* copy of that tool reaches it), and `cronRun.ts` for files a scheduled job produced.
- `telegram/attachmentPolicy.ts` — **pure** inbound-attachment policy (`describeAttachment`, `sniffImageMime`, `safeName`, `classify`, the context notes, `composeMessage`), unit-tested by `tests/attachmentPolicy.test.js`. Same split as `gitRemote.ts` beside `git.ts`.
- `telegram/attachments.ts` — the two lines that touch disk: `cacheAttachment` writes into the chat's staging dir and re-checks containment.
- `dataDirs.ts` — where per-chat working files live (`RUNS_BASE`, `FILES_BASE`, `WORK_BASE`, and the queue's `POOL_SETUP_BASE`/`POOL_READY_BASE`). Path math only — which is both why it can be split out of `agentHost.ts` (needing a directory doesn't drag in Postgres and pi) and what lets `git.ts` own the claim while `checkoutPool.ts` owns the stocking, without the two importing each other. `FILES_BASE/<chatId>` is the agent's **scratch pad**: inbound attachments land there, the agent may write there, delivery reads from there, and the prompt names it. Outside the checkout, so nothing in it is committed.
- `telegram/transcribe.ts` — a thin adapter over `agent-core/transcribe.ts` for voice notes: bytes to a temp file, text back out. One speech-to-text implementation, shared with the agent's `transcribe` tool.

### The PAT runs git inside a directory the agent controls — `guards()` is what makes that safe

The checkout is the agent's own cwd for the turn, and `checkIn`/`syncAndPush` run git **in that same directory afterwards** with the PAT in the child's environment. So anything git can be made to execute at that moment can read the token. `guards()` in `git.ts` precedes **every** PAT-carrying call (`git()` applies it whenever `auth` is passed, and the `clone` in `prepareCheckout` passes it explicitly). Command-line `-c` beats repository config, which is the whole point — every value below is one the agent could otherwise set in `.git/config`:

| Guard | What it closes |
|---|---|
| `credential.helper=` (empty, **first**) | the setting is a LIST; assigning empty resets it, so a helper planted in the repo can't run ahead of ours |
| `credential.https://github.com.helper=…` | **host-scoped on purpose.** `url.<base>.insteadOf` rewrites the URL *after* `remote.origin.url` is pinned, and no `-c` can clear it (the subsection name is the agent's to choose) — so the request can leave for any host. Scoping means git asks that host's credentials and finds no helper. A bare `credential.helper` answered everyone, because the helper echoes the PAT without reading the host git hands it on stdin |
| `remote.origin.url=…` | left to the repo it can be `ext::sh -c …`, a command rather than an address. Pinning also keeps refs at `origin/<branch>` — a bare URL lands in `FETCH_HEAD` and quietly changes what the merge compares against |
| `core.hooksPath=/dev/null` | **not a directory.** Git looks up `<hooksPath>/<hookname>`; under the null device that is ENOTDIR, always. This used to name an empty directory under `WORK_BASE`, sitting beside the agent's own checkout and owned by the same user — empty only until the agent drops a file in. `--no-verify` covers `pre-push` alone, not `post-checkout` (clone) or `reference-transaction` (fetch) |
| `core.fsmonitor=` / `core.sshCommand=` | both name a command git runs |

`checkIn` and `syncAndPush` also pass `--no-verify` on `commit`/`merge`/`push`, so two independent things would have to be wrong for a planted hook to see the token. `prepareCheckout` additionally deletes `.git/hooks` on reuse — nothing it does to the worktree touches `.git`, so yesterday's hook would otherwise still be sitting there; the hooksPath guard already neuters it, this just stops it waiting for a call that forgets the guard.

**`gitFixer.ts` gets no credentials at all** and the push happens after it, in `syncAndPush`. Its `run_git` is a model-controlled shell running over conflict text that came from outside — the last place a PAT should be reachable.

`tests/gitGuards.test.js` pins all of this against **real git**: each attack is planted and an actual push is run, because the claim is "git does not execute the agent's code while holding the token", and only git can settle that. It also checks the helper still answers for github.com — without that, a scoping typo would break sync silently instead of failing a test.

### Every agent run checks in the SAME way — `checkInWithFixer`, never `checkIn`

There are two server-side agent paths, cron (`cronRun.ts`) and Telegram (`telegram/webhook.ts`), and they are one operation with different triggers. Both call **`checkInWithFixer(dir, branch, message, auth, model, limits)`** (`gitFixer.ts`): deterministic `checkIn` → on `'conflict'`, hand to `gitFix` → `syncAndPush` when it verifies clean. **No agent path calls `git.ts`'s `checkIn` directly** — that function is the mechanical half, and reaching for it is how a path ends up with only half the policy.

Which is exactly what happened. Telegram ran `checkIn(...).catch(() => {})` — no fixer, and the result discarded. A conflict left the turn's work committed-but-unpushed in the run's checkout, said nothing in chat, and the **next** message's `prepareCheckout` `reset --hard`'d it away: the failure and its evidence vanishing together, looking identical to a turn that saved fine. Telegram is if anything the more exposed path, since the user is typically at the desktop with sync pushing to the same repo while the bot works. A non-`'pushed'` result is now reported in-chat.

**A third agent path must call `checkInWithFixer` too.** The turn is the part that differs between callers (prompt source, event sink, `unattended`, one-time-job disposal); landing the work is not.

### Reusing a checkout: `fetch` (no `--depth`) then a GUARDED `reset --hard`

**`--depth=1` belongs on the clone and NOWHERE else.** On the initial clone it is the whole saving. On a fetch into an existing checkout it saves nothing — a fetch only ever transfers objects we don't already have (measured: 3, for a one-file change in a 200-file repo) — and it rewrites `.git/shallow` so the remote branch arrives as its own root commit with no link to what we hold.

That flag was on the reuse fetch, and it broke every reused checkout:

```
reuse:   fetch --depth=1 + merge --ff-only   → fatal: refusing to merge unrelated histories  (swallowed)
         the agent then reads a stale tree
checkIn: behind=1 → merge                    → fatal: refusing to merge unrelated histories
         no unmerged files → "pushing anyway" → push rejected, non-fast-forward
         3 retries, all identical             → 'conflict'
```

The user is told the save failed while the work sits in the folder. It fires whenever anything else pushes between two turns of the same chat — the desktop syncing, another chat, a cron job. A checkout that only ever pushes its own commits stays healthy, which is why it wasn't constant.

**A folder already grafted by the old code is not repaired** — the break is written into the repository, and only `git fetch --unshallow` can undo it. That is deliberately not done: those folders age out on `scratchTtlDays` (unset ⇒ 1 day), so the condition disappears on its own within a day, and carrying migration code in a permanent path to cover it costs more than it saves. A folder in that state keeps failing its push until it is removed.

With a connected history, *"is there anything to lose?"* has a real answer — so `reset --hard` is both safe and the operation actually wanted: one round trip, nothing that can half-succeed, an exact match with the remote.

| state | outcome |
|---|---|
| clean, already current | reset is a no-op |
| clean, behind | lands exactly on the remote |
| local unpushed commits | `nothingToLose` refuses, folder untouched |
| dirty tree | `nothingToLose` refuses, folder untouched |

**The guard is the whole difference** from the unconditional `reset --hard` + `clean -fd` that was removed here earlier — that one deleted work which hadn't reached GitHub, because a turn's changes are only safe once pushed and the push happens *after* the agent has replied. The objection recorded at the time was that shallow history makes ancestry unresolvable so the question can be answered wrong. **That was true of the code, not of git**: it was unresolvable *because* the fetch threw the link away. `nothingToLose` returns false on any error, so "I couldn't tell" still never licenses a wipe.

Nothing the guard declines to fold in is stranded: the turn's own `git add -A` sweeps it into the next commit, and `checkIn` reconciles with the remote at the end.

**The accepted cost is two agents briefly sharing one folder** — a confusing commit, or git refusing a concurrent operation. Both are loud and recoverable, which a deleted file is not. That trade is deliberate: the fixer's prompt tells it files may appear mid-resolution and to fold them in. Pinned by `tests/checkoutReuse.test.js` against real git — **which clones shallow**, because it used to clone full and therefore passed throughout the entire life of the bug.

### `'diverged'` is not `'conflict'` — the fixer can only fix one of them

`syncAndPush` returns `'conflict'` when the merge left markers in the tree: something `gitFix` can work on. It returns **`'diverged'`** when the merge could not START (no common history, or it would clobber local changes). Nothing is conflicted then, so the fixer's `verify` — clean tree, no markers — passes the moment it arrives, it reports success without doing anything, and `checkInWithFixer` retries the same doomed push. One status for both is how that hid; `checkInWithFixer` hands off only on `'conflict'`.

**Ask `landed(result)`, never `=== 'conflict' || === 'error'`.** That spelled-out list lived in three files, and a missed one reads a failure as a success and says nothing.

### Starting a new chat shouldn't begin with a download (`checkoutPool.ts`)

A chat's first message used to pay for a full clone while the user waited. The queue keeps one cloned ahead of time, and **a folder's LOCATION is its state**:

```
pool/setup/<owner>__<repo>__<branch>__<uuid>   being cloned — never read
pool/ready/<owner>__<repo>__<branch>__<uuid>   complete, usable
work/<chatId>                                  claimed; a chat owns it
```

Every move is a rename, and always forward. No marker file, no status column, nothing that can disagree with the disk — a clone that dies halfway is stranded in `setup/` and *cannot* be mistaken for usable, because being in `ready/` is what usable means. Renames are also what make it safe without a lock: `rename` is atomic within one filesystem, so two chats claiming at once cannot get the same folder — one wins, the other gets ENOENT and takes the next or clones. **All three directories live under `DATA_BASE` for exactly this reason**; across filesystems `rename` fails and the property is gone.

**Claiming is the only thing a turn does, and it has no side effects.** Restocking, refreshing and cleaning are one per-minute tick that reconciles the directory to the target, so a turn is never slowed by maintenance and the queue can be reasoned about on its own. Every failure path degrades to a normal clone.

**Every companion chat claims — Telegram and cron alike.** `prepareCheckout` calls `claimWarmCheckout` unconditionally, so there is one way to obtain a checkout rather than a fast path for some callers and a slow one for others. That is why **the claim lives in `git.ts`, not here**: it is a rename, and putting it there lets `prepareCheckout` call it without importing this module, which is built on `git.ts`'s clone and refresh. The path constants live in `dataDirs.ts` (path math, no dependencies) so nothing has to import in a circle. This module only stocks.

Cron consuming a slot was the argument for keeping it Telegram-only — a job at 09:00 takes the folder a person wants at 09:01. Real, but small: the tick restocks every minute and cron fires nowhere near that often, so two spares covers both, and what it buys is one code path.

**The queue holds ONE repo** — whatever Telegram is pointed at. A cron job on a different workspace finds no match and clones, exactly as before. Slots are already keyed by `owner__repo__branch`, so holding several repos later is widening a loop, not a redesign.

**One setting: `codingAgent.checkoutPoolSize`** (unset ⇒ 2, 0 disables), on Settings → Agent. The refresh window is a constant, deliberately: the claim always fetches, so it can only change how much that fetch pulls and never whether the result is correct — a knob that cannot affect an outcome is a knob to explain and get wrong. Refreshing a queued folder uses `refreshPristine`, an *unguarded* `reset --hard`, legitimate only because these folders have never been worked in; anything a user or agent has touched goes through `prepareCheckout`, which asks first. Claim semantics are pinned by `tests/checkoutPool.test.js`.

### The fixer is bounded by time and attempts, not tool calls

`gitFix` loops up to `codingAgent.maxFixAttempts` (unset ⇒ 3), re-running `verify` between attempts, with **one deadline across the whole loop** from `codingAgent.maxRunMinutes` — so the number means what it says however many attempts it takes.

Retrying works because **the folder persists between attempts and only the agent's memory doesn't**: attempt 2 opens a repo where whatever attempt 1 resolved is already resolved and committed. Three conflicted files, two attempts — the first clears A and B, the second sees only C. The other reason verification fails is the concurrency above: a second turn writing into the folder while the fixer works, where the fixer was right and the tree simply moved afterwards.

It used to abort the session at 12 tool calls. Resolving *one* conflicted file costs roughly seven, so that cap mostly severed legitimate work partway and reported it as a failure. **The fixer runs after the turn has already replied, so nothing user-facing waits on it** and there is no reason to hurry it. The time bound covers the only real hazard — a model looping on an unattended server.

## HTTP API (`server.ts`)

**Public (no bearer):**
- `GET /health` — `SELECT 1`; 200/503, plus `version` (the image's release tag; `'dev'` locally). Registered before auth.
- `POST /telegram/webhook` — Telegram inbound. Auth is the per-account `X-Telegram-Bot-Api-Secret-Token` header, checked **inside** `handleWebhook`. Registered before the bearer middleware, with its own JSON parser.

**Auth:** `authed` middleware compares `Bearer <token>` SHA-256 against the stored `API_KEY` hash with `timingSafeEqual` (401 otherwise). `app.use(authed, limiter, express.json())` protects + rate-limits (600/60s) + parses everything below.

> **The JSON body limit is 64mb, and 1mb was silently breaking things.** Two routes legitimately carry media and both failed as a 413 nobody saw: `PATCH /chat/:id/transcript` sends pi's **entire** session JSONL, re-uploaded every turn, which passes a megabyte on any chat with an image or merely enough tool output; and `POST /chat/:id/messages` carries a message's images base64 (+33%) on the row. Telegram already refuses anything over 20MB (`MAX_INBOUND_BYTES`), so that bounds the largest single file; the ceiling sits well above it because a transcript accumulates. What this widens is one bearer-authed, rate-limited server with a single user.

**Protected:** `POST /update` (remote upgrade — see above); `GET/PATCH /settings`; `GET /agent-secrets`, `GET /agent-secret/:name/token` (mint), `POST /oauth/:name`; chats (`GET /chats`, `/chats/pinned`, `/chats/search`, `/chat/:id`(+`/messages` — `?after=<seq>` for just the newer ones, `/transcript`, `/running`), `POST /chat`, `POST /chat/:id/messages`, `PATCH /chat/:id/{title,pinned}`, `DELETE /chat/:id`); **`GET /attachment/:id`** (one chat image — the only route that answers **raw bytes**, so it deliberately bypasses the `handle()` wrapper, which would wrap it in `{result}` JSON; ids are fresh uuids and the content never changes, so it's served `immutable` and a re-opened chat re-downloads nothing); live feed (**`GET /events`** — one SSE stream for every chat; `POST /chat/:id/events` for a client relaying its own local run); cron (`POST /workspace/:id/cron/:job/run`, `GET /workspace/:id/cron/state`); workspaces (`GET/POST/PATCH /workspaces`, `DELETE /workspaces/:id`); telegram (`POST /telegram/{connect,disconnect,send,workspace}`, `GET /telegram/status` — `send` backs the desktop's `send_message` tool: `{text}` in, `{ok}`/`{ok:false,error}` out; `workspace` sets the bot's active workspace from the desktop's Telegram settings page, same start-a-fresh-chat semantics as `/workspace` in the bot; `status` includes the resolved `workspaceId`/`workspaceName`). The `handle()` wrapper returns `{result}` and never leaks error detail (`500 {error:'request failed'}`).

## Data model (`schema.ts` / `init.sql`)

- **workspace** — identity = a GitHub repo: `id`, `name`, `repo_owner`, `repo_name`, `default_branch`, `sort_order`. (Checkout path / active / sync-toggle are machine-local — they live on the desktop, not here.)
- **setting** — non-secret scalar settings, one row per dotted leaf key: `key`, `value`, `type` (`string|number|boolean|json`), `updated_at`.
- **agent_secret** — agent-secret entity metadata (no crypto columns): `name`, `description`, `kind` (`static|oauth`), the `oauth_*` columns, timestamps.
- **secret_value** — **every** encrypted value: PK `(owner, field)`, `ciphertext` (base64), `iv`+`tag` (`bytea`, `NOT NULL`), `key_version`, `updated_at`. `owner` ∈ {`settings`, `telegram`, an `agent_secret.name`}.
- **chat** / **message** — chats: session metadata + `source` (`desktop|cron|telegram|review`)/`source_id`/`machine` provenance + `running`/`running_machine` cross-client flag + `last_reviewed_seq` (how far review has looked — see below), plus the whole pi JSONL in a **`transcript` column** (it was a 1:1 `chat_transcript` side table, which bought nothing — Postgres TOASTs a big text column out of line and never reads it unless selected). `message` holds one row per pi session ENTRY, appended as pi completes it; identity is `entry_id` (pi's own id), and `seq` is an ordering/read cursor **assigned by the server**. It also carries a GENERATED `search_text` tsvector (user+assistant content only — tool output is deliberately unindexed) with a GIN index, backing the agent's `search_chats` tool.
- **attachment** — images the user sent with a message: `id`, `chat_id`, `entry_id`, `idx`, `mime_type`, `bytes`, `created_at`. **This is what the chat UI draws.** Keyed by `entry_id` (the message's identity) and NOT `seq`, which the server assigns afterwards and the writer therefore doesn't know. Inserted in the same transaction as the message and **only when that message actually inserted**, so a retried or re-sent turn can't duplicate its pictures. The bytes also live inside `chat.transcript` — that's pi's own session file, stored whole and never parsed; this table is our copy in a shape that can be served one image at a time.
- **telegram_account** — single row (`id='default'`): authorized user, dm chat id, active chat, **active workspace** (switchable via `/workspace`; falls back to the first workspace by `sort_order` — the top of the desktop's list), `last_update_id` (dedup), bot username, enabled. Token + webhook secret are encrypted in `secret_value` under owner `telegram`.
- **cron_state** — run **history** only, PK `(workspace_id, job_name)`: `last_run_at`/`last_error`/`last_chat_id`. Next-run is computed in memory by croner, never persisted.

## Settings + secrets

`readSettings` builds the object from `setting` rows (decoded by `type`), splices decrypted `secret_value` rows owned by `settings` at their field paths, and attaches `agentSecrets` + `workspaces`. **No defaults are applied — it returns exactly what is stored.** (The desktop merged defaults on read and faked unset values; that is gone. See "Defaults" below.)

`writeSettings` flattens a patch to dotted leaf keys and, in one transaction, routes each via `isSettingsSecretKey` → `putSecret(owner='settings', field=key)` or an upserted `setting` row, then reconciles `codingAgent.providerKeys` and `agentSecrets`. `putSecret` with empty plaintext **deletes** the row (absent = unset), else `seal` + upsert on `(owner, field)`.

**Encryption (`crypto.ts`):** AES-256-GCM under the single `MASTER_KEY`. Fresh 12-byte IV per write; `iv`/`tag` are `NOT NULL` in `secret_value`, so a plaintext credential is structurally unrepresentable. `unseal` returns `''` on failure so one bad row can't fail a whole read.

**Routing policy (`keys.ts`, derived from `agent-core/credentials.ts`):** `SETTINGS_SECRET_PATTERNS` = `codingAgent.providerKeys.<slug>`, `transcription.apiKey`, `sync.pat` (owner `settings`). `AGENT_SECRET_FIELDS` = `token`, `oauth.{clientSecret,accessToken,refreshToken}` (owner = the secret's `name`). `OAUTH_OWNED_FIELDS` (`oauth.accessToken`/`refreshToken`) are written **only** by the OAuth flow — a bulk `writeSettings` can't author them, so a client echoing pre-refresh state can't clobber a token the server just rotated.

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

**Attachments in.** Any file — photo, document, video, album — is downloaded to the chat's staging dir (`FILES_BASE/<chatId>`, outside the checkout, TTL-swept) and described to the agent by a bracketed note giving the path and telling it to **act**, asking only when the intent is genuinely unclear. That imperative wording is copied from hermes-agent and is the whole reason a path pointer works; passive wording there made the model reply "what would you like me to do with this?" to a message that already said. Small text files are inlined instead, gated on the **extension** — never on whether the bytes decode, since PDF/zip/docx all start with decodable ASCII. Images are additionally attached as pi `ImageContent` when the configured model lists `image` input (`modelCatalog`); the note says so when it can't, rather than letting the agent claim it looked. **An image's type comes from its magic bytes**, not the filename or the sender's `mime_type` — a Telegram photo has neither, and providers reject a declared type that doesn't match the bytes, failing the whole turn. `msg.caption` is read as the prompt (without it a file arrives with no instructions), and albums are debounced 800ms into one message, because Telegram sends each item as its own update and the second would otherwise interrupt the first.

**Files out.** The agent names a path in its reply — `MEDIA:/abs/path` or bare — and `agent-core/mediaTags.ts` extracts it, strips it from the visible text, and the file is sent. Delivery reads from exactly two folders (the checkout and the chat's staging dir) with symlinks resolved first, which replaces hermes' hand-maintained denylist of credential paths. Telegram's path is `stream.ts` (which also strips tags from the live-edited message, or the raw tag is visible while it streams); cron's is `cronRun.ts`, since a scheduled run posts no reply to attach a file to. **Both scan text accumulated from this turn's deltas, never `agent_end.messages`** — that carries pi's whole session, so scanning it re-sends a file on every later turn. Desktop does neither, and `agent-core/defaults/companion.ts` keeps the syntax out of the desktop prompt so the agent can't promise a delivery that won't happen.

**Voice notes**: a message with no text but `voice` is downloaded (declined over 20 MB — Telegram's bot ceiling), transcribed, then run as the prompt. No key configured → says so rather than ignoring the message. **`audio` is NOT transcribed** — an audio file is a file and goes through the attachment path above. This read `voice ?? audio` and transcribed both, so sending an mp3 made its whole transcript the prompt. `resolveInput` reads settings **once** and passes `transcription.apiKey` into `transcribeAudio` (which holds no store import of its own), because it needs the neighbouring `echoTelegramTranscript` from the same object: when that is on, the transcript is posted back as `🎤 "…"` before the turn runs, so a misheard word is distinguishable from a misunderstood instruction. **Default off** — `?? false` at the point of use, since the companion stores no defaults. The desktop toggles it at Settings → Transcription.

Progress shows **on the voice message itself**, via `setMessageReaction`: ✍ before the download, 👍 once there are words and the turn is about to run, cleared on every bail-out so a dead ✍ never outlives the message explaining what went wrong. Bots get one reaction per message and a new one replaces the old, which is what makes the transition possible. The calls are best-effort but **awaited** — fired and forgotten, a ✍ that lands after the 👍 leaves the wrong state on screen permanently, and one round trip against seconds of transcription is not worth racing. Only `voice` gets them, because only `voice` is transcribed.

> **The reaction emoji are written as `\u{…}` escapes, and must stay that way.** Telegram's allowed set is a fixed list of 73 and **not one carries a variation selector** — the writing hand is `U+270D` alone, never `U+270D U+FE0F`. A glyph pasted from an emoji picker or a browser brings the selector with it, which is a different string than the one Telegram accepts, and the call returns `REACTION_INVALID`. The escape is the one spelling an editor can't silently change. Verified against the bytes in Telegram's own docs (each emoji is published as an image whose filename *is* its UTF-8 encoding: `E29C8D`, `F09F918D`).

**Setup** (desktop Settings → `/telegram/{connect,disconnect,status}`): `connect` validates the token (`getMe`), mints a random webhook secret, registers the webhook (`allowed_updates:['message']`), and saves the account (botToken + webhookSecret encrypted under owner `telegram`; `dmChatId = authorizedTgUserId`, since private chats). `server.ts` resolves the public URL/cert first: `COMPANION_DOMAIN` set → `https://<domain>` (trusted, no PEM); unset → detect public IP + self-signed cert (Traefik serves it) → `https://<ip>` with the PEM uploaded to Telegram.

**Webhook (`handleWebhook`):** account enabled? → secret-token header timing-safe-checked (403 on mismatch) → sender must be `authorizedTgUserId` (single user, DM-only; unknown senders silently 200) → `markTelegramUpdate` dedups retries → **fast-ack 200**, then run the turn out-of-band.

**Concurrency — a second message while the agent is working.** The chat is marked busy for the whole job. A message arriving meanwhile is relayed into the RUNNING turn (pi delivers it at its next step), acknowledged with `⌛ Got it — after I finish the last task.` replied under the offending message, and then the handler **returns**. It must not fall through to the finish-up steps: those belong to the turn still in flight, and running them early committed half-edited files and abandoned the first reply mid-sentence. `agent-core` checks for a steer BEFORE validating provider/model, so the relay can pass none.

**Two halves of a turn run at once.** Resolving the message (downloading a voice note and transcribing it, or fetching attachments) needs no workspace; getting the workspace ready needs no message. Run in sequence they add up — transcription is seconds of network and so is a clone — so `runTurn` starts `prepareRun` (workspace, PAT, checkout, and for an EXISTING chat the pi session boot) alongside `resolveInput` and joins them before prompting. Three rules make it legal:

- **A `/command` never fans out.** It's answered from the database and runs no turn, so it must not drag a checkout behind it. Decided from the raw message (`typedTextOf`) *before* `resolveInput` runs — which is the point. A voice note or file is never a command.
- **A busy chat is never prepared.** Its session is live and owns its event sink; preparing would re-point `emit` mid-reply, the bug that once froze a reply half-written. Checked before the fan-out **and again after the join**, because with both sides running the turn can start during the window.
- **Failures are held, not thrown** (`settle`). An unhandled rejection while the other side is still working takes the process down.

The pi session is pre-booted **only for a chat that already exists**. Booting also creates the chat row, and a row whose transcript never arrived — because the transcription came back empty and no turn ran — is a chat that refuses to resume once its scratch dir ages out. An existing chat has both already, and is where the pre-boot is worth most anyway (resuming downloads and parses the transcript). `agentPrepare` lives in `agent-core`.

**The typing indicator starts at the ack**, owned by `runTurn` for the whole turn. It used to come from `makeTelegramSink`, built *after* the checkout — so a plain text message left the user watching an empty chat through the slowest part of the turn. `stream.ts` no longer starts one.

### The placeholder bubble is a SLOT, claimed by whichever output comes first

`makeTelegramSink` posts a `…` message before the agent has produced anything, so the wait for the first token happens inside a visible bubble instead of an empty chat. It is the same bubble the reply is then edited into — the first flush becomes an edit instead of a post, so the whole feature costs exactly one extra API call per turn. It applies to every turn, text or voice.

**It is not "the text bubble, posted early."** On most turns the agent reads or greps before it says anything, and `toolLine` posts its own message and resets `messageId` — so a bubble reserved for text alone would leave a bare `…` stranded above the tool line, never updated again. Instead `placeholder` marks it as unclaimed, and **text and tool lines both take it over**: text by editing it, `toolLine` by editing the tool line into it rather than posting below. One rule, correct in either order.

Three details that are load-bearing:

- **`placeholder` clears only after a write LANDS** (inside `flushInner`'s `try`). A rate-limited edit leaves the bubble claimable, and text that cleans down to `…` again — a segment that was only a file tag — throws *"message is not modified"*, which is exactly the case where it still holds nothing.
- **`toolLine` resets `messageId`/`text` BEFORE its await**, as it always did. `emit` appends to `text` outside the chain, so a delta arriving mid-send would be wiped by a reset that ran afterwards.
- **`dispose()` exists for the turn that throws.** `sink.done()` sits after the try/finally in `runTurnInner` and is never reached on that path, which stranded the placeholder above `runTurn`'s error reply — and, already true before any of this, leaked the 1.3s edit timer for the life of the process, one per failed turn. The `catch` calls `dispose()` and rethrows.

A turn that ends with nothing to say drops the bubble (`dropPlaceholder`) rather than leaving a bare `…` as the whole reply.

**Turn (`runTurn` → `runTurnInner`):** `runTurn` wraps the inner run in try/catch so **any failure replies in-chat** (`⚠️ Something went wrong running the agent:\n<message>`) and then rethrows for server logging — a silent failure reads as the bot ignoring you. `runTurnInner` handles `/new`,`/status`,`/help`; picks the workspace via `activeWorkspace` (in-chat error only when no workspaces exist); requires `sync.pat` (in-chat error if absent); `prepareCheckout` clones/refreshes via `git.ts`; runs `runtime.agentSend` under a `codingAgent.maxRunMinutes` watchdog (unset ⇒ 30); dual-publishes each event to the `feed` (desktop watches live) and the Telegram sink; then lands the work via `checkInWithFixer` — the same path cron uses, git-fixer included — and reports a `'conflict'`/`'error'` result in-chat. `source: 'telegram'`, `sourceId` = DM chat id.

## Cron

`scheduler.ts` (gated by `CRON_ENABLED`): one croner per enabled `cron.json` entry (`protect:true`, workspace timezone), plus a refresh croner that `reconcileAll`s — fetches each workspace's `cron.json` via `fetchCronJson` (ETag/304) and updates registrations **non-destructively** (unchanged jobs keep running; changed schedules are replaced; vanished jobs dropped). `fireJob` mints a chatId, runs `runCronJob`, records history to `cron_state`. `cronRun.ts` is shared by the scheduler and the manual `POST …/cron/:job/run`: checkout → read the job prompt from the checkout's `cron.json` → agent turn streamed to the feed (watchdog) → `checkInWithFixer` (shared with Telegram). Checkout dirs are keyed by chatId (re-runs reuse) and reclaimed by `sweeper.ts`.

### One-time jobs (`"once": true`)

A `cron.json` entry with `"once": true` and an **ISO datetime** `schedule` (`"2026-03-14T18:50:00"`, interpreted in the workspace timezone — croner takes a date as a pattern natively) runs once and **deletes its own entry**. There is no separate one-shot store, no new endpoint, and no bookkeeping: `cronRun.ts` calls `dropJob()` to remove the entry from the checkout's `cron.json`, the run's existing `checkIn` commits + pushes that, and the next reconcile sees the job gone and drops the registration. The prompt's agent-facing docs are in `agent-core/defaults/helper.ts` (`SCHEDULED_RUNS`).

`scheduler.ts` needs **no** one-shot handling: croner accepts a date as a pattern, fires it once, and reports `nextRun() === null` afterwards. Disposal also happens when the turn **fails** — the turn is wrapped in `try/catch` into `turnError` so `dropJob` + `checkIn` still run, then it rethrows. Once means once, and a failed job that kept its entry would leave a permanently dead line in the file.

**A missed moment is missed**, exactly like any cron: if the companion is down at the fire time, nothing runs, and the (now unfireable) entry sits in `cron.json` until someone removes it. Deliberately not caught up — a reminder arriving hours late is worse than none, and the catch-up machinery cost more than the case is worth.

**Registration latency is ~70s** — a desktop-authored edit needs a sync tick (10s) to reach GitHub plus a reconcile cycle (≤60s). One-time jobs less than ~2 minutes out don't reliably register; the helper prompt tells the agent to act immediately instead.

## Reviews (`reviewSweeper.ts`, `reviewRun.ts`)

The agent gets better at a workspace by writing down what it learned. It could already write skills, but only when a user thought to ask — so most of what was worth keeping was never captured. This removes the human trigger.

**It is cron with a different trigger.** A croner tick (`REVIEW_SCHEDULE`, default `*/5 * * * *`) finds a chat that has accumulated enough tool calls since it was last looked at, opens a **new** chat, hands the agent that conversation, and lets it update its skills. Fresh chat, `unattended: true`, its own checkout, landed with `checkInWithFixer` — the third agent path, exactly as the boxed rule above requires.

**Why the companion and not the end of a turn.** Turns happen three ways — desktop, Telegram, cron — across two processes, and only this server sees all of them, because every turn's messages land in its `message` table whoever ran it. Hooking the turn would mean writing it twice and having it never fire while the desktop is closed. It also means there is no counter to keep: "how much has happened" is a count of `role='tool'` rows past `chat.last_reviewed_seq`, which cannot drift and survives restarts. hermes and knack both carry an incremented counter precisely because neither can count what actually happened.

Four things the loop depends on, each of which breaks it if removed:

- **`source='review'` chats are excluded from the sweep.** A review run makes tool calls like any chat, so without this it crosses the threshold and reviews itself, forever.
- **The mark moves forward BEFORE the run**, not after. A run that throws must not leave the chat eligible on the next tick — that is a failing review retried every five minutes indefinitely. Nothing is lost: later work makes it due again normally.
- **The mark is the chat's own high-water mark**, not `max(seq)` over the joined tool rows — the join is filtered to tool rows, so that stops short of the assistant's closing message while the run read the whole conversation.
- **`protect: true` plus awaiting the run inside the tick** bounds this to one review in flight. That is also why a review's claim on the warm-checkout queue is *lighter* than cron's: cron can fire several jobs at once, this cannot.

Separate croner from cron deliberately — a job scheduled for 2am should fire at 2am rather than queue behind background maintenance.

**Settings.** `codingAgent.reviewInterval` (synced; unset ⇒ 10, **0 disables**) is the threshold — the number a user would actually change, which is why it is synced rather than env. The cadence (`REVIEW_SCHEDULE`) and master switch (`REVIEW_ENABLED`) are env, like `CRON_REFRESH_SCHEDULE` and `CRON_ENABLED`: server tuning, not user behaviour.

**Migration note.** `last_reviewed_seq` is seeded to each existing chat's current high-water mark rather than 0, or every chat in the database would be due the first time the sweep ran.

## Agent execution (`agentHost.ts`)

`makeCompanionRuntime(pool, key)` builds an `AgentHost` and calls `agent-core`'s `createAgentRuntime` — the same runtime the desktop implements, but wired to direct I/O instead of IPC: persistence → the drizzle store, events → `feed`, a per-run scratch `dataDir` keyed by chatId (isolates concurrent runs' pi `settings.json`), `extraTools = [send_message]` (built from `agent-core/sendMessage.ts` with `sendTelegramMessage` injected — the desktop offers the same tool, backed by `POST /telegram/send`), `getAgentSecrets` from `readSettings`, `getToken` → `mintToken`. Both cron and Telegram drive it via `runtime.agentSend(payload, emit)` / `runtime.agentAbort(chatId)`. The git-fixer (`gitFixer.ts`) runs a **separate** pi session from the turn.

## When you touch this

- **Adding a settings field:** it's just a `setting` row (or a `secret_value` row if it's a credential — declare it in `agent-core/credentials.ts`, which `keys.ts` derives from; editing `keys.ts` itself is the wrong layer and desyncs the desktop's strip + send guard). No default to register anywhere — required fields error at their consumer, optional fields fall back at point of use.
- **Adding a `secret_value` owner category:** every reconciliation that deletes from `secret_value` must be scoped to its own owners (see the boxed rule above).
- **Schema change:** edit `schema.ts` *and* `init.sql` (both are re-applied idempotently). Keep them in sync.
