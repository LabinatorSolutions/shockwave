// Shockwave API — Express 5 + Postgres. The single gateway: verify the bearer
// API_KEY, run the async store against Postgres, return JSON. Holds the master
// key; Postgres is private (never exposed to clients).

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { logger } from './log.js';
import { makePool, getDb, ensureSchema } from './db.js';
import * as store from './store.js';
import * as feed from './feed.js';
import { makeCompanionRuntime } from './agentHost.js';
import { runCronJob } from './cronRun.js';
import { initScheduler, nextRuns } from './scheduler.js';
import { mintToken } from './oauth.js';
// The one declaration of which settings paths are credentials — see
// agent-core/credentials.ts. Also gates the desktop's delete IPC.
import { isDeletableCredential } from '../../agent-core/credentials.js';
import { initSweeper } from './sweeper.js';
import { initCheckoutPool } from './checkoutPool.js';
import { initBackgroundSweeper } from './backgroundSweeper.js';
import { handleWebhook, connect as tgConnect, disconnect as tgDisconnect, status as tgStatus, syncCommands as tgSyncCommands, syncWebhookConfig as tgSyncWebhookConfig } from './telegram/webhook.js';
import { configuredHost, ensureSelfSignedCert, readCertPem, removeSelfSignedCert } from './telegram/selfSigned.js';
import { sendTelegramMessage } from './telegram/sendTool.js';

const log = logger('http');

const { DATABASE_URL, MASTER_KEY, API_KEY } = process.env;
const PORT = Number(process.env.PORT || 8080);

if (!DATABASE_URL || !MASTER_KEY || !API_KEY) {
  log.error('refusing to start: DATABASE_URL, MASTER_KEY and API_KEY are all required');
  process.exit(1);
}
const masterKey = Buffer.from(MASTER_KEY, 'base64');
if (masterKey.length !== 32) {
  log.error(`MASTER_KEY must be 32 bytes base64 (got ${masterKey.length})`);
  process.exit(1);
}
const apiKeyHash = crypto.createHash('sha256').update(API_KEY).digest();

// Drop the three secrets from the environment now that they're held as locals.
//
// pi spawns the agent's `bash` with `{ ...process.env }` (its getShellEnv), and
// gitFixer/git.ts spawn shells with the default inherited env — so anything the
// agent is told to run could `env` and read the master key that decrypts every
// row in secret_value, the bearer key, and the Postgres password. Telegram and
// cron turns run unattended, so the instruction can arrive as a file in a repo,
// a cron.json prompt, or a DM. Deleting here covers every spawn site at once
// rather than filtering env at each one (and remembering to for the next one).
//
// NOT complete on Linux: /proc/<pid>/environ is served from the block handed
// over at exec, which unsetenv doesn't touch, so the originals survive there.
// This closes `env`/`printenv`; the full fix is to stop passing them as env.
delete process.env.MASTER_KEY;
delete process.env.API_KEY;
delete process.env.DATABASE_URL;

const pool = makePool(DATABASE_URL);
const db = getDb(pool);
// The companion's own agent runtime (shared agent-core, companion host).
const agentRuntime = makeCompanionRuntime(pool, masterKey);

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet());

// APP_VERSION is baked into the image at build time (Dockerfile ARG); 'dev'
// when running outside the published image. Clients compare it against their
// own version to detect a stale companion.
const APP_VERSION = process.env.APP_VERSION || 'dev';

app.get('/health', async (_req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true, version: APP_VERSION }); }
  catch { res.status(503).json({ ok: false, version: APP_VERSION }); }
});

// Telegram webhook — PUBLIC (Telegram sends no bearer token; gated by a per-
// account secret header, checked inside handleWebhook). Registered BEFORE the
// bearer middleware, with its own body parser.
app.post('/telegram/webhook', express.json({ limit: '1mb' }), (req, res) => {
  handleWebhook(pool, masterKey, agentRuntime, req, res, log)
    .catch((e: any) => { log.error({ err: e?.message }, 'telegram webhook error'); if (!res.headersSent) res.sendStatus(200); });
});

function authed(req: express.Request, res: express.Response, next: express.NextFunction) {
  const h = req.get('authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  const got = crypto.createHash('sha256').update(token).digest();
  if (token && crypto.timingSafeEqual(got, apiKeyHash)) return next();
  res.status(401).json({ error: 'unauthorized' });
}
const limiter = rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: true, legacyHeaders: false });
// 1mb was too small for two payloads that legitimately carry media, and both
// failed as a 413 the user never saw:
//   - PATCH /chat/:id/transcript — pi's whole session JSONL, re-sent every turn.
//     Any chat with an image, or simply enough tool output, exceeds a megabyte.
//   - POST /chat/:id/messages — a message's images ride the row, base64 (+33%).
// Telegram already refuses anything over 20MB (`MAX_INBOUND_BYTES`), so that is
// the largest single file that can arrive; the ceiling is set well above it for
// the transcript, which accumulates. The surface this widens is one bearer-authed,
// rate-limited server with a single user.
app.use(authed, limiter, express.json({ limit: '64mb' }));

// helper: run a store call, 500 with no leak on failure
const handle = (fn: (req: express.Request) => Promise<any>) =>
  async (req: express.Request, res: express.Response) => {
    try { res.json({ result: (await fn(req)) ?? null }); }
    catch (err: any) { log.error({ err: err?.message }, 'request failed'); res.status(500).json({ error: 'request failed' }); }
  };

// ── Settings ─────────────────────────────────────────────────────────────────
app.get('/settings', handle(() => store.readSettings(db, masterKey)));
app.patch('/settings', handle((req) => store.writeSettings(db, masterKey, req.body)));

// Destroying a credential is a REQUEST, never an inference. A save carrying an
// empty value no longer deletes (see `putSecret`), so this is the only way — and
// the path is re-checked against the one credential declaration here as well as
// in the desktop, since this route is reachable with the bearer key alone.
app.delete('/settings/credential/:path', handle((req) => {
  const path = req.params.path;
  if (!isDeletableCredential(path)) throw new Error(`not a deletable credential: ${path}`);
  return store.deleteSettingsCredential(db, path);
}));

// ── Secrets / agent tools ────────────────────────────────────────────────────
app.get('/agent-secrets', handle(() => store.listAgentSecretMeta(db)));
// Removing an agent secret, and the only thing that does. A name merely missing
// from a settings save is left alone — the caller's list is not authoritative.
app.delete('/agent-secret/:name', handle((req) => store.deleteAgentSecret(db, req.params.name)));
// A usable credential for one secret: static → the stored token; oauth → a fresh
// access token (refreshed server-side). Both the desktop agent and cron use this.
app.get('/agent-secret/:name/token', handle((req) => mintToken(db, masterKey, req.params.name)));
// Targeted OAuth write (desktop persists exchange/refresh results here).
app.post('/oauth/:name', handle((req) => store.patchOAuth(db, masterKey, req.params.name, req.body)));

// ── Chats ────────────────────────────────────────────────────────────────────
app.get('/chats', handle((req) => store.listChats(db, String(req.query.workspaceId), {
  limit: req.query.limit ? Number(req.query.limit) : undefined,
  before: req.query.before ? Number(req.query.before) : undefined,
})));
app.get('/chats/pinned', handle((req) => store.listPinned(db, String(req.query.workspaceId))));
// Ids only, all workspaces — the desktop's scratch sweep asking what it may not
// delete. A sibling of `/chats/pinned` rather than a flag on it: that one is the
// sidebar's, workspace-scoped and full rows, and a sweep has neither.
app.get('/chats/pinned-ids', handle(() => store.pinnedChatIds(db)));
app.get('/chats/search', handle((req) => store.searchChats(db, String(req.query.workspaceId), String(req.query.q ?? ''), { limit: req.query.limit ? Number(req.query.limit) : undefined })));
app.get('/chat/:id', handle(async (req) => ({ chat: await store.getChat(db, req.params.id), messages: await store.getMessages(db, req.params.id) })));
// `?after=<seq>` returns only what's newer — the one read that serves a cold
// open, a catch-up, and a reconnect gap.
app.get('/chat/:id/messages', handle((req) => store.getMessages(db, req.params.id, req.query.after != null ? Number(req.query.after) : undefined)));
app.post('/chat', handle((req) => store.upsertChat(db, { ...req.body, now: Date.now() })));
app.post('/chat/:id/messages', handle((req) => store.appendMessages(db, req.params.id, req.body)));
app.patch('/chat/:id/title', handle((req) => store.setChatTitle(db, req.params.id, req.body?.title ?? '')));
app.patch('/chat/:id/pinned', handle((req) => store.setChatPinned(db, req.params.id, !!req.body?.pinned)));
app.delete('/chat/:id', handle((req) => store.deleteChat(db, req.params.id)));
// Transcript JSONL (whole). Sent as { content }.
app.get('/chat/:id/transcript', handle((req) => store.getTranscript(db, req.params.id)));
app.patch('/chat/:id/transcript', handle((req) => store.putTranscript(db, req.params.id, String(req.body?.content ?? ''))));

// One image the user sent, by id. NOT wrapped in `handle` — that answers
// `{result}` JSON, and this streams raw bytes. Immutable once written (the id is
// a fresh uuid per image), so it caches forever; without that the desktop
// re-fetches every picture on every chat open.
app.get('/attachment/:id', async (req, res) => {
  try {
    const row = await store.getAttachment(db, req.params.id);
    if (!row) { res.sendStatus(404); return; }
    res.setHeader('Content-Type', row.mimeType);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(row.bytes);
  } catch (err: any) {
    log.error({ err: err?.message }, 'attachment read failed');
    res.status(500).json({ error: 'request failed' });
  }
});

// Cross-client running flag. Body { machine: string } sets running; { machine:
// null } clears it. The executing client clears only after uploading the turn.
app.patch('/chat/:id/running', handle((req) => store.setRunning(db, req.params.id, req.body?.machine ?? null)));

// ── Live feed (ephemeral pub/sub — see feed.ts) ──────────────────────────────
// A spectator holds an SSE connection on /stream; the desktop producer POSTs to
// /events. Server-side cron runs publish to the same feed in-process.

// ONE stream for everything. A client opens this once at startup and holds it,
// so it hears about chats it doesn't know exist yet (Telegram, cron, another
// machine) — which a per-chat subscription structurally cannot do.
app.get('/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n'); // open the stream immediately
  const unsubscribe = feed.subscribe(res);
  // Keeps routers/proxies from cutting an idle line — nothing more. The client
  // never counts these or reacts to them; it only reconnects when the connection
  // actually breaks. Fixed, not configurable: the number means nothing on its own
  // and a knob only creates two places for it to disagree.
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closed */ } }, 10_000);
  req.on('close', () => { clearInterval(ping); unsubscribe(); });
});

// A client executing a turn locally pushes its pi events here so every OTHER
// client sees them live (the server can't emit for a run it isn't hosting).
app.post('/chat/:id/events', (req, res) => {
  const n = feed.publish({ ...(req.body ?? {}), chatId: req.params.id });
  res.json({ result: { ok: true, subscribers: n } });
});

// Reads behind the agent's `search_chats` tool. The tool itself is ONE
// definition in agent-core; the companion's agent calls the store directly and
// the desktop's agent reaches these — same split as every other chat read.
app.get('/chats/fulltext', handle((req) => store.searchChatMessages(
  db, String(req.query.workspaceId), String(req.query.q ?? ''),
  Number(req.query.limit ?? 3),
  req.query.sort === 'newest' || req.query.sort === 'oldest' ? req.query.sort : undefined,
  req.query.exclude ? String(req.query.exclude) : undefined,
)));
app.get('/chat/:id/window', handle((req) => store.readChatWindow(
  db, req.params.id,
  req.query.around != null ? Number(req.query.around) : undefined,
  Number(req.query.window ?? 5),
)));
app.get('/chats/recent', handle((req) => store.recentChats(
  db, String(req.query.workspaceId), Number(req.query.limit ?? 10),
  req.query.exclude ? String(req.query.exclude) : undefined,
)));

// ── Cron (server-side execution) ─────────────────────────────────────────────
// Manual "run now": mint a chatId, return it immediately, run the job in the
// background (the caller watches via /chat/:id/stream). The scheduler (Phase C)
// will call runCronJob the same way.
app.post('/workspace/:id/cron/:job/run', handle(async (req) => {
  const chatId = crypto.randomUUID();
  runCronJob(pool, masterKey, agentRuntime, req.params.id, req.params.job, chatId)
    .catch((err) => log.error({ err: err?.message, workspace: req.params.id, job: req.params.job }, 'cron run failed'));
  return { ok: true, chatId };
}));

// Cron run history (per job) + next-run (from croner, in memory) — for the UI.
app.get('/workspace/:id/cron/state', handle(async (req) => ({
  history: await store.getCronState(db, req.params.id),
  next: nextRuns(req.params.id),
})));

// ── Workspace identity ───────────────────────────────────────────────────────
app.get('/workspaces', handle(() => store.listWorkspaces(db)));
app.post('/workspaces', handle((req) => store.upsertWorkspace(db, req.body)));
app.patch('/workspaces', handle((req) => store.updateWorkspaceOrder(db, req.body)));
app.delete('/workspaces/:id', handle((req) => store.deleteWorkspace(db, req.params.id)));
// How this workspace's Telegram replies come back. The same value `/voice` sets,
// so the desktop toggle and the bot command are one setting with two front doors.
app.post('/workspaces/:id/voice', handle(async (req) => {
  await store.setVoiceReply(db, req.params.id, req.body?.mode);
  return { ok: true };
}));

// ── Telegram (desktop Settings triggers these companion actions) ─────────────
// COMPANION_DOMAIN set -> a real domain (Let's Encrypt) or an ngrok host: the
// cert is already trusted, so just register the URL. Unset -> hand Telegram a
// copy of the certificate made at boot.
//
// This must NEVER create a certificate. It used to, which meant the server's
// identity changed the first time Telegram was connected — after every desktop
// had already approved the previous one. Creation happens once, at boot.
//
// Shared by /telegram/connect and the boot-time webhook reconcile
// (tgSyncWebhookConfig), so both register against the same address.
async function resolveTelegramPublic(): Promise<{ publicUrl: string; certificatePem?: string }> {
  const domain = process.env.COMPANION_DOMAIN;
  if (domain) return { publicUrl: `https://${domain}` };
  const host = configuredHost();
  const pem = await readCertPem();
  if (!pem) throw new Error('No certificate on disk — restart the companion so it can create one.');
  return { publicUrl: `https://${host}`, certificatePem: pem };
}

app.post('/telegram/connect', handle(async (req) => {
  const { publicUrl, certificatePem } = await resolveTelegramPublic();
  return tgConnect(pool, masterKey, {
    botToken: String(req.body?.botToken ?? ''),
    authorizedTgUserId: Number(req.body?.authorizedTgUserId),
    publicUrl,
    certificatePem,
  });
}));
app.post('/telegram/disconnect', handle(async () => { await tgDisconnect(pool, masterKey); return { ok: true }; }));
// Send a DM to the user. Backs the desktop's copy of the `send_message` agent
// tool — the bot token is here, so the desktop asks rather than holds it.
// `output` overrides the workspace's preference for this ONE message; absent, the
// server reads that preference off the workspace row. There is deliberately no
// way to CHANGE it here — that is `/voice`, so no message-sending path is also a
// settings write.
// `output` is deliberately NOT read off the body. The desktop's copy of
// send_message no longer offers it, and an older desktop still would — honouring
// that would leave the agent able to overrule the workspace's voice setting from
// one machine and not another, which is worse than either answer on its own.
app.post('/telegram/send', handle((req) => sendTelegramMessage(pool, masterKey, String(req.body?.text ?? ''), {
  workspaceId: typeof req.body?.workspaceId === 'string' ? req.body.workspaceId : null,
  // Which chat is speaking, so a reply to the message resumes it. Absent from an
  // older desktop — a reply to one of those simply doesn't switch.
  chatId: typeof req.body?.chatId === 'string' ? req.body.chatId : null,
})));
app.get('/telegram/status', handle(() => tgStatus(pool)));
// Set the workspace Telegram runs against (same semantics as /workspace in the
// bot: switching always starts a fresh chat). The desktop's Telegram settings
// page drives this.
app.post('/telegram/workspace', handle(async (req) => {
  const workspaceId = String(req.body?.workspaceId ?? '');
  const all = await store.listWorkspaces(db);
  if (!all.some((w) => w.id === workspaceId)) throw new Error('unknown workspace');
  await store.setTelegramActiveWorkspace(db, workspaceId);
  return { ok: true };
}));

// ── Remote upgrade ───────────────────────────────────────────────────────────
// Drops the requested release tag where the updater sidecar polls for it
// (UPDATE_TRIGGER_DIR, a volume shared with the `updater` compose service);
// the sidecar fetches that tag's runtime files, pulls its image, and restarts
// the stack — see api/updater/. Distinct `updater-unavailable` (503) tells a
// pre-sidecar deployment to re-run the install script once.
app.post('/update', async (req, res) => {
  const tag = String(req.body?.tag ?? '');
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) { res.status(400).json({ error: 'invalid tag' }); return; }
  const dir = process.env.UPDATE_TRIGGER_DIR || '';
  try {
    if (!dir) throw new Error('UPDATE_TRIGGER_DIR not set');
    await fsp.writeFile(path.join(dir, 'request'), `${tag}\n`);
  } catch (err: any) {
    log.error({ err: err?.message, tag }, 'update trigger failed');
    res.status(503).json({ error: 'updater-unavailable' });
    return;
  }
  log.info({ tag }, 'update requested');
  res.json({ result: { ok: true, tag } });
});

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  log.error({ err: err?.message }, 'error');
  res.status(err?.status || 500).json({ error: 'request error' });
});

// The server's TLS identity, settled before it starts answering.
//
// No domain: create-or-reuse the self-signed certificate for COMPANION_HOST. A
// failure here is FATAL — coming up anyway means Traefik serves its own
// throwaway certificate, desktops approve that, and the real one replaces it
// later. A server whose identity is about to change is worse than one that
// didn't start, so it exits the same way a missing MASTER_KEY does.
//
// Domain set: Let's Encrypt owns the certificate, so delete any self-signed
// leftovers rather than leaving a private key on disk claiming to be this server
// and still registered as Traefik's default.
/**
 * COMPANION_HOST and COMPANION_DOMAIN are one thing — this server's public
 * address — split across two variables whose real difference is which TLS mode
 * you get. Nothing validated that the value suited the variable, so an IP in
 * COMPANION_DOMAIN silently produced the worst outcome available:
 *
 *   settleTls deletes our self-signed certificate (a real one is supposedly
 *   coming) -> Let's Encrypt can never issue for a bare IP, so none arrives ->
 *   Traefik serves the throwaway certificate it generates at EVERY startup.
 *
 * The server answers fine, so nothing looks broken — except the fingerprint
 * changes on every restart and every desktop is asked to approve a different
 * identity each time, which is precisely how you teach someone to click through
 * the one prompt that catches a real attack.
 *
 * An IP can only ever mean self-signed, so the intent is unambiguous: move it to
 * COMPANION_HOST and carry on. Normalised HERE, before anything reads either
 * variable, so every consumer (TLS, the Telegram webhook URL) sees one answer.
 * Fixing it in place would be a config write from a process that must not own
 * config; this fixes behaviour and says what to change.
 *
 * `traefik/gen-router.sh` makes the same call for Traefik's router — it is a
 * different container and cannot see this. The two must agree.
 */
function normalizeTlsEnv(): void {
  const domain = (process.env.COMPANION_DOMAIN || '').trim();
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(domain)) return;
  process.env.COMPANION_HOST = domain;
  process.env.COMPANION_DOMAIN = '';
  log.warn({ address: domain },
    'COMPANION_DOMAIN is an IP address — Let\'s Encrypt cannot issue for one. Using it as COMPANION_HOST '
    + '(self-signed, approve the fingerprint once). Move it to COMPANION_HOST in .env to silence this.');
}

async function settleTls(): Promise<void> {
  if (process.env.COMPANION_DOMAIN) {
    await removeSelfSignedCert();
    log.info('COMPANION_DOMAIN set — using Let\'s Encrypt; removed any self-signed leftovers');
    return;
  }
  const host = configuredHost();
  await ensureSelfSignedCert(host);
  log.info({ host }, 'self-signed certificate ready');
}

(async () => {
  normalizeTlsEnv(); // must run before ANY reader of COMPANION_HOST/DOMAIN
  await settleTls();
  await ensureSchema(pool);
  // The half of the voice-key rename that SQL cannot do: a key left as a
  // plaintext `setting` row has to be encrypted on the way across, and only this
  // process holds the master key. See migrateLegacyVoiceKeys.
  await store.migrateLegacyVoiceKeys(getDb(pool), masterKey, log);
  initScheduler(pool, masterKey, agentRuntime); // registers cron jobs from each cron.json
  initSweeper(pool, masterKey);                 // reclaims idle per-run working dirs (TTL)
  initCheckoutPool(pool, masterKey);            // keeps a warm checkout ready for a new Telegram chat
  initBackgroundSweeper(pool, masterKey, agentRuntime); // reviews skills + saves memory from chats that have done enough
  tgSyncCommands(pool, masterKey, log);         // keep the /commands menu current
  tgSyncWebhookConfig(pool, masterKey, resolveTelegramPublic, log); // pick up new update kinds (reactions)
  const server = app.listen(PORT, () => log.info({ port: PORT }, 'shockwave-api listening'));
  const shutdown = () => { server.close(() => pool.end().finally(() => process.exit(0))); setTimeout(() => process.exit(0), 5000).unref(); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
})().catch((err) => { log.error({ err: err?.message }, 'boot failed'); process.exit(1); });
