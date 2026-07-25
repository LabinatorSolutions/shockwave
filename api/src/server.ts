// Shockwave API — Express 5 + Postgres. The single gateway: verify the bearer
// API_KEY, run the async store against Postgres, return JSON. Holds the master
// key; Postgres is private (never exposed to clients).

import crypto from 'node:crypto';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import pino from 'pino';
import { makePool, ensureSchema } from './db.js';
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
app.get('/settings', handle(() => store.readSettings(pool, masterKey)));
app.patch('/settings', handle((req) => store.writeSettings(pool, masterKey, req.body)));

// ── Secrets / agent tools ────────────────────────────────────────────────────
app.get('/agent-secrets', handle(() => store.listAgentSecretMeta(pool)));
// A static agent-secret's usable token. (OAuth fresh-token endpoint lands with
// the oauth phase.)
app.get('/agent-secret/:name/token', handle((req) => store.getSecret(pool, masterKey, req.params.name, 'token')));
// Targeted OAuth write (desktop persists exchange/refresh results here).
app.post('/oauth/:name', handle((req) => store.patchOAuth(pool, masterKey, req.params.name, req.body)));

// ── Workspace identity ───────────────────────────────────────────────────────
app.get('/workspaces', handle(() => store.listWorkspaces(pool)));
app.post('/workspaces', handle((req) => store.upsertWorkspace(pool, req.body)));
app.patch('/workspaces', handle((req) => store.updateWorkspaceOrder(pool, req.body)));
app.delete('/workspaces/:id', handle((req) => store.deleteWorkspace(pool, req.params.id)));

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
