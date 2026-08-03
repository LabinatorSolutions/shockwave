// Sending a Telegram DM to the user, server-side. The bot token lives only here
// (encrypted, owner `telegram`), so this is the ONE place a message is actually
// sent — the agent tool wraps it (agent-core/sendMessage.ts) and the desktop
// reaches it over HTTP (`POST /telegram/send`). Reads the account at call time,
// so it works whenever Telegram is connected and explains itself when it isn't.

import path from 'node:path';
import fs from 'node:fs/promises';
import { TelegramClient, splitMessage, type SendKind } from './client.js';
import * as store from '../store.js';
import type { PgPool } from '../db.js';
import { getDb } from '../db.js';
import { voiceConfigOf } from '../../../agent-core/voiceProviders.js';
import { speakToFile } from '../../../agent-core/speak.js';
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
    const client = new TelegramClient(token);

    // Explicit beats stored; stored beats the default. Nothing here WRITES the
    // preference — that is `/voice`, a slash command, so a message-sending path
    // is never also a settings write.
    const mode = opts.output ?? await store.getVoiceReply(db, opts.workspaceId);

    // Text first when the mode sends it at all. Voice-only is the one mode that
    // withholds it, and it is opt-in twice over precisely because a voice note
    // can't be skimmed, searched or quoted.
    if (sendsText(mode)) {
      for (const c of splitMessage(String(text ?? ''))) await client.sendMessage(acc.dmChatId, c);
    }

    if (speaks(mode)) {
      const spoke = await speakInto(db, key, client, acc.dmChatId, text, opts.workDir ?? null);
      // Voice-only withheld the text, so a synthesis failure would deliver
      // NOTHING. Fall back to sending it rather than losing the message — the
      // mode is a preference, and an undelivered answer is not a way to honour it.
      if (!spoke && !sendsText(mode)) {
        for (const c of splitMessage(String(text ?? ''))) await client.sendMessage(acc.dmChatId, c);
      }
    }

    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: 'Could not send the message: ' + (e?.message || e) };
  }
}

/**
 * Speak `text` and send it as a voice bubble. Returns whether a voice note
 * actually went out, which the voice-ONLY path needs: it withheld the text, so a
 * silent failure there would deliver nothing at all.
 */
export async function speakInto(
  db: ReturnType<typeof getDb>,
  key: Buffer,
  client: TelegramClient,
  chatId: number,
  text: string,
  workDir: string | null,
): Promise<boolean> {
  let file: string | null = null;
  try {
    const settings = await store.readSettings(db, key);
    const config = voiceConfigOf(settings);
    // Write beside the run rather than into the checkout: the audio is a delivery
    // artifact, not the user's content, and everything in a checkout is committed.
    const dir = workDir ? path.join(workDir, '..') : '/tmp';
    file = await speakToFile(
      text,
      config,
      path.join(dir, `reply-${Date.now()}.ogg`),
      (message) => tlog.warn({ err: message }, 'speaking the reply failed'),
    );
    if (!file) return false;
    await client.sendFile('voice', chatId, file);
    return true;
  } catch (e: any) {
    tlog.warn({ err: e?.message ?? String(e) }, 'sending the voice reply failed');
    return false;
  } finally {
    if (file) await fs.rm(file, { force: true }).catch(() => { /* best-effort */ });
  }
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
