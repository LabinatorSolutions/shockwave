// Minimal Telegram Bot API client — raw HTTPS over fetch, no library (matches
// knack). One 429 retry honoring retry_after. Plus splitMessage for the 4096
// limit, which carries open code fences across chunks.

export class TelegramClient {
  constructor(private token: string) {}

  async call(method: string, body: Record<string, any> = {}): Promise<any> {
    const url = `https://api.telegram.org/bot${this.token}/${method}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
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
  async setWebhook(url: string, secretToken: string, certificatePem?: string) {
    if (!certificatePem) {
      return this.call('setWebhook', { url, secret_token: secretToken, allowed_updates: ['message'], drop_pending_updates: true });
    }
    const form = new FormData();
    form.set('url', url);
    form.set('secret_token', secretToken);
    form.set('allowed_updates', JSON.stringify(['message']));
    form.set('drop_pending_updates', 'true');
    form.set('certificate', new Blob([certificatePem], { type: 'application/x-pem-file' }), 'cert.pem');
    const res = await fetch(`https://api.telegram.org/bot${this.token}/setWebhook`, { method: 'POST', body: form });
    const json = await res.json().catch(() => ({}));
    if (!(res.ok && json.ok)) throw new Error(`telegram setWebhook failed: ${json.description || res.status}`);
    return json.result;
  }
  deleteWebhook() { return this.call('deleteWebhook', { drop_pending_updates: true }); }
  sendMessage(chatId: number, text: string, opts: { replyToMessageId?: number } = {}) {
    return this.call('sendMessage', {
      chat_id: chatId, text,
      ...(opts.replyToMessageId ? { reply_parameters: { message_id: opts.replyToMessageId, allow_sending_without_reply: true } } : {}),
    });
  }
  editMessageText(chatId: number, messageId: number, text: string) { return this.call('editMessageText', { chat_id: chatId, message_id: messageId, text }); }
  sendChatAction(chatId: number, action = 'typing') { return this.call('sendChatAction', { chat_id: chatId, action }); }
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
