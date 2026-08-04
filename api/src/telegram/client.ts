// Minimal Telegram Bot API client — raw HTTPS over fetch, no library (matches
// knack). One 429 retry honoring retry_after. Plus splitMessage for the 4096
// limit, which carries open code fences across chunks.

import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Telegram's ceiling for anything a bot uploads. Checked before we read a file,
 * so an oversize send is reported as itself rather than surfacing as a generic
 * API failure the user can't interpret.
 */
export const MAX_OUTBOUND_BYTES = 50 * 1024 * 1024;

/** Which Telegram method a file should go out through. */
export type SendKind = 'photo' | 'video' | 'voice' | 'audio' | 'document';

const KIND_METHOD: Record<SendKind, { method: string; field: string }> = {
  photo: { method: 'sendPhoto', field: 'photo' },
  video: { method: 'sendVideo', field: 'video' },
  voice: { method: 'sendVoice', field: 'voice' },
  audio: { method: 'sendAudio', field: 'audio' },
  document: { method: 'sendDocument', field: 'document' },
};

/**
 * Telegram's response envelope. Every Bot API method answers in this shape —
 * `ok` plus either `result` or `description`, and `parameters.retry_after` on a
 * 429. `res.json()` is typed `unknown`, so this is what the three call sites
 * assert it to rather than each reaching into an untyped value.
 */
// What the webhook subscribes to. Telegram sends ONLY the listed kinds and keeps
// the list until the next setWebhook — so adding a kind here does nothing for an
// already-connected bot until it re-registers (syncWebhookConfig at boot handles
// that). `message_reaction` is what makes the 🤬-to-audio reply possible.
export const ALLOWED_UPDATES = ['message', 'message_reaction'];

type TgResponse = {
  ok?: boolean;
  result?: any;
  description?: string;
  parameters?: { retry_after?: number };
};

/** `res.json()` with the envelope applied, falling back to `{}` on a non-JSON body. */
async function readEnvelope(res: Response): Promise<TgResponse> {
  return (await res.json().catch(() => ({}))) as TgResponse;
}

export class TelegramClient {
  /**
   * `onSent` is called for every text bubble this client writes — sent or edited
   * — with the message number and what it now says. That is what makes ANY of the
   * bot's messages readable back as a voice note later (`speakReactedMessage`):
   * the record exists because the message went out, not because the code that
   * sent it remembered to save it. Commands, acks, errors and the agent's reply
   * all pass through here, so there is one rule and nothing to add for a new kind
   * of message.
   *
   * Injected rather than imported so this file keeps no database access, the same
   * seam `stream.ts` uses for `speak`. The callback carries which of OUR chats the
   * bubble belongs to, which this class has no way to know.
   *
   * NOT fired for `sendFile`: a voice bubble's text is the script that was spoken,
   * which lives with the caller (`speakInto` records it itself).
   *
   * `onDeleted` is the same rule pointed the other way: a record exists because a
   * message went out, so it goes away because the message did. Without it every
   * deleted waiting bubble leaves a row saying "..." — unreachable rather than
   * harmful, since the message it describes no longer exists to point at, but
   * there is no reason to keep it and no caller should have to remember.
   */
  constructor(
    private token: string,
    private onSent?: (messageId: number, text: string) => void,
    private onDeleted?: (messageId: number) => void,
  ) {}

  async call(method: string, body: Record<string, any> = {}): Promise<any> {
    const url = `https://api.telegram.org/bot${this.token}/${method}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await readEnvelope(res);
      if (res.ok && json.ok) return json.result;
      if (res.status === 429 && attempt === 0) {
        const wait = ((json.parameters?.retry_after ?? 1) * 1000) + 200;
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      throw new Error(`telegram ${method} failed: ${json.description || res.status}`);
    }
  }

  getMe() { return this.call('getMe'); }
  // With a self-signed cert, Telegram needs its public PEM uploaded (multipart);
  // with a real/ngrok cert, plain JSON. `certificatePem` selects the path.
  //
  // `dropPending: false` is the boot re-register path (syncWebhookConfig): its
  // whole point is picking up a new allowed_updates list, and dropping the queue
  // there would lose messages sent while the server was down.
  async setWebhook(url: string, secretToken: string, certificatePem?: string, opts: { dropPending?: boolean } = {}) {
    const drop = opts.dropPending !== false;
    if (!certificatePem) {
      return this.call('setWebhook', { url, secret_token: secretToken, allowed_updates: ALLOWED_UPDATES, drop_pending_updates: drop });
    }
    const form = new FormData();
    form.set('url', url);
    form.set('secret_token', secretToken);
    form.set('allowed_updates', JSON.stringify(ALLOWED_UPDATES));
    form.set('drop_pending_updates', String(drop));
    form.set('certificate', new Blob([certificatePem], { type: 'application/x-pem-file' }), 'cert.pem');
    const res = await fetch(`https://api.telegram.org/bot${this.token}/setWebhook`, { method: 'POST', body: form });
    const json = await readEnvelope(res);
    if (!(res.ok && json.ok)) throw new Error(`telegram setWebhook failed: ${json.description || res.status}`);
    return json.result;
  }
  deleteWebhook() { return this.call('deleteWebhook', { drop_pending_updates: true }); }
  // What Telegram currently has registered — url and allowed_updates included.
  // How boot tells whether the subscription list is stale without re-registering
  // (and re-uploading a certificate) on every start.
  getWebhookInfo() { return this.call('getWebhookInfo'); }
  async sendMessage(chatId: number, text: string, opts: { replyToMessageId?: number } = {}) {
    const m = await this.call('sendMessage', {
      chat_id: chatId, text,
      ...(opts.replyToMessageId ? { reply_parameters: { message_id: opts.replyToMessageId, allow_sending_without_reply: true } } : {}),
    });
    if (m?.message_id != null) this.onSent?.(m.message_id, text);
    return m;
  }
  // An edit records too, so the streamed bubble ends up stored as what it finally
  // says rather than as the "…" it started out as. An unchanged body throws
  // ("message is not modified") and never reaches this line — which is right,
  // since the text already on record is the text on screen.
  async editMessageText(chatId: number, messageId: number, text: string) {
    const r = await this.call('editMessageText', { chat_id: chatId, message_id: messageId, text });
    this.onSent?.(messageId, text);
    return r;
  }
  async deleteMessage(chatId: number, messageId: number) {
    const r = await this.call('deleteMessage', { chat_id: chatId, message_id: messageId });
    this.onDeleted?.(messageId);
    return r;
  }
  sendChatAction(chatId: number, action = 'typing') { return this.call('sendChatAction', { chat_id: chatId, action }); }

  /**
   * Set (or clear) the bot's reaction on a message. Bots get ONE reaction per
   * message and a new one replaces the old, which is what makes a progress
   * signal possible: ✍ while we work, 👍 when it lands. Pass no emoji to clear.
   *
   * The emoji must be one of Telegram's fixed reaction set, spelled EXACTLY as
   * Telegram spells it — see the note on the constants in `webhook.ts`.
   */
  setMessageReaction(chatId: number, messageId: number, emoji?: string) {
    return this.call('setMessageReaction', {
      chat_id: chatId, message_id: messageId,
      reaction: emoji ? [{ type: 'emoji', emoji }] : [],
    });
  }
  setMyCommands(commands: Array<{ command: string; description: string }>) { return this.call('setMyCommands', { commands }); }

  // Fetch an inbound file (voice note, document, photo). Telegram's getFile caps
  // at 20 MB — callers check the declared size first so an oversize file is
  // declined with a clear message instead of failing mid-download.
  async downloadFile(fileId: string): Promise<Buffer> {
    const file = await this.call('getFile', { file_id: fileId });
    if (!file?.file_path) throw new Error('Telegram did not return a file path.');
    const res = await fetch(`https://api.telegram.org/file/bot${this.token}/${file.file_path}`);
    if (!res.ok) throw new Error(`downloading the file failed (HTTP ${res.status}).`);
    return Buffer.from(await res.arrayBuffer());
  }

  // Upload a local file. Multipart rather than the JSON `call()` above, because
  // that is the only way to hand Telegram bytes it doesn't already host.
  private async upload(kind: SendKind, chatId: number, filePath: string, caption?: string, opts: { replyToMessageId?: number } = {}): Promise<any> {
    const { method, field } = KIND_METHOD[kind];
    const stat = await fs.stat(filePath);
    if (stat.size > MAX_OUTBOUND_BYTES) {
      throw new Error(`the file is ${Math.round(stat.size / 1024 / 1024)} MB, over Telegram's 50 MB limit for bots.`);
    }
    const name = path.basename(filePath);
    const form = new FormData();
    form.set('chat_id', String(chatId));
    form.set(field, new Blob([await fs.readFile(filePath)]), name);
    // Telegram truncates captions at 1024; sending a longer one is an API error,
    // and the reply text has already been delivered separately anyway.
    if (caption) form.set('caption', caption.slice(0, 1024));
    if (kind === 'document') form.set('filename', name);
    if (opts.replyToMessageId) form.set('reply_parameters', JSON.stringify({ message_id: opts.replyToMessageId, allow_sending_without_reply: true }));

    const res = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, { method: 'POST', body: form });
    const json = await readEnvelope(res);
    if (!(res.ok && json.ok)) throw new Error(`telegram ${method} failed: ${json.description || res.status}`);
    return json.result;
  }

  /**
   * Send a file the way its type deserves.
   *
   * Photos fall back to a plain document send: Telegram rejects images outside its
   * dimension limits (tall screenshots, extreme aspect ratios) even though the file
   * is perfectly valid, and arriving as a file beats not arriving.
   */
  async sendFile(kind: SendKind, chatId: number, filePath: string, caption?: string, opts: { replyToMessageId?: number } = {}): Promise<any> {
    if (kind !== 'photo') return this.upload(kind, chatId, filePath, caption, opts);
    try {
      return await this.upload('photo', chatId, filePath, caption, opts);
    } catch {
      return this.upload('document', chatId, filePath, caption, opts);
    }
  }
}

const LIMIT = 4096; // Telegram's per-message ceiling (UTF-16 units == JS .length)

// Chunk a long message under the limit. Splits on paragraph > line > space (never
// mid-word), carries an open ``` code fence across the boundary (closing it at
// the end of a chunk and reopening with the language on the next), and appends
// (i/n) when there's more than one chunk.
export function splitMessage(text: string, limit = LIMIT): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let rest = text;
  let openFence: string | null = null; // e.g. "```ts" if a fence is open at the boundary

  while (rest.length > 0) {
    const prefix = openFence ? openFence + '\n' : '';
    const budget = limit - prefix.length - 12; // reserve room for a closing fence + " (i/n)"
    if (prefix.length + rest.length <= limit) { chunks.push(prefix + rest); break; }

    let cut = rest.lastIndexOf('\n\n', budget);
    if (cut < budget * 0.5) cut = rest.lastIndexOf('\n', budget);
    if (cut < budget * 0.5) cut = rest.lastIndexOf(' ', budget);
    if (cut <= 0) cut = budget;

    let piece = prefix + rest.slice(0, cut);
    rest = rest.slice(cut).replace(/^\n+/, '');

    // Track fence state across the boundary.
    const fences = (piece.match(/```[^\n`]*/g) || []);
    const stateOpen = fences.length % 2 === 1;
    if (stateOpen) {
      const last = fences[fences.length - 1];
      openFence = last.startsWith('```') && last.length > 3 ? '```' : '```';
      openFence = last; // reopen with the same language tag
      piece += '\n```';
    } else {
      openFence = null;
    }
    chunks.push(piece);
  }

  const n = chunks.length;
  return n > 1 ? chunks.map((c, i) => `${c}\n\n(${i + 1}/${n})`) : chunks;
}
