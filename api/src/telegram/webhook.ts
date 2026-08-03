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
import type { PgPool, Db } from '../db.js';
import { getDb } from '../db.js';
import * as store from '../store.js';
import * as feed from '../feed.js';
import { prepareCheckout, landed, type GitAuth } from '../git.js';
import { checkInWithFixer } from '../gitFixer.js';
import { TelegramClient } from './client.js';
import { makeTelegramSink } from './stream.js';
import { BOT_COMMANDS, handleCommand, activeWorkspace } from './commands.js';
import { transcribeAudio, warmTranscription, listenProviderOf, voiceLabel } from './transcribe.js';
import { voiceConfigOf } from '../../../agent-core/voiceProviders.js';
import { readVoiceReply, sendsText, speaks, type VoiceReply } from '../../../agent-core/voiceReply.js';
import { speakInto } from './sendTool.js';
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

// Progress shown ON the voice message itself: ✍ while we're transcribing, 👍 once
// the words are in hand and the turn is about to run. Cleared on every bail-out,
// so a dead ✍ never outlives the message explaining what went wrong.
//
// WRITTEN AS ESCAPES ON PURPOSE. Telegram's allowed reaction list is a fixed set
// of 73 emoji and NOT ONE of them carries a variation selector — the writing hand
// is U+270D alone, never U+270D U+FE0F. A glyph pasted from an emoji picker or a
// browser brings the selector with it, which is a different string than the one
// Telegram accepts, and the call comes back REACTION_INVALID. An escape is the
// one spelling an editor can't silently change.
const REACT_TRANSCRIBING = '\u{270D}';  // ✍ writing hand, no U+FE0F
const REACT_HEARD = '\u{1F44D}';        // 👍 thumbs up

function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a); const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// ── Setup (called by the desktop Settings tab via companion endpoints) ────────

export async function connect(pool: PgPool, key: Buffer, opts: { botToken: string; authorizedTgUserId: number; publicUrl: string; certificatePem?: string }) {
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

export async function disconnect(pool: PgPool, key: Buffer) {
  const db = getDb(pool);
  const token = await store.getTelegramSecret(db, key, 'botToken').catch(() => '');
  if (token) { try { await new TelegramClient(token).deleteWebhook(); } catch { /* best-effort */ } }
  await store.clearTelegramAccount(db);
}

// Push the current command list to Telegram. Runs at every boot, not just at
// connect: the list lives in code, so a bot connected before a command existed
// would otherwise keep showing the old menu forever — which is exactly what
// happened when /chats, /workspaces and /btw were added.
export async function syncCommands(pool: PgPool, key: Buffer, log?: any) {
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

export async function status(pool: PgPool) {
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

export async function handleWebhook(pool: PgPool, key: Buffer, runtime: any, req: express.Request, res: express.Response, log: any) {
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

function runTurnLogged(pool: PgPool, key: Buffer, runtime: any, acc: any, msgs: any[], log: any) {
  runTurn(pool, key, runtime, acc, msgs).catch((e: any) => log?.error({ err: e?.message }, 'telegram turn failed'));
}

// Telegram sends album items back-to-back, so a short wait that restarts on each
// arrival collects the whole set without delaying a single-photo message by more
// than this once.
const ALBUM_WAIT_MS = 800;
const albums = new Map<string, { msgs: any[]; timer: NodeJS.Timeout }>();

function queueAlbum(groupId: string, msg: any, run: (msgs: any[]) => void) {
  // `msgs: []` on its own infers `never[]` and nothing may be pushed into it —
  // the annotation is what makes the fresh entry match the map's value type.
  const entry: { msgs: any[]; timer: NodeJS.Timeout } = albums.get(groupId) ?? { msgs: [], timer: null as any };
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
async function runTurn(pool: PgPool, key: Buffer, runtime: any, acc: any, msgs: any[]) {
  const db = getDb(pool);
  const dm = acc.dmChatId as number;
  const msg = msgs[0];
  let stopTyping = () => { /* nothing started yet */ };
  try {
    const client = new TelegramClient(await store.getTelegramSecret(db, key, 'botToken'));
    // Say we're here BEFORE doing any of the work. The first sign of life used
    // to come from makeTelegramSink, which is built after the workspace checkout
    // — so on a plain text message the user watched an empty chat through a
    // clone and a session boot, with nothing to say whether the bot had even
    // received it.
    stopTyping = startTyping(client, dm);
    // Attachments land in the chat's own staging dir, so saving one needs the chat
    // to exist. Minting it lazily keeps `/help` and friends from creating a chat
    // just by being typed — they never carry a file.
    let chatId: string | null = acc.activeChatId ?? null;
    const getChatId = async () => {
      if (!chatId) { chatId = crypto.randomUUID(); await store.setTelegramActiveChat(db, chatId); }
      return chatId;
    };

    // A command is answered from the database and runs no turn, so it must not
    // drag a checkout in behind it. Read from the raw message rather than from
    // resolveInput's result, because the decision has to be made BEFORE that
    // runs — which is the whole point of starting the two sides together. A
    // voice note or a file is never a command.
    const typed = typedTextOf(msgs);
    const isCommand = typed.startsWith('/');
    // A chat with a turn in flight is joined, not started: its session is live
    // and owns its own event sink, so preparing would re-point it mid-reply.
    const alreadyRunning = !!chatId && busy.has(chatId);

    // Both sides start here. Failures are captured rather than thrown, so an
    // unhandled rejection can't escape while the other side is still working.
    const prep = isCommand || alreadyRunning
      ? null
      : settle(prepareRun(db, key, runtime, dm, getChatId));

    const input = await resolveInput(db, key, client, dm, getChatId, msgs);
    if (input === null) { await prep; return; } // nothing usable (already told the user why)

    if (isCommand) { await handleCommand(db, key, client, dm, input.text, isBusy); return; }

    if (alreadyRunning && chatId) { await relayToRunningTurn(db, runtime, client, dm, chatId, input, msg); return; }

    const ready = await prep!;
    if (!ready.ok) throw ready.error;
    if (isRefusal(ready.value)) { await client.sendMessage(dm, ready.value.refusal); return; }

    // The turn could have STARTED while we were resolving the message — with the
    // two sides running together that window is real, so the check has to happen
    // again here and not only before the fan-out.
    if (busy.has(ready.value.chatId)) {
      await relayToRunningTurn(db, runtime, client, dm, ready.value.chatId, input, msg);
      return;
    }

    await runTurnInner(db, key, runtime, acc, client, dm, input, msg, ready.value);
  } catch (err: any) {
    const token = await store.getTelegramSecret(db, key, 'botToken').catch(() => '');
    if (token) await new TelegramClient(token).sendMessage(dm, `⚠️ Something went wrong running the agent:\n${err?.message ?? String(err)}`).catch(() => {});
    throw err;
  } finally {
    stopTyping();
  }
}

// Telegram's typing indicator lasts about five seconds, so holding it means
// re-sending it. ONE owner for the whole turn (`runTurn`'s finally), rather than
// the stream sink starting a second one for the part it covers — overlapping
// timers would just be duplicate API calls, and the gap before the sink existed
// was the actual problem.
const TYPING_INTERVAL_MS = 4000;

/**
 * Hand the message to the turn already in flight — pi picks it up at its next
 * step — and STOP. The finish-up steps (final render, commit + push) belong to
 * the turn that's still going: running them now would commit half-edited files
 * and abandon the first reply mid-sentence.
 *
 * Images ride along: a photo sent mid-turn is part of what the user is saying,
 * and dropping it silently is the worst of the three options.
 *
 * `workspaceId` is real, not blank. A steer returns from agentSend before it
 * needs a workspace, but `searchCtx` — what scopes the agent's `search_chats`
 * to this workspace — is assigned BEFORE that early return, so an empty value
 * would silently unscope the search tool for the turn that is still running.
 */
async function relayToRunningTurn(
  db: Db, runtime: any, client: TelegramClient, dm: number,
  chatId: string, input: ResolvedInput, msg: any,
) {
  const ws = await activeWorkspace(db);
  await client.sendMessage(dm, '⌛ Got it — after I finish the last task.', { replyToMessageId: msg?.message_id });
  await runtime.agentSend(
    { chatId, text: input.text, images: input.images, workspaceId: ws?.id ?? '', workspacePath: '', provider: '', model: '', apiKey: '' },
    () => { /* the running turn owns its own sink */ },
  ).catch(() => { /* the running turn owns error reporting */ });
}

/** What the user typed, before any file or audio is resolved. Telegram puts the
 *  caption on whichever album item carried it, so take the first one present. */
function typedTextOf(msgs: any[]): string {
  return msgs.map((m) => String(m.text ?? m.caption ?? '').trim()).find(Boolean) ?? '';
}

/** Run a promise to completion and report which way it went.
 *
 *  Two things are started together here and only joined later, so a rejection
 *  has to be held rather than thrown — an unhandled rejection while the other
 *  side is still running takes the process down under Node's default. */
type Settled<T> = { ok: true; value: T } | { ok: false; error: any };

function settle<T>(p: Promise<T>): Promise<Settled<T>> {
  return p.then((value) => ({ ok: true as const, value }), (error) => ({ ok: false as const, error }));
}

function startTyping(client: TelegramClient, dm: number): () => void {
  const ping = () => { client.sendChatAction(dm).catch(() => { /* best-effort */ }); };
  ping();
  const timer = setInterval(ping, TYPING_INTERVAL_MS);
  return () => clearInterval(timer);
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
  db: Db, key: Buffer, client: TelegramClient, dm: number,
  getChatId: () => Promise<string>, msgs: any[],
): Promise<ResolvedInput | null> {
  // The same read runTurn used to decide whether this is a command — one
  // function, so the two can't disagree about what the user typed.
  const typed = typedTextOf(msgs);

  const settings = await store.readSettings(db, key);
  const voiceCfg = voiceConfigOf(settings);

  // A voice note is the message itself, not an attachment to it. Keep the whole
  // message, not just its `voice` field — the reactions below go on that bubble,
  // so we need its message_id.
  const voiceMsg = msgs.find((m) => m.voice);
  const voice = voiceMsg?.voice;
  if (voice && !typed) {
    // Best-effort and awaited. Awaited because these replace each other: fired
    // and forgotten, a ✍ that lands after the 👍 leaves the message showing the
    // wrong state permanently. One cheap round trip against seconds of
    // transcription is not a cost worth racing.
    const react = (emoji?: string) =>
      client.setMessageReaction(dm, voiceMsg.message_id, emoji).catch(() => { /* cosmetic */ });

    if (voice.file_size && voice.file_size > MAX_INBOUND_BYTES) {
      await client.sendMessage(dm, "That audio is over Telegram's 20 MB limit for bots, so I can't fetch it.");
      return null;   // nothing started, so nothing to clear
    }
    await react(REACT_TRANSCRIBING);
    // Open the speech-to-text connection while Telegram is still handing us the
    // bytes. Both are round trips and neither needs the other, so the handshake
    // costs nothing instead of ~150ms on the critical path. Best-effort — it
    // resolves to nothing useful and never rejects.
    const warming = warmTranscription(voiceCfg);
    const audio = await client.downloadFile(voice.file_id);
    await warming;
    // `voice.duration` is Telegram's own, in seconds — it decides whether this
    // fits the sync API's two-minute ceiling.
    const transcript = await transcribeAudio(voiceCfg, audio, voice.duration)
      .catch(async (e) => { await react(); throw e; });
    if (transcript === null) {
      await react();
      // Name the engine Settings is actually set to, or this sends someone to add
      // a key for a provider they aren't using.
      const name = voiceLabel(listenProviderOf(voiceCfg));
      await client.sendMessage(dm, `🎤 Voice transcription is not set up — add a ${name} key in the desktop app under Settings → Agent Voice.`);
      return null;
    }
    if (!transcript) {
      await react();
      await client.sendMessage(dm, "🎤 I couldn't make out any speech in that.");
      return null;
    }
    // Heard, and the turn is about to run on these words.
    await react(REACT_HEARD);
    // Optional: show what was heard before acting on it, so a mis-transcription is
    // distinguishable from a misunderstood instruction. Off unless switched on
    // (Settings → Agent Voice) — `?? false` at the point of use, since the
    // companion stores no defaults and an unset row must not fake a value.
    if (voiceCfg.transcription?.echoTelegramTranscript ?? false) await client.sendMessage(dm, `🎤 “${transcript}”`);
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

/** Everything a turn needs that does NOT depend on what the user said. */
interface PreparedRun {
  ws: any; chatId: string; dir: string; auth: GitAuth;
  ca: any; apiKey: string; wsBuiltinSkills: Record<string, any>;
  /** Carried rather than re-read: the settings read happens in prepareRun, which
   *  now runs on the other side of the fan-out from the turn that needs this. */
  timezone: string | undefined;
  /** How this workspace wants replies delivered. Read in prepareRun for the same
   *  reason, and additionally so that the agent's own `send_message(save: true)`
   *  mid-turn takes effect on the NEXT reply rather than retroactively on the one
   *  already being composed. */
  voiceReply: VoiceReply;
}

/** A reason to stop, phrased for the user. Returned rather than thrown so the
 *  caller reports it in chat instead of it surfacing as "something went wrong". */
interface PrepareRefusal { refusal: string }

const isRefusal = (r: PreparedRun | PrepareRefusal): r is PrepareRefusal => 'refusal' in r;

/**
 * Get the workspace ready and boot the agent — the half of a turn that needs
 * none of the message.
 *
 * Split out so it can run WHILE the message is still being resolved. A voice
 * note is seconds of transcription and a file is a download, and this side is a
 * git fetch plus a session boot; run in sequence they add up, run together the
 * slower one is the whole wait. Nothing here reads the text, which is what makes
 * that legal.
 *
 * The pi session is only pre-booted for a chat that ALREADY EXISTS. Booting also
 * creates the chat row (`upsertChat`), and a row whose transcript never arrived
 * — because the transcription came back empty and no turn ever ran — is a chat
 * that refuses to resume once the scratch dir ages out. An existing chat has
 * both already, so there is nothing to leave half-made; and it is the case the
 * pre-boot is worth most in, since resuming downloads and parses the transcript.
 */
async function prepareRun(
  db: Db, key: Buffer, runtime: any, dm: number, getChatId: () => Promise<string>,
): Promise<PreparedRun | PrepareRefusal> {
  const ws = await activeWorkspace(db);
  if (!ws) return { refusal: '⚠️ No workspaces exist yet — add one in the desktop app first.' };

  const pat = await store.getSecret(db, key, 'settings', 'sync.pat');
  if (!pat) return { refusal: '⚠️ No GitHub token is configured on the server.' };

  const chatId = await getChatId();
  const existing = await store.getChat(db, chatId);
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
  // How this workspace wants replies delivered. Read here, off the checkout this
  // turn is running in, rather than at the end of the turn — by then the agent's
  // own `send_message(save: true)` may have rewritten the file, and a request to
  // start speaking should take effect on the NEXT reply, not retroactively on the
  // one that was already being composed as text.
  const voiceReply = await readVoiceReply(dir);

  if (existing) {
    // Events during boot go to the feed only; agentSend re-points the session at
    // the Telegram sink when the turn actually starts. A misconfiguration here
    // surfaces from agentSend with the same message, so it is not reported twice.
    await runtime.agentPrepare({
      chatId, text: '', workspaceId: ws.id, workspacePath: dir,
      provider: ca.provider, model: ca.model, apiKey,
      baseUrl: ca.baseUrl, contextWindow: ca.contextWindow, thinkingLevel: ca.thinkingLevel ?? 'off',
      wsBuiltinSkills, source: 'telegram', sourceId: String(dm),
      memoryCharLimit: ca.memoryCharLimit, userCharLimit: ca.userCharLimit,
    }, feed.publish).catch(() => { /* agentSend reports it */ });
  }

  return { ws, chatId, dir, auth, ca, apiKey, wsBuiltinSkills, timezone: settings.timezone, voiceReply };
}

async function runTurnInner(
  db: Db, key: Buffer, runtime: any, acc: any, client: TelegramClient, dm: number,
  input: ResolvedInput, msg: any, prepared: PreparedRun,
) {
  const { text, images } = input;
  const { ws, chatId, dir, auth, ca, apiKey, wsBuiltinSkills, timezone, voiceReply } = prepared;

  // The only two folders a file may be sent from: the workspace the agent is
  // working in, and where its own attachments were saved.
  // The workspace's reply mode, read once in prepareRun off the checkout this turn
  // is running in. Absent `speak` is what `text` means — see makeTelegramSink.
  const sink = makeTelegramSink(client, dm, [dir, chatFilesDir(chatId)], {
    speak: speaks(voiceReply)
      ? (text: string) => speakInto(db, key, client, dm, text, dir)
      : undefined,
    textToo: sendsText(voiceReply),
  });
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
      timezone,   // same zone the scheduler evaluates cron.json in
      memoryCharLimit: ca.memoryCharLimit, userCharLimit: ca.userCharLimit,
    }, emit);
  } catch (e) {
    // `sink.done()` below is never reached on this path, so the sink has to be
    // torn down here: otherwise its placeholder bubble is stranded above the
    // error reply runTurn is about to send, and its edit timer runs forever.
    await sink.dispose();
    throw e;
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
  tlog[landed(checkedIn) ? 'info' : 'error'](
    { chatId, ws: ws.id, checkIn: checkedIn }, 'telegram turn finished',
  );
  // Say so in chat. This used to be `.catch(() => {})` with the result thrown
  // away, so work that never reached GitHub looked exactly like work that did.
  //
  // It no longer warns that the next message will discard the work: it won't.
  // prepareCheckout's reset is guarded on "is there anything to lose?", and a
  // failed check-in leaves exactly that — so the folder is left alone and the
  // next turn's `add -A` sweeps the work into its commit. Telling the user to
  // stop typing was asking them to protect against something that can't happen.
  if (!landed(checkedIn)) {
    await client.sendMessage(dm, `⚠️ I finished, but couldn't save the changes to GitHub (${checkedIn}). The work is safe in this run's checkout and I'll try again on your next message.`).catch(() => {});
  }

  // A turn can end badly WITHOUT throwing: pi reports it as the last assistant
  // message's stopReason ('error' from the provider, 'aborted' from the watchdog
  // above, 'length' on max tokens). Anything but 'stop' gets reported — throwing
  // routes it through runTurn's catch, which replies in-chat and logs it.
  const last = [...(finalMessages ?? [])].reverse().find((m: any) => m?.role === 'assistant');
  if (last && last.stopReason !== 'stop') throw new Error(last.errorMessage || `the run ended early (${last.stopReason}).`);
}
