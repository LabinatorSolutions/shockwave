// Telegram as a third `source`. The webhook receives a message, fast-acks 200
// (Telegram retries on slow ack), then runs a turn out-of-band — exactly like a
// cron run: clone the default workspace, run through the shared agent-core,
// stream to Telegram (and the feed, so the desktop can watch), and check the
// work back in. One authorized user, DM-only. connect()/disconnect() register
// the webhook with Telegram; the desktop Settings tab triggers those.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type express from 'express';
import type { DB } from '../db.js';
import { getDb } from '../db.js';
import * as store from '../store.js';
import * as feed from '../feed.js';
import { prepareCheckout, checkIn } from '../git.js';
import { TelegramClient } from './client.js';
import { makeTelegramSink } from './stream.js';

function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a); const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

const BOT_COMMANDS = [
  { command: 'new', description: 'Start a fresh conversation' },
  { command: 'status', description: 'Show the current workspace + session' },
  { command: 'help', description: 'What this bot can do' },
];

// ── Setup (called by the desktop Settings tab via companion endpoints) ────────

export async function connect(pool: DB, key: Buffer, opts: { botToken: string; authorizedTgUserId: number; publicUrl: string; certificatePem?: string }) {
  const client = new TelegramClient(opts.botToken);
  const me = await client.getMe(); // validates the token
  const secret = crypto.randomBytes(32).toString('hex');
  const webhookUrl = `${opts.publicUrl.replace(/\/$/, '')}/telegram/webhook`;
  await client.setWebhook(webhookUrl, secret, opts.certificatePem);
  await client.setMyCommands(BOT_COMMANDS).catch(() => {});
  const db = getDb(pool);
  await store.saveTelegramAccount(db, key,
    // In a private chat the DM chat id equals the user id.
    { authorizedTgUserId: opts.authorizedTgUserId, dmChatId: opts.authorizedTgUserId, botUsername: me?.username ?? null, enabled: true },
    { botToken: opts.botToken, webhookSecret: secret });
  return { botUsername: me?.username ?? null, webhookUrl };
}

export async function disconnect(pool: DB, key: Buffer) {
  const db = getDb(pool);
  const token = await store.getTelegramSecret(db, key, 'botToken').catch(() => '');
  if (token) { try { await new TelegramClient(token).deleteWebhook(); } catch { /* best-effort */ } }
  await store.clearTelegramAccount(db);
}

export async function status(pool: DB) {
  const acc = await store.getTelegramAccount(getDb(pool));
  return { connected: !!acc?.enabled, botUsername: acc?.botUsername ?? null, activeSessionId: acc?.activeSessionId ?? null };
}

// ── Webhook ───────────────────────────────────────────────────────────────────

export async function handleWebhook(pool: DB, key: Buffer, runtime: any, req: express.Request, res: express.Response, log: any) {
  const db = getDb(pool);
  const acc = await store.getTelegramAccount(db);
  if (!acc || !acc.enabled) { res.sendStatus(200); return; }

  const secret = await store.getTelegramSecret(db, key, 'webhookSecret');
  const got = req.get('X-Telegram-Bot-Api-Secret-Token') || '';
  if (!secret || !timingSafeEqualStr(got, secret)) { res.sendStatus(403); return; }

  const update = req.body || {};
  const msg = update.message;
  // Single authorized user, DM-only. Unknown senders are silently ignored.
  if (!msg || msg.from?.id !== acc.authorizedTgUserId) { res.sendStatus(200); return; }
  // Dedup webhook retries.
  if (!(await store.markTelegramUpdate(db, update.update_id))) { res.sendStatus(200); return; }

  res.sendStatus(200); // fast ack; do the work out-of-band
  runTurn(pool, key, runtime, acc, msg).catch((e: any) => log?.error({ err: e?.message }, 'telegram turn failed'));
}

async function runTurn(pool: DB, key: Buffer, runtime: any, acc: any, msg: any) {
  const db = getDb(pool);
  const token = await store.getTelegramSecret(db, key, 'botToken');
  const client = new TelegramClient(token);
  const dm = acc.dmChatId as number;
  const text = String(msg.text ?? '');

  if (text.startsWith('/')) { await handleCommand(db, client, dm, text); return; }
  if (!text.trim()) { await client.sendMessage(dm, 'Send me a text message and I\'ll get to work.'); return; }

  const wsId = process.env.TELEGRAM_DEFAULT_WORKSPACE;
  const ws = (await store.listWorkspaces(db)).find((w) => w.id === wsId);
  if (!ws) { await client.sendMessage(dm, '⚠️ No default workspace is configured (set TELEGRAM_DEFAULT_WORKSPACE on the server).'); return; }

  let sessionId = acc.activeSessionId as string | null;
  if (!sessionId) { sessionId = crypto.randomUUID(); await store.setTelegramActiveSession(db, sessionId); }

  const pat = await store.getSecret(db, key, 'settings', 'sync.pat');
  if (!pat) { await client.sendMessage(dm, '⚠️ No GitHub token is configured on the server.'); return; }
  const dir = await prepareCheckout(sessionId, ws.repoOwner, ws.repoName, ws.defaultBranch, pat);

  const settings = await store.readSettings(db, key);
  if (settings.timezone) process.env.TZ = settings.timezone;
  const ca = settings.codingAgent ?? {};
  let wsBuiltinSkills: Record<string, any> = {};
  try { wsBuiltinSkills = JSON.parse(await fs.readFile(path.join(dir, '.shockwave', 'workspace.json'), 'utf8'))?.builtinSkills ?? {}; } catch { /* defaults */ }

  const sink = makeTelegramSink(client, dm);
  let finalMessages: any[] | undefined;
  const emit = (e: any) => {
    if (e?.type === 'agent_end') finalMessages = e.messages;
    feed.publish(e.sessionId, e); // desktop can watch it live
    sink.emit(e);                 // render to Telegram
  };

  const maxRunMs = (Number(process.env.CRON_MAX_RUN_MINUTES) || 30) * 60_000;
  const wd = setTimeout(() => runtime.agentAbort(sessionId).catch(() => {}), maxRunMs);
  try {
    await runtime.agentSend({
      sessionId, text, workspaceId: ws.id, workspacePath: dir,
      provider: ca.provider, model: ca.model, apiKey: (ca.providerKeys ?? {})[ca.provider] ?? '',
      baseUrl: ca.baseUrl, contextWindow: ca.contextWindow, thinkingLevel: ca.thinkingLevel,
      wsBuiltinSkills, source: 'telegram', sourceId: String(dm),
    }, emit);
  } finally { clearTimeout(wd); }

  await sink.done(finalMessages);
  await checkIn(dir, ws.defaultBranch, `Shockwave telegram — ${new Date().toISOString()}`).catch(() => {});
}

async function handleCommand(db: DB, client: TelegramClient, dm: number, text: string) {
  const cmd = text.split(/\s+/)[0].replace(/@\w+$/, '').slice(1).toLowerCase();
  if (cmd === 'new') {
    await store.setTelegramActiveSession(db, null);
    await client.sendMessage(dm, 'Started a fresh conversation. Send your next message to begin.');
  } else if (cmd === 'status') {
    const acc = await store.getTelegramAccount(db);
    const ws = (await store.listWorkspaces(db)).find((w) => w.id === process.env.TELEGRAM_DEFAULT_WORKSPACE);
    await client.sendMessage(dm, `Workspace: ${ws ? ws.name : '(none configured)'}\nSession: ${acc?.activeSessionId ? 'active' : 'new on next message'}`);
  } else {
    await client.sendMessage(dm, 'Send a message to run the agent on your workspace.\n\n/new — fresh conversation\n/status — workspace + session\n/help — this');
  }
}
