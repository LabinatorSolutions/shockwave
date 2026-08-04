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
import { startWaitingBubble } from './waitingBubble.js';
import {
  extractMedia, extractLocalFiles, filterDeliveryPaths, deliveryKind,
} from '../../../agent-core/mediaTags.ts';

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
/** `flushInner`'s fallback when the text so far cleans down to nothing (a segment
 *  that is only a file tag). A bubble holding this has still had nothing real
 *  written into it, which `unwritten` below is what tracks. */
const PLACEHOLDER = '…';

/**
 * `speak` is injected rather than imported so this file stays a RENDERER of
 * events — it has no store, no settings and no idea what a vendor is. Absent
 * means the workspace is on text replies, which is the default and the common
 * case, so nothing here has to read a setting to find out.
 *
 * `textToo` is separate from `speak` because the three modes are not a scale:
 * text, voice, and both.
 *
 * **Voice-only never renders the answer at all.** Progress still shows — the
 * placeholder bubble and a line per tool call — so the chat is not empty while
 * the turn runs, and `onSpeakStart` switches the indicator to "recording" once
 * there are words to say. What it does NOT do is type the reply out and then
 * delete it, which is what this did first: you watched the whole answer appear
 * and vanish. Progress is the placeholder and the tool lines; the answer is the
 * voice note.
 */
export function makeTelegramSink(
  client: TelegramClient,
  chatId: number,
  deliverRoots: string[] = [],
  opts: {
    speak?: (text: string) => Promise<boolean>; textToo?: boolean; onSpeakStart?: () => void;
  } = {},
) {
  let text = '';            // current assistant text segment
  // Everything the agent has said THIS turn, across tool boundaries. `text` is
  // reset at each tool call, and agent_end carries pi's whole session — neither
  // answers "what did it say just now", which is what file delivery must scan.
  // Scanning the session instead would re-send a file every turn after the first.
  let turnText = '';
  let messageId: number | null = null; // Telegram message being edited for this segment
  let dirty = false;
  let lastEdit = 0;
  // True while the message we hold has had nothing real written into it — either
  // the waiting bubble just handed over, or a body that cleaned down to
  // `PLACEHOLDER`. That message is a SLOT: a tool line takes it over rather than
  // posting below it. A rate-limited edit leaves it a slot too, which is why this
  // clears only once a write has LANDED.
  let unwritten = false;
  // Whether the bubble has been asked for yet. Separate from `messageId` because
  // a failed post yields no id, and asking twice would then return null and wipe
  // an id we already hold.
  let tookBubble = false;

  // Every flush is chained, and `done()` awaits the chain. Without that, the
  // first post ("H") could still be in flight when the turn ended: `done` saw
  // `messageId == null`, decided there was nothing to edit, and sent the final
  // text as a SECOND message — then the first post landed. Two messages.
  let chain: Promise<void> = Promise.resolve();

  // No typing indicator here — `runTurn` owns it for the whole turn, starting
  // the moment the message is acknowledged. This sink is built after the
  // checkout, so a typing indicator that began here left the user watching an
  // empty chat through the slowest part of the turn.

  // The waiting bubble goes up BEFORE the agent has produced anything, so the
  // reply has a visible home from the start and the wait for the first token
  // happens inside a message rather than in an empty chat. Whichever of text or
  // a tool line renders first takes that same message over, so this costs
  // exactly one API call per turn.
  const bubble = startWaitingBubble(client, chatId);

  const editTimer = setInterval(() => { void flush(false); }, 1300);

  /**
   * Take the waiting bubble over, once. Called from inside the chain, so by the
   * time anything writes, the animation has stopped and the bubble will never
   * touch the message again — one writer at a time is what keeps a dot from
   * landing on top of the first words of a reply.
   */
  async function takeSlot() {
    if (tookBubble) return;
    tookBubble = true;
    messageId = await bubble.claim();
    unwritten = messageId != null;
  }

  function flush(force: boolean): Promise<void> {
    chain = chain.then(() => flushInner(force)).catch(() => { /* best-effort */ });
    return chain;
  }

  async function flushInner(force: boolean) {
    // Voice-only says nothing in writing. The placeholder and the tool lines still
    // render, so the turn is visibly working — but the ANSWER is the voice note,
    // and typing it out here only to delete it at the end is what made this
    // awkward the first time round.
    if (opts.textToo === false) { dirty = false; return; }
    if (!dirty) return;
    if (!force && Date.now() - lastEdit < 1300) return;
    dirty = false; lastEdit = Date.now();
    await takeSlot();
    // Strip file tags as we go. The text is edited into a live message every
    // ~1.3s, so without this the user watches `MEDIA:/data/...` get typed out and
    // then vanish. Only the tag form is removed here — it's synchronous, whereas
    // confirming a bare path is a file needs disk, and a bare path reads as
    // ordinary prose until it's delivered anyway.
    const shown = extractMedia(text).cleaned;
    const body = (shown.length > 4096 ? shown.slice(0, 4096) : shown) || PLACEHOLDER;
    try {
      if (messageId == null) { const m = await client.sendMessage(chatId, body); messageId = m?.message_id ?? null; }
      else await client.editMessageText(chatId, messageId, body);
      // Only once a write has actually LANDED does the message stop being a free
      // slot. Inside the try on purpose: a rate-limited edit leaves it claimable.
      // The `PLACEHOLDER` body is the one case where a landed write still leaves
      // it holding nothing, so it stays a slot.
      unwritten = body === PLACEHOLDER;
    } catch { /* rate limit / transient — the final flush will correct it */ }
  }

  // On the same chain as flush, so the tool marker can't overtake the text
  // segment it is supposed to follow.
  function toolLine(name: string) {
    void flush(true);         // close the current text segment first (ordering)
    chain = chain.then(async () => {
      // Reset BEFORE any await, not after: `emit` appends to `text` outside this
      // chain, so a delta arriving mid-send would be wiped by a later reset.
      text = '';
      // The waiting bubble belongs to whatever renders first, and on most turns
      // that is a tool call — the agent reads or greps before it says anything.
      // Take it over instead of posting below it, or every tool-first turn leaves
      // a bare "..." stranded above the tool line, never updated again.
      await takeSlot();
      const slot = unwritten ? messageId : null;
      messageId = null; unwritten = false;
      const line = `${TOOL_EMOJI[name] || '🔧'} ${name}`;
      try {
        if (slot != null) await client.editMessageText(chatId, slot, line);
        else await client.sendMessage(chatId, line);
      } catch { /* best-effort */ }
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

  /**
   * Take back the waiting bubble when nothing was ever written into it. Two
   * cases, because ownership may or may not have moved yet: the bubble still
   * holds the message and deletes it itself, or we took the slot and never wrote
   * anything real into it. No-op once anything has landed there.
   */
  async function dropPlaceholder() {
    if (!tookBubble) { await bubble.remove(); return; }
    if (!unwritten || messageId == null) return;
    const id = messageId;
    messageId = null; unwritten = false;
    await client.deleteMessage(chatId, id).catch(() => { /* best-effort */ });
  }

  /**
   * Tear the sink down for a turn that THREW. `done()` is never reached on that
   * path, which left two things behind: the placeholder bubble sitting above
   * runTurn's error reply, and — already true before the placeholder existed —
   * the edit timer running for the life of the process, one leaked interval per
   * failed turn.
   */
  async function dispose() {
    clearInterval(editTimer);
    bubble.stop();
    await chain.catch(() => { /* best-effort */ });
    await dropPlaceholder();
  }

  async function done(finalMessages?: any[]) {
    clearInterval(editTimer);
    bubble.stop();
    await chain;   // let any in-flight post land so `messageId` is truthful
    // A turn that never rendered anything — no tool call, no streamed token —
    // still has the waiting bubble up. Take it, so the final message edits into
    // it rather than posting below a stray "...".
    await takeSlot();
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
      const voiceOnly = opts.textToo === false;

      // Say it out loud first when that is the whole delivery, so the wait is
      // spent recording rather than after a wall of text. `speak` reports its own
      // failures and never throws, so a false here means no voice note went out.
      //
      // It runs on the CLEANED text, after file tags have been cut, so the reply
      // is never read aloud with a file path in the middle of it.
      let spoke = false;
      if (opts.speak) {
        opts.onSpeakStart?.();
        spoke = await opts.speak(final);
      }

      // Write the answer unless the mode said not to — and write it ANYWAY when
      // the voice note failed, because a mode preference is not worth delivering
      // nothing over. That fallback is the only reason voice-only can be silent
      // about the text at all.
      if (!voiceOnly || !spoke) {
        try {
          const chunks = splitMessage(final);
          if (messageId != null) await client.editMessageText(chatId, messageId, chunks[0]);
          else { const m = await client.sendMessage(chatId, chunks[0]); messageId = m?.message_id ?? null; }
          for (const c of chunks.slice(1)) await client.sendMessage(chatId, c);
        } catch { /* best-effort */ }
      } else {
        // Nothing was ever written into it, so the bubble is still the "…" slot.
        await dropPlaceholder();
      }
    } else {
      // The turn said nothing and nothing ever claimed the bubble. Take it back —
      // a bare "…" left as the entire reply reads as the bot having given up
      // mid-sentence. Any files below still speak for themselves.
      await dropPlaceholder();
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

  return { emit, done, dispose };
}
