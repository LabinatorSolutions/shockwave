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
import { BOT_COMMANDS, handleCommand, activeWorkspace } from './commands.js';
import { transcribeAudio } from './transcribe.js';

// Chats with a turn in flight ON THIS SERVER. A second message for a busy chat
// is handed to the running turn (pi picks it up at its next step) and must NOT
// re-run the finish-up steps — see runTurnInner.
const busy = new Set<string>();
const isBusy = (chatId: string) => busy.has(chatId);

function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a); const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

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

// Push the current command list to Telegram. Runs at every boot, not just at
// connect: the list lives in code, so a bot connected before a command existed
// would otherwise keep showing the old menu forever — which is exactly what
// happened when /chats, /workspaces and /btw were added.
export async function syncCommands(pool: DB, key: Buffer, log?: any) {
  const db = getDb(pool);
  const acc = await store.getTelegramAccount(db);
  if (!acc?.enabled) return;
  try {
    const token = await store.getTelegramSecret(db, key, 'botToken');
    if (!token) return;
    await new TelegramClient(token).setMyCommands(BOT_COMMANDS);
    log?.info({ count: BOT_COMMANDS.length }, 'telegram commands synced');
  } catch (e: any) {
    log?.warn({ err: e?.message }, 'telegram command sync failed');
  }
}

export async function status(pool: DB) {
  const db = getDb(pool);
  const acc = await store.getTelegramAccount(db);
  // Report the STORED selection — null when nothing is chosen — so the settings
  // picker shows blank. Message runs still fall back via activeWorkspace().
  const all = await store.listWorkspaces(db);
  const ws = all.find((w) => w.id === acc?.activeWorkspaceId) ?? null;
  return {
    connected: !!acc?.enabled, botUsername: acc?.botUsername ?? null, activeChatId: acc?.activeChatId ?? null,
    workspaceId: ws?.id ?? null, workspaceName: ws?.name ?? null,
  };
}

// ── Webhook ───────────────────────────────────────────────────────────────────

export async function handleWebhook(pool: DB, key: Buffer, runtime: any, req: express.Request, res: express.Response, log: any) {
  const db = getDb(pool);
  const acc = await store.getTelegramAccount(db);
  if (!acc || !acc.enabled) { res.sendStatus(200); return; }

  const secret = await store.getTelegramSecret(db, key, 'webhookSecret');
  const got = req.get('X-Telegram-Bot-Api-Secret-Token') || '';
  if (!secret || !timingSafeEqualStr(got, secret)) {
    // Telegram registered with a different secret than we hold (e.g. a stale
    // registration after a reconnect). Without this line the bot goes silently
    // deaf — every update bounces 403 and nothing anywhere says so.
    log?.warn({ hasStoredSecret: !!secret }, 'telegram webhook rejected: secret-token mismatch');
    res.sendStatus(403); return;
  }

  const update = req.body || {};
  const msg = update.message;
  // Single authorized user, DM-only. Unknown senders are silently ignored.
  if (!msg || msg.from?.id !== acc.authorizedTgUserId) { res.sendStatus(200); return; }
  // Dedup webhook retries.
  if (!(await store.markTelegramUpdate(db, update.update_id))) { res.sendStatus(200); return; }

  res.sendStatus(200); // fast ack; do the work out-of-band
  runTurn(pool, key, runtime, acc, msg).catch((e: any) => log?.error({ err: e?.message }, 'telegram turn failed'));
}

// ONE try around the whole turn, and everything that fails throws into it. A
// silent failure looks like the bot is ignoring you, so the catch is the single
// place that reports — it loads its own bot token, so even a failure while
// loading the token for the turn itself still gets reported. We rethrow so the
// caller logs it server-side too.
async function runTurn(pool: DB, key: Buffer, runtime: any, acc: any, msg: any) {
  const db = getDb(pool);
  const dm = acc.dmChatId as number;
  try {
    const client = new TelegramClient(await store.getTelegramSecret(db, key, 'botToken'));
    const text = await resolveText(db, key, client, dm, msg);
    if (text === null) return; // nothing usable (already told the user why)
    await runTurnInner(db, key, runtime, acc, client, dm, text, msg);
  } catch (err: any) {
    const token = await store.getTelegramSecret(db, key, 'botToken').catch(() => '');
    if (token) await new TelegramClient(token).sendMessage(dm, `⚠️ Something went wrong running the agent:\n${err?.message ?? String(err)}`).catch(() => {});
    throw err;
  }
}

// What the user actually said: the message text, or a transcribed voice note.
// Returns null when there's nothing to run (and the user has been told why).
async function resolveText(db: DB, key: Buffer, client: TelegramClient, dm: number, msg: any): Promise<string | null> {
  const text = String(msg.text ?? '').trim();
  if (text) return text;

  const audio = msg.voice ?? msg.audio;
  if (audio) {
    // Telegram's getFile caps at 20 MB; check the declared size first so an
    // oversize file is declined cleanly instead of failing mid-download.
    if (audio.file_size && audio.file_size > 20 * 1024 * 1024) {
      await client.sendMessage(dm, "That audio is over Telegram's 20 MB limit for bots, so I can't fetch it.");
      return null;
    }
    await client.sendChatAction(dm, 'typing').catch(() => {});
    const transcript = await transcribeAudio(db, key, await client.downloadFile(audio.file_id));
    if (transcript === null) {
      await client.sendMessage(dm, '🎤 Voice transcription is not set up — add an AssemblyAI key in the desktop app under Transcription.');
      return null;
    }
    if (!transcript) { await client.sendMessage(dm, "🎤 I couldn't make out any speech in that."); return null; }
    await client.sendMessage(dm, `🎤 “${transcript}”`); // show what was heard before acting on it
    return transcript;
  }

  await client.sendMessage(dm, "Send me a message or a voice note and I'll get to work.");
  return null;
}

async function runTurnInner(db: DB, key: Buffer, runtime: any, acc: any, client: TelegramClient, dm: number, text: string, msg: any) {
  if (text.startsWith('/')) { await handleCommand(db, key, client, dm, text, isBusy); return; }

  const ws = await activeWorkspace(db);
  if (!ws) { await client.sendMessage(dm, '⚠️ No workspaces exist yet — add one in the desktop app first.'); return; }

  let chatId = acc.activeChatId as string | null;
  if (!chatId) { chatId = crypto.randomUUID(); await store.setTelegramActiveChat(db, chatId); }

  // Already working on this chat? Hand the message to the running turn — pi picks
  // it up at its next step — and STOP. The finish-up steps below (final render,
  // commit + push) belong to the turn that's still going: running them now would
  // commit half-edited files and abandon the first reply mid-sentence.
  if (busy.has(chatId)) {
    await client.sendMessage(dm, '⌛ Got it — after I finish the last task.', { replyToMessageId: msg?.message_id });
    await runtime.agentSend({ chatId, text, workspaceId: ws.id, workspacePath: '', provider: '', model: '', apiKey: '' }, () => {})
      .catch(() => { /* the running turn owns error reporting */ });
    return;
  }

  const pat = await store.getSecret(db, key, 'settings', 'sync.pat');
  if (!pat) { await client.sendMessage(dm, '⚠️ No GitHub token is configured on the server.'); return; }
  const dir = await prepareCheckout(chatId, ws.repoOwner, ws.repoName, ws.defaultBranch, pat);

  const settings = await store.readSettings(db, key);
  process.env.TZ = settings.timezone || 'UTC';   // optional setting → fallback at point of use
  const ca = settings.codingAgent ?? {};
  let wsBuiltinSkills: Record<string, any> = {};
  try { wsBuiltinSkills = JSON.parse(await fs.readFile(path.join(dir, '.shockwave', 'workspace.json'), 'utf8'))?.builtinSkills ?? {}; } catch { /* defaults */ }

  const sink = makeTelegramSink(client, dm);
  let finalMessages: any[] | undefined;
  const emit = (e: any) => {
    if (e?.type === 'agent_end') finalMessages = e.messages;
    feed.publish(e);              // every connected desktop sees it live
    sink.emit(e);                 // render to Telegram
  };

  const maxRunMs = (Number(process.env.CRON_MAX_RUN_MINUTES) || 30) * 60_000;
  const wd = setTimeout(() => runtime.agentAbort(chatId).catch(() => {}), maxRunMs);
  // Marked busy for the whole job, so a message arriving meanwhile is relayed
  // into THIS turn instead of starting a second one that would finish early.
  busy.add(chatId);
  try {
    await runtime.agentSend({
      chatId, text, workspaceId: ws.id, workspacePath: dir,
      provider: ca.provider, model: ca.model, apiKey: (ca.providerKeys ?? {})[ca.provider] ?? '',
      baseUrl: ca.baseUrl, contextWindow: ca.contextWindow, thinkingLevel: ca.thinkingLevel ?? 'off',
      wsBuiltinSkills, source: 'telegram', sourceId: String(dm),
    }, emit);
  } finally { clearTimeout(wd); busy.delete(chatId); }

  // Only now — with the agent actually finished — is it safe to close the reply
  // and commit. Doing either while it was still working produced a commit of
  // half-edited files and a reply abandoned mid-sentence.
  await sink.done(finalMessages);
  await checkIn(dir, ws.defaultBranch, `Shockwave telegram — ${new Date().toISOString()}`, pat).catch(() => {});

  // A turn can end badly WITHOUT throwing: pi reports it as the last assistant
  // message's stopReason ('error' from the provider, 'aborted' from the watchdog
  // above, 'length' on max tokens). Anything but 'stop' gets reported — throwing
  // routes it through runTurn's catch, which replies in-chat and logs it.
  const last = [...(finalMessages ?? [])].reverse().find((m: any) => m?.role === 'assistant');
  if (last && last.stopReason !== 'stop') throw new Error(last.errorMessage || `the run ended early (${last.stopReason}).`);
}
