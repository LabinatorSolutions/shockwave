// Sending a Telegram DM to the user, server-side. The bot token lives only here
// (encrypted, owner `telegram`), so this is the ONE place a message is actually
// sent — the agent tool wraps it (agent-core/sendMessage.ts) and the desktop
// reaches it over HTTP (`POST /telegram/send`). Reads the account at call time,
// so it works whenever Telegram is connected and explains itself when it isn't.

import path from 'node:path';
import fs from 'node:fs/promises';
import { TelegramClient, type SendKind } from './client.js';
import { toTelegram, splitFormatted } from './markdownEntities.js';
import * as store from '../store.js';
import type { PgPool } from '../db.js';
import { getDb } from '../db.js';
import { voiceConfigOf } from '../../../agent-core/voiceProviders.js';
import { speakToFile, speakLimitFor } from '../../../agent-core/speak.js';
import { splitForSpeech } from '../../../agent-core/speechChunks.js';
import { startWaitingBubble } from './waitingBubble.js';
import { sendsText, speaks } from '../../../agent-core/voiceReply.js';
import type { SendOptions, SendResult } from '../../../agent-core/sendMessage.js';
import { logger } from '../log.js';

export type { SendResult };

const tlog = logger('telegram');

export async function sendTelegramMessage(
  pool: PgPool,
  key: Buffer,
  text: string,
  opts: SendOptions & {
    /** Whose preference applies when `output` is absent. Unset ⇒ the default,
     *  which is what a caller with no workspace in hand should get. */
    workspaceId?: string | null;
    /** Where to write the audio file, when there is a run directory to put it
     *  beside. Purely a scratch location — nothing is read from it. */
    workDir?: string | null;
    /** Which chat is speaking — recorded against each bubble so a REPLY to it
     *  resumes this conversation (switchChatForReply). This is the case the
     *  feature is worth most in: a cron job or a desktop turn reaches out, and
     *  answering it should land where the work is, not in whatever chat Telegram
     *  happened to be pointed at. Unset ⇒ a reply just doesn't switch. */
    chatId?: string | null;
  } = {},
): Promise<SendResult> {
  try {
    const db = getDb(pool);
    const acc = await store.getTelegramAccount(db);
    if (!acc || !acc.enabled || acc.dmChatId == null) {
      return { ok: false, error: 'No Telegram account is connected, so the message was not sent.' };
    }
    const token = await store.getTelegramSecret(db, key, 'botToken');
    if (!token) return { ok: false, error: 'Telegram bot token is missing.' };
    // Every bubble this sends is remembered by its message number and its chat, so
    // a reaction on it can be answered with audio and a reply to it can resume the
    // conversation that sent it. One hook on the client rather than a save beside
    // each send — see TelegramClient. Best-effort: losing the record costs a
    // reaction and a shortcut, not the message.
    const client = new TelegramClient(token, (messageId, sent) => {
      store.recordTelegramSent(db, acc.dmChatId!, messageId, sent, opts.chatId ?? null).catch(() => {});
    }, (messageId) => {
      store.deleteTelegramSent(db, acc.dmChatId!, messageId).catch(() => {});
    });

    // Explicit beats stored; stored beats the default. Nothing here WRITES the
    // preference — that is `/voice`, a slash command, so a message-sending path
    // is never also a settings write.
    const mode = opts.output ?? await store.getVoiceReply(db, opts.workspaceId);

    // This is a BOUNDARY — the one door out to Telegram — and it had no line, so
    // "who sent this?" was unanswerable. That matters most for the case it just
    // failed to answer: a message arriving twice is one caller too many, and with
    // nothing logged there is no way to tell a double call from a double send.
    tlog.info({ chars: String(text ?? '').length, mode, chatId: opts.chatId ?? null }, 'sending a telegram message');

    const sendChunks = async () => {
      // The agent's own prose, so it gets the same formatting treatment as a
      // streamed reply — this tool is the other door its words leave by.
      for (const c of splitFormatted(toTelegram(String(text ?? '')))) {
        await client.sendMessage(acc.dmChatId!, c.text, { entities: c.entities });
      }
    };

    // Text first when the mode sends it at all. Voice-only is the one mode that
    // withholds it, and it is opt-in twice over precisely because a voice note
    // can't be skimmed, searched or quoted.
    if (sendsText(mode)) await sendChunks();

    if (speaks(mode)) {
      const spoke = await speakInto(db, key, client, acc.dmChatId, text, opts.workDir ?? null,
        { originChatId: opts.chatId ?? null });
      // Voice-only withheld the text, so a synthesis failure would deliver
      // NOTHING. Fall back to sending it rather than losing the message — the
      // mode is a preference, and an undelivered answer is not a way to honour it.
      // A PARTIAL reading counts as a failure here for the same reason: the part
      // that was never spoken exists nowhere else.
      if (spoke !== 'all' && !sendsText(mode)) await sendChunks();
    }

    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: 'Could not send the message: ' + (e?.message || e) };
  }
}

/**
 * How much of `text` was spoken. The voice-ONLY path withheld the words, so it
 * needs more than a boolean: `none` means write them after all, and so does
 * `partial` — some audio arrived, but the rest of the answer exists nowhere.
 */
export type SpokenExtent = 'none' | 'partial' | 'all';

/**
 * Speak `text` and send it as voice bubbles.
 *
 * **A long script goes out in PIECES, not one file** (`splitForSpeech`), because
 * every byte of a voice note is synthesised before any of it is sent: one long
 * answer means a long silence and then everything at once. Split, the first sound
 * arrives in a second or two and each later piece is made while you are listening
 * to the one before it. Short scripts are unchanged — one piece, one bubble.
 *
 * **The dots come back between pieces**, so a gap reads as "more is coming"
 * rather than as the answer having stopped. There are deliberately none after the
 * last piece: their ABSENCE is how you know it has finished.
 *
 * The first piece's wait belongs to the caller, which already has something on
 * screen — a waiting bubble for a reaction, the turn's placeholder for a reply.
 * `onFirstSent` is how that gets taken down once there is audio to replace it, so
 * two different waiting displays are never up at once.
 */
export async function speakInto(
  db: ReturnType<typeof getDb>,
  key: Buffer,
  client: TelegramClient,
  chatId: number,
  text: string,
  workDir: string | null,
  opts: {
    /** Send the voice notes as replies to this message — how a reaction-triggered
     *  reading points back at the bubble it reads. Absent for ordinary voice
     *  replies. */
    replyToMessageId?: number;
    /** Which chat is speaking, recorded against the voice bubble. Without it a
     *  VOICE-ONLY workspace has nothing to reply to: it writes no text bubble at
     *  all, so the audio is the only thing on screen to point at. */
    originChatId?: string | null;
    /** Called once the FIRST piece has landed, so the caller can take down
     *  whatever it was showing while that piece was made. */
    onFirstSent?: () => Promise<void> | void;
  } = {},
): Promise<SpokenExtent> {
  const settings = await store.readSettings(db, key);
  const config = voiceConfigOf(settings);
  const pieces = splitForSpeech(text, speakLimitFor(config));
  if (!pieces.length) return 'none';

  // Write beside the run rather than into the checkout: the audio is a delivery
  // artifact, not the user's content, and everything in a checkout is committed.
  const dir = workDir ? path.join(workDir, '..') : '/tmp';
  const stamp = Date.now();
  let sent = 0;

  // TWO IN FLIGHT, never more. That number is the vendors' and not ours:
  // Deepgram's REST text-to-speech allows 2 concurrent requests and ElevenLabs
  // allows 2 on its free plan, so firing every piece at once takes 429s on the
  // ones it hurts most to lose — the later pieces, which is to say the end of the
  // answer. Two is the most that is safe everywhere.
  //
  // It is also the whole difference between a fast opening and a slow one. One at
  // a time, the second piece cannot even START until the first has gone out, so
  // its entire budget is the first piece's playing time and the opener has to be
  // long enough to cover it. With one always cooking, the second is made ALONGSIDE
  // the first and is waiting before it is wanted — which is what lets the opener
  // be short, and short is the only thing that makes the first sound arrive
  // quickly (synthesis is linear in length; there is no fixed cost to amortise).
  //
  // Sending stays strictly in order — `queue[i]` is awaited in sequence, never
  // raced — so a later piece finishing early can never overtake the one before it.
  const queue: (Promise<string | null> | undefined)[] = [];
  const start = (i: number) => {
    if (i >= pieces.length || queue[i]) return;
    queue[i] = speakToFile(
      pieces[i], config, path.join(dir, `reply-${stamp}-${i}.ogg`),
      (message) => tlog.warn({ err: message, piece: i }, 'speaking the reply failed'),
    ).catch(() => null);
  };
  start(0); start(1);

  for (let i = 0; i < pieces.length; i++) {
    // Nobody is covering the wait for a piece after the first — the caller's
    // display came down with the first one — so this puts the dots back up.
    const bubble = i === 0 ? null : startWaitingBubble(client, chatId);
    let file: string | null = null;
    try {
      file = await queue[i]!;
      // Refill the moment a slot frees, so there is always one being made ahead.
      start(i + 2);
      if (!file) break;
      // ONLY the first piece points back at the message being answered. The rest
      // follow it in sequence and are obviously part of the same reading — five
      // voice notes all pointing at one message is noise, and it would put a
      // quoted copy of that message above every one of them.
      const m = await client.sendFile('voice', chatId, file, undefined,
        { replyToMessageId: i === 0 ? opts.replyToMessageId : undefined });
      // The spoken text is stored against the audio bubble for the same reason a
      // written one is: a reply to it should reach the conversation that said it,
      // and in voice-only mode this bubble is the only thing there is to reply to.
      if (m?.message_id != null) {
        await store.recordTelegramSent(db, chatId, m.message_id, pieces[i], opts.originChatId ?? null).catch(() => {});
      }
      sent++;
    } catch (e: any) {
      tlog.warn({ err: e?.message ?? String(e), piece: i }, 'sending the voice reply failed');
      break;
    } finally {
      // The dots go AFTER the audio they were standing in for, never before —
      // the other order leaves a moment with nothing on screen at all.
      await bubble?.remove();
      if (file) await fs.rm(file, { force: true }).catch(() => { /* best-effort */ });
      if (sent === 1 && i === 0) await Promise.resolve(opts.onFirstSent?.()).catch(() => {});
    }
  }

  // A piece is always being made ahead, so stopping early leaves a file behind for
  // one that will never be sent. Draining is idempotent — the ones already removed
  // above simply aren't there — so this covers every exit without the loop having
  // to know which one it took.
  await Promise.all(queue.map(async (job) => {
    const file = job ? await job : null;
    if (file) await fs.rm(file, { force: true }).catch(() => { /* best-effort */ });
  }));

  if (sent === 0) return 'none';
  if (sent < pieces.length) {
    // Stopping halfway with no word about it reads as the answer simply ending
    // there. The caller writes the full text on a partial, so this only has to
    // say that the reading is what stopped. Not a reply, for the same reason the
    // later pieces aren't: it lands directly under the audio it is about.
    await client.sendMessage(chatId, '⚠️ I couldn\'t finish reading that one aloud.').catch(() => {});
    return 'partial';
  }
  return 'all';
}

/**
 * Same door, for a file. Used by the cron runner, whose reply never reaches
 * Telegram on its own — a scheduled job that produces a report has no message to
 * attach it to, so the file is sent on its own.
 *
 * The caller has already checked the path against its allowed roots; this only
 * knows how to reach Telegram.
 */
export async function sendTelegramFile(
  pool: PgPool, key: Buffer, filePath: string, kind: SendKind, caption?: string,
): Promise<SendResult> {
  try {
    const db = getDb(pool);
    const acc = await store.getTelegramAccount(db);
    if (!acc || !acc.enabled || acc.dmChatId == null) {
      return { ok: false, error: 'No Telegram account is connected, so the file was not sent.' };
    }
    const token = await store.getTelegramSecret(db, key, 'botToken');
    if (!token) return { ok: false, error: 'Telegram bot token is missing.' };
    await new TelegramClient(token).sendFile(kind, acc.dmChatId, filePath, caption);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: 'Could not send the file: ' + (e?.message || e) };
  }
}
