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
import {
  extractMedia, extractLocalFiles, filterDeliveryPaths, deliveryKind,
} from '../../../agent-core/mediaTags.js';

const TOOL_EMOJI: Record<string, string> = {
  bash: '⚙️', read: '📖', write: '✍️', edit: '✏️', grep: '🔎', find: '🔎', ls: '📂',
  get_agent_secret: '🔑', list_agent_secrets: '🔑', send_message: '📨',
};

function textOf(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((c) => c?.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('');
  return '';
}

/**
 * `deliverRoots` are the only folders a file may be sent from — the chat's
 * checkout and its attachment staging dir. Pass none and nothing is delivered,
 * which is what a caller with no notion of either should get.
 */
export function makeTelegramSink(client: TelegramClient, chatId: number, deliverRoots: string[] = []) {
  let text = '';            // current assistant text segment
  // Everything the agent has said THIS turn, across tool boundaries. `text` is
  // reset at each tool call, and agent_end carries pi's whole session — neither
  // answers "what did it say just now", which is what file delivery must scan.
  // Scanning the session instead would re-send a file every turn after the first.
  let turnText = '';
  let messageId: number | null = null; // Telegram message being edited for this segment
  let dirty = false;
  let lastEdit = 0;

  // Every flush is chained, and `done()` awaits the chain. Without that, the
  // first post ("H") could still be in flight when the turn ended: `done` saw
  // `messageId == null`, decided there was nothing to edit, and sent the final
  // text as a SECOND message — then the first post landed. Two messages.
  let chain: Promise<void> = Promise.resolve();

  // No typing indicator here — `runTurn` owns it for the whole turn, starting
  // the moment the message is acknowledged. This sink is built after the
  // checkout, so a typing indicator that began here left the user watching an
  // empty chat through the slowest part of the turn.
  const editTimer = setInterval(() => { void flush(false); }, 1300);

  function flush(force: boolean): Promise<void> {
    chain = chain.then(() => flushInner(force)).catch(() => { /* best-effort */ });
    return chain;
  }

  async function flushInner(force: boolean) {
    if (!dirty) return;
    if (!force && Date.now() - lastEdit < 1300) return;
    dirty = false; lastEdit = Date.now();
    // Strip file tags as we go. The text is edited into a live message every
    // ~1.3s, so without this the user watches `MEDIA:/data/...` get typed out and
    // then vanish. Only the tag form is removed here — it's synchronous, whereas
    // confirming a bare path is a file needs disk, and a bare path reads as
    // ordinary prose until it's delivered anyway.
    const shown = extractMedia(text).cleaned;
    const body = (shown.length > 4096 ? shown.slice(0, 4096) : shown) || '…';
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
      if (am?.type === 'text_delta') {
        const d = am.delta ?? am.text ?? '';
        text += d; turnText += d; dirty = true;
      }
      else if (am?.type === 'text_start') { /* new segment continues in `text` */ }
    } else if (t === 'tool_execution_start') {
      toolLine(e.toolName || e.name || 'tool');
    }
  }

  async function done(finalMessages?: any[]) {
    clearInterval(editTimer);
    await chain;   // let any in-flight post land so `messageId` is truthful
    // Authoritative final: the last assistant message from agent_end (falls back
    // to whatever we accumulated from deltas).
    let final = text;
    if (Array.isArray(finalMessages)) {
      const lastAsst = [...finalMessages].reverse().find((m) => m?.role === 'assistant');
      const t = textOf(lastAsst?.content);
      if (t) final = t;
    }
    // Find the files the agent asked to send, over everything it said this turn,
    // and take them out of the text so the user reads a sentence, not a path.
    //
    // The passes are CHAINED — `extractLocalFiles` scans what `extractMedia`
    // already cleaned. That is what stops a tagged path being delivered twice:
    // it is gone from the text before the bare-path pass ever sees it.
    // `turnText` is built from streamed deltas. A turn that produced text without
    // streaming any would leave it empty and silently deliver nothing, so fall
    // back to the authoritative final message.
    const tagged = extractMedia(turnText.trim() ? turnText : final);
    const bare = await extractLocalFiles(tagged.cleaned);
    const wanted = [...tagged.media, ...bare.paths.map((p) => ({ path: p, isVoice: false }))];
    const files = await filterDeliveryPaths(wanted, deliverRoots);

    // Same two passes over the visible text. Done separately because `final` is
    // the authoritative last message while `turnText` spans the whole turn.
    if (files.length) {
      final = (await extractLocalFiles(extractMedia(final).cleaned)).cleaned;
    }

    if (final.trim()) {
      const chunks = splitMessage(final);
      try {
        if (messageId != null) await client.editMessageText(chatId, messageId, chunks[0]);
        else await client.sendMessage(chatId, chunks[0]);
        for (const c of chunks.slice(1)) await client.sendMessage(chatId, c);
      } catch { /* best-effort */ }
    }

    // Files go after the text, so the message that explains them arrives first.
    // A failure here is reported rather than swallowed: "here's your report" with
    // no report and no reason is the worst outcome available.
    for (const f of files) {
      try {
        await client.sendFile(deliveryKind(f.path, { isVoice: f.isVoice, forceDocument: tagged.forceDocument }), chatId, f.path);
      } catch (e: any) {
        await client.sendMessage(chatId, `⚠️ I couldn't send that file — ${e?.message ?? e}`).catch(() => {});
      }
    }
  }

  return { emit, done };
}
