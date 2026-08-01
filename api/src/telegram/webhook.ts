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
import { prepareCheckout, type GitAuth } from '../git.js';
import { checkInWithFixer } from '../gitFixer.js';
import { TelegramClient } from './client.js';
import { makeTelegramSink } from './stream.js';
import { BOT_COMMANDS, handleCommand, activeWorkspace } from './commands.js';
import { transcribeAudio } from './transcribe.js';
import { cacheAttachment, composeMessage, MAX_INBOUND_BYTES, type CachedAttachment } from './attachments.js';
import { getCatalogModel } from '../../../agent-core/modelCatalog.js';
import { chatFilesDir } from '../dataDirs.js';
import { logger } from '../log.js';

const tlog = logger('telegram');

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

  // An album (several photos sent at once) arrives as SEPARATE updates sharing a
  // media_group_id. Run each as its own turn and the second one lands while the
  // first is still working — it gets treated as an interruption, and the caption,
  // which Telegram puts on only one item, is stranded away from the rest. So they
  // are collected briefly and run as one message.
  const groupId = msg.media_group_id ? String(msg.media_group_id) : null;
  if (groupId) { queueAlbum(groupId, msg, (msgs) => runTurnLogged(pool, key, runtime, acc, msgs, log)); return; }

  runTurnLogged(pool, key, runtime, acc, [msg], log);
}

function runTurnLogged(pool: DB, key: Buffer, runtime: any, acc: any, msgs: any[], log: any) {
  runTurn(pool, key, runtime, acc, msgs).catch((e: any) => log?.error({ err: e?.message }, 'telegram turn failed'));
}

// Telegram sends album items back-to-back, so a short wait that restarts on each
// arrival collects the whole set without delaying a single-photo message by more
// than this once.
const ALBUM_WAIT_MS = 800;
const albums = new Map<string, { msgs: any[]; timer: NodeJS.Timeout }>();

function queueAlbum(groupId: string, msg: any, run: (msgs: any[]) => void) {
  const entry = albums.get(groupId) ?? { msgs: [], timer: null as any };
  entry.msgs.push(msg);
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    albums.delete(groupId);
    run(entry.msgs);
  }, ALBUM_WAIT_MS);
  albums.set(groupId, entry);
}

// ONE try around the whole turn, and everything that fails throws into it. A
// silent failure looks like the bot is ignoring you, so the catch is the single
// place that reports — it loads its own bot token, so even a failure while
// loading the token for the turn itself still gets reported. We rethrow so the
// caller logs it server-side too.
async function runTurn(pool: DB, key: Buffer, runtime: any, acc: any, msgs: any[]) {
  const db = getDb(pool);
  const dm = acc.dmChatId as number;
  const msg = msgs[0];
  try {
    const client = new TelegramClient(await store.getTelegramSecret(db, key, 'botToken'));
    // Attachments land in the chat's own staging dir, so saving one needs the chat
    // to exist. Minting it lazily keeps `/help` and friends from creating a chat
    // just by being typed — they never carry a file.
    let chatId: string | null = acc.activeChatId ?? null;
    const getChatId = async () => {
      if (!chatId) { chatId = crypto.randomUUID(); await store.setTelegramActiveChat(db, chatId); }
      return chatId;
    };
    const input = await resolveInput(db, key, client, dm, getChatId, msgs);
    if (input === null) return; // nothing usable (already told the user why)
    await runTurnInner(db, key, runtime, acc, client, dm, getChatId, input, msg);
  } catch (err: any) {
    const token = await store.getTelegramSecret(db, key, 'botToken').catch(() => '');
    if (token) await new TelegramClient(token).sendMessage(dm, `⚠️ Something went wrong running the agent:\n${err?.message ?? String(err)}`).catch(() => {});
    throw err;
  }
}

// Every file-bearing field Telegram can put on a message, in the order we prefer
// to read them. `kind` biases classification when the file arrives with no usable
// name — a native photo has neither filename nor mime type.
//
// `document` is deliberately unbiased: Telegram uses it for anything sent via the
// file picker, including images and video, so its own mime/extension decides.
const MEDIA_FIELDS: Array<{ field: string; kind?: 'image' | 'video' | 'audio' }> = [
  { field: 'photo', kind: 'image' },
  { field: 'document' },
  { field: 'video', kind: 'video' },
  { field: 'video_note', kind: 'video' },
  { field: 'animation', kind: 'video' },
  { field: 'audio', kind: 'audio' },
];

/** The file object for a field, picking the largest size for a photo. */
function fileOf(msg: any, field: string): any {
  const v = msg?.[field];
  if (!v) return null;
  return Array.isArray(v) ? v[v.length - 1] : v; // photo comes as ascending sizes
}

export interface ResolvedInput {
  /** The prompt: attachment notes, inlined text files, then what the user typed. */
  text: string;
  /** Images for the model to actually look at. Empty when it can't see them. */
  images: Array<{ type: 'image'; data: string; mimeType: string }>;
}

/**
 * What the user actually sent: their words, plus any files.
 *
 * Returns null when there is nothing to run — and the user has been told why,
 * because a bot that silently ignores a message reads as broken.
 *
 * A VOICE NOTE is transcribed and becomes the message — it is the user talking,
 * just not in text. An audio FILE is not: it is a file, and goes through the same
 * path as any other attachment. This used to read `msg.voice ?? msg.audio` and
 * transcribe both, so sending an mp3 made its entire transcript the prompt.
 */
async function resolveInput(
  db: DB, key: Buffer, client: TelegramClient, dm: number,
  getChatId: () => Promise<string>, msgs: any[],
): Promise<ResolvedInput | null> {
  // Telegram puts the caption on whichever album item carried it, so take the
  // first one present rather than assuming the first message.
  const typed = msgs.map((m) => String(m.text ?? m.caption ?? '').trim()).find(Boolean) ?? '';

  const settings = await store.readSettings(db, key);
  const tr = settings?.transcription;

  // A voice note is the message itself, not an attachment to it.
  const voice = msgs.map((m) => m.voice).find(Boolean);
  if (voice && !typed) {
    if (voice.file_size && voice.file_size > MAX_INBOUND_BYTES) {
      await client.sendMessage(dm, "That audio is over Telegram's 20 MB limit for bots, so I can't fetch it.");
      return null;
    }
    await client.sendChatAction(dm, 'typing').catch(() => {});
    const transcript = await transcribeAudio(tr?.apiKey, await client.downloadFile(voice.file_id), tr?.provider);
    if (transcript === null) {
      await client.sendMessage(dm, '🎤 Voice transcription is not set up — add an AssemblyAI key in the desktop app under Transcription.');
      return null;
    }
    if (!transcript) { await client.sendMessage(dm, "🎤 I couldn't make out any speech in that."); return null; }
    // Optional: show what was heard before acting on it, so a mis-transcription is
    // distinguishable from a misunderstood instruction. Off unless switched on
    // (Settings → Transcription) — `?? false` at the point of use, since the
    // companion stores no defaults and an unset row must not fake a value.
    if (tr?.echoTelegramTranscript ?? false) await client.sendMessage(dm, `🎤 “${transcript}”`);
    return { text: transcript, images: [] };
  }

  // Everything else is a file: save it, then describe it to the agent.
  const pending = msgs.flatMap((m) =>
    MEDIA_FIELDS.map(({ field, kind }) => ({ file: fileOf(m, field), kind }))
      .filter((x) => x.file));

  if (!pending.length) {
    if (typed) return { text: typed, images: [] };
    await client.sendMessage(dm, "Send me a message, a voice note, or a file and I'll get to work.");
    return null;
  }

  await client.sendChatAction(dm, 'typing').catch(() => {});
  const attachments: CachedAttachment[] = [];
  for (const { file, kind } of pending) {
    if (file.file_size && file.file_size > MAX_INBOUND_BYTES) {
      await client.sendMessage(dm, `“${file.file_name ?? 'That file'}” is over Telegram's 20 MB limit for bots, so I can't fetch it.`);
      continue;
    }
    const cached = await cacheAttachment(await getChatId(), await client.downloadFile(file.file_id), {
      filename: file.file_name, mimeType: file.mime_type, defaultKind: kind,
    });
    if (cached) attachments.push(cached);
  }

  if (!attachments.length) {
    if (typed) return { text: typed, images: [] };
    await client.sendMessage(dm, "I couldn't read that file, so there's nothing for me to work with.");
    return null;
  }

  // Only attach pixels a model can actually look at. When we can't confirm it
  // can, the file still arrives and the note says the contents aren't visible —
  // claiming to have seen an image is worse than saying we didn't.
  const visionAvailable = await modelSeesImages(settings);
  const images: ResolvedInput['images'] = [];
  if (visionAvailable) {
    for (const a of attachments.filter((x) => x.kind === 'image')) {
      images.push({ type: 'image', data: (await fs.readFile(a.path)).toString('base64'), mimeType: a.mimeType });
    }
  }

  return { text: composeMessage(attachments, typed, visionAvailable), images };
}

/** Does the configured model accept images? Unknown counts as no. */
async function modelSeesImages(settings: any): Promise<boolean> {
  const ca = settings?.codingAgent ?? {};
  if (!ca.provider || !ca.model) return false;
  try {
    const entry = await getCatalogModel(ca.provider, ca.model);
    return !!entry?.input?.includes('image');
  } catch {
    return false;
  }
}

async function runTurnInner(
  db: DB, key: Buffer, runtime: any, acc: any, client: TelegramClient, dm: number,
  getChatId: () => Promise<string>, input: ResolvedInput, msg: any,
) {
  const { text, images } = input;
  if (text.startsWith('/')) { await handleCommand(db, key, client, dm, text, isBusy); return; }

  const ws = await activeWorkspace(db);
  if (!ws) { await client.sendMessage(dm, '⚠️ No workspaces exist yet — add one in the desktop app first.'); return; }

  const chatId = await getChatId();

  // Already working on this chat? Hand the message to the running turn — pi picks
  // it up at its next step — and STOP. The finish-up steps below (final render,
  // commit + push) belong to the turn that's still going: running them now would
  // commit half-edited files and abandon the first reply mid-sentence.
  //
  // Images ride along: a photo sent mid-turn is part of what the user is saying,
  // and dropping it silently is the worst of the three options.
  if (busy.has(chatId)) {
    await client.sendMessage(dm, '⌛ Got it — after I finish the last task.', { replyToMessageId: msg?.message_id });
    await runtime.agentSend({ chatId, text, images, workspaceId: ws.id, workspacePath: '', provider: '', model: '', apiKey: '' }, () => {})
      .catch(() => { /* the running turn owns error reporting */ });
    return;
  }

  const pat = await store.getSecret(db, key, 'settings', 'sync.pat');
  if (!pat) { await client.sendMessage(dm, '⚠️ No GitHub token is configured on the server.'); return; }
  // Carried together so every network git call is pinned to THIS repo — the URL
  // is set from it on the command line rather than read from a .git/config the
  // agent can rewrite. See guards() in git.ts.
  const auth: GitAuth = { pat, owner: ws.repoOwner, repo: ws.repoName };
  const dir = await prepareCheckout(chatId, ws.repoOwner, ws.repoName, ws.defaultBranch, pat);

  const settings = await store.readSettings(db, key);
  process.env.TZ = settings.timezone || 'UTC';   // optional setting → fallback at point of use
  const ca = settings.codingAgent ?? {};
  const apiKey = (ca.providerKeys ?? {})[ca.provider] ?? '';
  let wsBuiltinSkills: Record<string, any> = {};
  try { wsBuiltinSkills = JSON.parse(await fs.readFile(path.join(dir, '.shockwave', 'workspace.json'), 'utf8'))?.builtinSkills ?? {}; } catch { /* defaults */ }

  // The only two folders a file may be sent from: the workspace the agent is
  // working in, and where its own attachments were saved.
  const sink = makeTelegramSink(client, dm, [dir, chatFilesDir(chatId)]);
  let finalMessages: any[] | undefined;
  const emit = (e: any) => {
    if (e?.type === 'agent_end') finalMessages = e.messages;
    feed.publish(e);              // every connected desktop sees it live
    sink.emit(e);                 // render to Telegram
  };

  const maxRunMs = (Number(ca.maxRunMinutes) || 30) * 60_000;
  tlog.info({ chatId, ws: ws.id }, 'telegram turn started');
  const wd = setTimeout(() => {
    tlog.warn({ chatId, maxRunMs }, 'telegram watchdog fired — aborting turn');
    runtime.agentAbort(chatId).catch(() => {});
  }, maxRunMs);
  // Marked busy for the whole job, so a message arriving meanwhile is relayed
  // into THIS turn instead of starting a second one that would finish early.
  busy.add(chatId);
  try {
    await runtime.agentSend({
      chatId, text, images, workspaceId: ws.id, workspacePath: dir,
      provider: ca.provider, model: ca.model, apiKey,
      baseUrl: ca.baseUrl, contextWindow: ca.contextWindow, thinkingLevel: ca.thinkingLevel ?? 'off',
      wsBuiltinSkills, source: 'telegram', sourceId: String(dm),
      timezone: settings.timezone,   // same zone the scheduler evaluates cron.json in
    }, emit);
  } finally { clearTimeout(wd); busy.delete(chatId); }

  // Only now — with the agent actually finished — is it safe to close the reply
  // and commit. Doing either while it was still working produced a commit of
  // half-edited files and a reply abandoned mid-sentence.
  await sink.done(finalMessages);
  // Identical to the cron path — same function, not a copy. See gitFixer.ts.
  const checkedIn = await checkInWithFixer(
    dir, ws.defaultBranch, `Shockwave telegram — ${new Date().toISOString()}`, auth,
    { provider: ca.provider, model: ca.model, apiKey, baseUrl: ca.baseUrl },
    { attempts: Number(ca.maxFixAttempts) || 3, maxMs: maxRunMs },
  ).catch(() => 'error' as const);
  tlog[checkedIn === 'conflict' || checkedIn === 'error' ? 'error' : 'info'](
    { chatId, ws: ws.id, checkIn: checkedIn }, 'telegram turn finished',
  );
  // Say so in chat. This used to be `.catch(() => {})` with the result thrown
  // away, so work that never reached GitHub looked exactly like work that did —
  // and the next message's prepareCheckout reset --hard'd it out of existence.
  if (checkedIn === 'conflict' || checkedIn === 'error') {
    await client.sendMessage(dm, `⚠️ I finished, but couldn't save the changes to GitHub (${checkedIn}). The work is still in this run's checkout — say so before sending me anything else, or the next message will discard it.`).catch(() => {});
  }

  // A turn can end badly WITHOUT throwing: pi reports it as the last assistant
  // message's stopReason ('error' from the provider, 'aborted' from the watchdog
  // above, 'length' on max tokens). Anything but 'stop' gets reported — throwing
  // routes it through runTurn's catch, which replies in-chat and logs it.
  const last = [...(finalMessages ?? [])].reverse().find((m: any) => m?.role === 'assistant');
  if (last && last.stopReason !== 'stop') throw new Error(last.errorMessage || `the run ended early (${last.stopReason}).`);
}
