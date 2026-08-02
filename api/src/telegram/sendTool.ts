// Sending a Telegram DM to the user, server-side. The bot token lives only here
// (encrypted, owner `telegram`), so this is the ONE place a message is actually
// sent — the agent tool wraps it (agent-core/sendMessage.ts) and the desktop
// reaches it over HTTP (`POST /telegram/send`). Reads the account at call time,
// so it works whenever Telegram is connected and explains itself when it isn't.

import { TelegramClient, splitMessage, type SendKind } from './client.js';
import * as store from '../store.js';
import type { PgPool } from '../db.js';
import { getDb } from '../db.js';

export type SendResult = { ok: true } | { ok: false; error: string };

export async function sendTelegramMessage(pool: PgPool, key: Buffer, text: string): Promise<SendResult> {
  try {
    const db = getDb(pool);
    const acc = await store.getTelegramAccount(db);
    if (!acc || !acc.enabled || acc.dmChatId == null) {
      return { ok: false, error: 'No Telegram account is connected, so the message was not sent.' };
    }
    const token = await store.getTelegramSecret(db, key, 'botToken');
    if (!token) return { ok: false, error: 'Telegram bot token is missing.' };
    const client = new TelegramClient(token);
    for (const c of splitMessage(String(text ?? ''))) await client.sendMessage(acc.dmChatId, c);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: 'Could not send the message: ' + (e?.message || e) };
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
