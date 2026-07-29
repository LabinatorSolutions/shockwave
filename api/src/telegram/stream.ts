// Renders the agent's event stream to Telegram: a typing indicator during the
// run, a one-line marker per tool call, the assistant's text edited in place as
// it streams (~1.3s cadence, Telegram's ~1 edit/sec ceiling), and an
// authoritative final message from agent_end (chunked for the 4096 limit). Plain
// text — no parse_mode — since agent output is arbitrary markdown.
//
// Returns an `emit` to pass as the agent's event sink and a `done()` to await
// after the turn (flushes the final + clears timers). Every Telegram call is
// best-effort: the DB transcript is the source of truth, so a dropped edit is fine.

import type { TelegramClient } from './client.js';
import { splitMessage } from './client.js';

const TOOL_EMOJI: Record<string, string> = {
  bash: '⚙️', read: '📖', write: '✍️', edit: '✏️', grep: '🔎', find: '🔎', ls: '📂',
  get_agent_secret: '🔑', list_agent_secrets: '🔑', send_message: '📨',
};

function textOf(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((c) => c?.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('');
  return '';
}

export function makeTelegramSink(client: TelegramClient, chatId: number) {
  let text = '';            // current assistant text segment
  let messageId: number | null = null; // Telegram message being edited for this segment
  let dirty = false;
  let lastEdit = 0;

  // Every flush is chained, and `done()` awaits the chain. Without that, the
  // first post ("H") could still be in flight when the turn ended: `done` saw
  // `messageId == null`, decided there was nothing to edit, and sent the final
  // text as a SECOND message — then the first post landed. Two messages.
  let chain: Promise<void> = Promise.resolve();

  const typing = setInterval(() => client.sendChatAction(chatId).catch(() => {}), 4000);
  client.sendChatAction(chatId).catch(() => {});
  const editTimer = setInterval(() => { void flush(false); }, 1300);

  function flush(force: boolean): Promise<void> {
    chain = chain.then(() => flushInner(force)).catch(() => { /* best-effort */ });
    return chain;
  }

  async function flushInner(force: boolean) {
    if (!dirty) return;
    if (!force && Date.now() - lastEdit < 1300) return;
    dirty = false; lastEdit = Date.now();
    const body = (text.length > 4096 ? text.slice(0, 4096) : text) || '…';
    try {
      if (messageId == null) { const m = await client.sendMessage(chatId, body); messageId = m?.message_id ?? null; }
      else await client.editMessageText(chatId, messageId, body);
    } catch { /* rate limit / transient — the final flush will correct it */ }
  }

  // On the same chain as flush, so the tool marker can't overtake the text
  // segment it is supposed to follow.
  function toolLine(name: string) {
    void flush(true);         // close the current text segment first (ordering)
    chain = chain.then(async () => {
      messageId = null; text = '';
      try { await client.sendMessage(chatId, `${TOOL_EMOJI[name] || '🔧'} ${name}`); } catch { /* best-effort */ }
    }).catch(() => { /* best-effort */ });
  }

  function emit(e: any) {
    const t = e?.type;
    if (t === 'message_update') {
      const am = e.assistantMessageEvent;
      if (am?.type === 'text_delta') { text += (am.delta ?? am.text ?? ''); dirty = true; }
      else if (am?.type === 'text_start') { /* new segment continues in `text` */ }
    } else if (t === 'tool_execution_start') {
      toolLine(e.toolName || e.name || 'tool');
    }
  }

  async function done(finalMessages?: any[]) {
    clearInterval(typing); clearInterval(editTimer);
    await chain;   // let any in-flight post land so `messageId` is truthful
    // Authoritative final: the last assistant message from agent_end (falls back
    // to whatever we accumulated from deltas).
    let final = text;
    if (Array.isArray(finalMessages)) {
      const lastAsst = [...finalMessages].reverse().find((m) => m?.role === 'assistant');
      const t = textOf(lastAsst?.content);
      if (t) final = t;
    }
    if (!final.trim()) return;
    const chunks = splitMessage(final);
    try {
      if (messageId != null) await client.editMessageText(chatId, messageId, chunks[0]);
      else await client.sendMessage(chatId, chunks[0]);
      for (const c of chunks.slice(1)) await client.sendMessage(chatId, c);
    } catch { /* best-effort */ }
  }

  return { emit, done };
}
