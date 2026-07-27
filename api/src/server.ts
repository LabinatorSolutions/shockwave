// Shockwave API — Express 5 + Postgres. The single gateway: verify the bearer
// API_KEY, run the async store against Postgres, return JSON. Holds the master
// key; Postgres is private (never exposed to clients).

import crypto from 'node:crypto';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import pino from 'pino';
import { makePool, getDb, ensureSchema } from './db.js';
import * as store from './store.js';

const log = pino({ base: undefined });

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

const pool = makePool(DATABASE_URL);
const db = getDb(pool);

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet());

app.get('/health', async (_req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true }); }
  catch { res.status(503).json({ ok: false }); }
});

function authed(req: express.Request, res: express.Response, next: express.NextFunction) {
  const h = req.get('authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  const got = crypto.createHash('sha256').update(token).digest();
  if (token && crypto.timingSafeEqual(got, apiKeyHash)) return next();
  res.status(401).json({ error: 'unauthorized' });
}
const limiter = rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: true, legacyHeaders: false });
app.use(authed, limiter, express.json({ limit: '1mb' }));

// helper: run a store call, 500 with no leak on failure
const handle = (fn: (req: express.Request) => Promise<any>) =>
  async (req: express.Request, res: express.Response) => {
    try { res.json({ result: (await fn(req)) ?? null }); }
    catch (err: any) { log.error({ err: err?.message }, 'request failed'); res.status(500).json({ error: 'request failed' }); }
  };

// ── Settings ─────────────────────────────────────────────────────────────────
app.get('/settings', handle(() => store.readSettings(db, masterKey)));
app.patch('/settings', handle((req) => store.writeSettings(db, masterKey, req.body)));

// ── Secrets / agent tools ────────────────────────────────────────────────────
app.get('/agent-secrets', handle(() => store.listAgentSecretMeta(db)));
// A static agent-secret's usable token. (OAuth fresh-token endpoint lands with
// the oauth phase.)
app.get('/agent-secret/:name/token', handle((req) => store.getSecret(db, masterKey, req.params.name, 'token')));
// Targeted OAuth write (desktop persists exchange/refresh results here).
app.post('/oauth/:name', handle((req) => store.patchOAuth(db, masterKey, req.params.name, req.body)));

// ── Chats ────────────────────────────────────────────────────────────────────
app.get('/chats', handle((req) => store.listSessions(db, String(req.query.workspaceId), {
  limit: req.query.limit ? Number(req.query.limit) : undefined,
  before: req.query.before ? Number(req.query.before) : undefined,
})));
app.get('/chats/starred', handle((req) => store.listStarred(db, String(req.query.workspaceId))));
app.get('/chats/search', handle((req) => store.searchSessions(db, String(req.query.workspaceId), String(req.query.q ?? ''), { limit: req.query.limit ? Number(req.query.limit) : undefined })));
app.get('/chat/:id', handle(async (req) => ({ session: await store.getSession(db, req.params.id), messages: await store.getMessages(db, req.params.id) })));
app.get('/chat/:id/messages', handle((req) => store.getMessages(db, req.params.id)));
app.post('/chat', handle((req) => store.upsertSession(db, { ...req.body, now: Date.now() })));
app.post('/chat/:id/messages', handle((req) => store.persistMessages(db, req.params.id, req.body)));
app.patch('/chat/:id/title', handle((req) => store.setSessionTitle(db, req.params.id, req.body?.title ?? '')));
app.patch('/chat/:id/starred', handle((req) => store.setSessionStarred(db, req.params.id, !!req.body?.starred)));
app.delete('/chat/:id', handle((req) => store.deleteSession(db, req.params.id)));
// Transcript JSONL (whole). Sent as { content }.
app.get('/chat/:id/transcript', handle((req) => store.getTranscript(db, req.params.id)));
app.patch('/chat/:id/transcript', handle((req) => store.putTranscript(db, req.params.id, String(req.body?.content ?? ''))));

// Cross-client running flag. Body { machine: string } sets running; { machine:
// null } clears it. The executing client clears only after uploading the turn.
app.patch('/chat/:id/running', handle((req) => store.setRunning(db, req.params.id, req.body?.machine ?? null)));

// ── Live feed (ephemeral pub/sub) ────────────────────────────────────────────
// The executing client POSTs each pi event to /events; spectators hold an SSE
// connection on /stream. In-memory fan-out only — nothing is persisted here (the
// durable record is the rows + transcript written at turn end).
const feedSubs = new Map<string, Set<express.Response>>();

// Spectator subscribes to a session's live event stream.
app.get('/chat/:id/stream', (req, res) => {
  const id = req.params.id;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n'); // open the stream immediately
  let set = feedSubs.get(id);
  if (!set) { set = new Set(); feedSubs.set(id, set); }
  set.add(res);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closed */ } }, 25_000);
  req.on('close', () => {
    clearInterval(ping);
    const s = feedSubs.get(id);
    if (s) { s.delete(res); if (!s.size) feedSubs.delete(id); }
  });
});

// Executing client pushes one pi event; fan it out to that session's spectators.
app.post('/chat/:id/events', (req, res) => {
  const set = feedSubs.get(req.params.id);
  if (set && set.size) {
    const payload = `data: ${JSON.stringify(req.body ?? {})}\n\n`;
    for (const r of set) { try { r.write(payload); } catch { /* drop on next close */ } }
  }
  res.json({ result: { ok: true, subscribers: set?.size ?? 0 } });
});

// ── Workspace identity ───────────────────────────────────────────────────────
app.get('/workspaces', handle(() => store.listWorkspaces(db)));
app.post('/workspaces', handle((req) => store.upsertWorkspace(db, req.body)));
app.patch('/workspaces', handle((req) => store.updateWorkspaceOrder(db, req.body)));
app.delete('/workspaces/:id', handle((req) => store.deleteWorkspace(db, req.params.id)));

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  log.error({ err: err?.message }, 'error');
  res.status(err?.status || 500).json({ error: 'request error' });
});

(async () => {
  await ensureSchema(pool);
  const server = app.listen(PORT, () => log.info({ port: PORT }, 'shockwave-api listening'));
  const shutdown = () => { server.close(() => pool.end().finally(() => process.exit(0))); setTimeout(() => process.exit(0), 5000).unref(); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
})().catch((err) => { log.error({ err: err?.message }, 'boot failed'); process.exit(1); });
