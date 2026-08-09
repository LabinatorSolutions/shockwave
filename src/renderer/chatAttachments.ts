// Chat-sidebar attachment helpers. Browser-side only: reading the file the user
// picked, and turning what main saved into what pi is sent.
//
// **What a file IS is not decided here.** That is `agent-core/attachmentPolicy.ts`,
// running in main — it sniffs the bytes, names the file on disk, and decides
// whether the contents can be inlined. This module reads bytes and formats
// bubbles; the notes come from `agent-core/attachmentNotes.ts`, shared with the
// companion so a file attached here and a file sent over Telegram are described
// to the agent in the same words.
//
// Nothing is refused for its format any more. Every attachment is written into
// the chat's scratch pad and the agent is handed the path, so a `.tar.gz` is a
// file it can extract rather than an error message — which is what the system
// prompt has always promised ("files the user sends you arrive here").

export { composeMessage } from '../../agent-core/attachmentNotes.js';

/**
 * How much we're willing to pull into renderer memory.
 *
 * Above this a file travels to main as a PATH instead (`window.api.pathForFile`,
 * which Electron answers for anything dropped or picked from disk), so attaching
 * a 2GB archive costs nothing — main can read it, and the agent only ever needed
 * the path. Only a clipboard paste has no path to fall back on, which is why
 * that is the one case this can refuse.
 *
 * Images are read whatever their size: the pixels have to reach the model, and
 * every provider's own limit is far below this anyway.
 */
export const MAX_COMPOSER_READ_BYTES = 25 * 1024 * 1024;

export function isImageFile(file) {
  return typeof file?.type === 'string' && file.type.startsWith('image/');
}

export async function readAsBytes(file): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}

export function toBase64(bytes: Uint8Array) {
  // btoa wants a binary string. Chunk to avoid stack overflow on large images.
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

let idCounter = 0;
export const nextAttachmentId = () => `att${++idCounter}`;

/**
 * Map saved attachments to pi's `ImageContent` shape.
 *
 * Reads the mime type off the DESCRIPTOR main returned, not off the browser's
 * `file.type`: providers validate that the declared type matches the actual
 * bytes and reject the whole request when it doesn't, and the browser is
 * repeating whatever the OS guessed from the extension. Only the sniffed answer
 * is safe to declare.
 */
export function toImageContents(saved) {
  return saved.map((s) => ({ type: 'image', data: s.base64, mimeType: s.mimeType }));
}
