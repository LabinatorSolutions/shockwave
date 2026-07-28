// The send_message tool — lets a server-side agent run (cron or Telegram)
// proactively message the user on Telegram (e.g. "the nightly job finished").
// Reads the account at call time so it works whenever Telegram is connected;
// returns a clear error when it isn't. Added to the companion host's tools.

import { TelegramClient, splitMessage } from './client.js';
import * as store from '../store.js';
import type { DB } from '../db.js';
import { getDb } from '../db.js';

export function makeSendMessageTool(pool: DB, key: Buffer): any {
  const db = getDb(pool);
  return {
    name: 'send_message',
    label: 'Send Message',
    description: 'Send a message to the user on Telegram. Use this to reach the user proactively — e.g. when a scheduled job finishes or something needs their attention. They receive it as a Telegram DM.',
    promptSnippet: 'Message the user on Telegram (a result or an alert).',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: 'The message to send.' } },
      required: ['text'],
      additionalProperties: false,
    },
    async execute(_id: string, params: any) {
      try {
        const acc = await store.getTelegramAccount(db);
        if (!acc || !acc.enabled || acc.dmChatId == null) {
          return { content: [{ type: 'text', text: 'No Telegram account is connected, so the message was not sent.' }], isError: true };
        }
        const token = await store.getTelegramSecret(db, key, 'botToken');
        if (!token) return { content: [{ type: 'text', text: 'Telegram bot token is missing.' }], isError: true };
        const client = new TelegramClient(token);
        for (const c of splitMessage(String(params?.text ?? ''))) await client.sendMessage(acc.dmChatId, c);
        return { content: [{ type: 'text', text: 'Message sent to the user on Telegram.' }] };
      } catch (e: any) {
        return { content: [{ type: 'text', text: 'Could not send the message: ' + (e?.message || e) }], isError: true };
      }
    },
  };
}
