// What an inbound attachment IS, what to call it on disk, and the write itself.
//
// Bundled into BOTH builds, because both hosts take files from the user: the
// companion over Telegram, the desktop through the chat composer. It moved here
// from `api/src/telegram/` when the desktop grew the same feature — a second copy
// would have been two answers to "is this a PDF or a picture", and the answer
// decides what the agent is told it is holding.
//
// The wording of the notes lives next door in `attachmentNotes.ts`, which is
// strings only so the renderer can import it too; everything here needs `Buffer`
// and the filesystem and therefore runs in main / on the server.

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { MAX_TEXT_INLINE_BYTES, TEXT_INLINE_EXTS } from './attachmentNotes.ts';

export * from './attachmentNotes.ts';

/** Telegram's getFile ceiling for bots. Not our choice, and not raisable. */
export const MAX_INBOUND_BYTES = 20 * 1024 * 1024;

const IMAGE_EXT_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
};

const VIDEO_EXT_MIME = {
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
  '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
};

const AUDIO_EXTS = new Set(['.ogg', '.mp3', '.wav', '.m4a', '.opus', '.flac']);

const MIME_EXT = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif',
  'image/webp': '.webp', 'image/bmp': '.bmp',
};

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export type MediaKind = 'image' | 'video' | 'audio' | 'document';

/**
 * Does this look like an actual image?
 *
 * A URL fetch or a mislabelled upload can hand us an HTML error page with a .jpg
 * name. Sending that to a vision model fails the whole turn, so the magic bytes
 * are checked before anything is treated as an image.
 */
export function looksLikeImage(data) {
  return data.length >= 4 && sniffImageMime(data) !== null;
}

/**
 * The image's real format, from its bytes.
 *
 * Not from the filename, and not from what the sender claimed: a Telegram native
 * photo arrives with neither, and providers validate that the declared media type
 * matches the actual bytes and reject the entire request when it doesn't. So the
 * bytes decide, and a wrong `mime_type` on the message is overruled.
 */
export function sniffImageMime(data) {
  if (data.length < 4) return null;
  if (data.subarray(0, 8).equals(PNG_MAGIC)) return 'image/png';
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  const head6 = data.subarray(0, 6).toString('latin1');
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return 'image/gif';
  if (data.length >= 12 && data.subarray(0, 4).toString('latin1') === 'RIFF'
      && data.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (data[0] === 0x42 && data[1] === 0x4d) return 'image/bmp';
  return null;
}

/** Strip anything that could escape the staging dir or confuse a shell. */
export function safeName(filename) {
  let name = path.basename(String(filename ?? '')).replace(/\0/g, '').trim();
  if (!name || name === '.' || name === '..') name = 'file';
  return name.replace(/[^\w.\- ]/g, '_');
}

/** image | video | audio | document. `defaultKind` breaks ties for a nameless upload. */
export function classify(ext, mime, defaultKind) {
  const m = String(mime || '').toLowerCase();
  if (m.startsWith('image/') || ext in IMAGE_EXT_MIME || defaultKind === 'image') return 'image';
  if (m.startsWith('video/') || ext in VIDEO_EXT_MIME || defaultKind === 'video') return 'video';
  if (m.startsWith('audio/') || AUDIO_EXTS.has(ext) || defaultKind === 'audio') return 'audio';
  return 'document';
}

/**
 * Everything about an attachment except writing it: what it is, what to call it
 * on disk, and its contents if they are small enough to read inline.
 *
 * Returns null when bytes claiming to be an image clearly are not. Every other
 * file type is accepted — the gate that matters is who is allowed to send us a
 * file, not what they chose to send, and silently dropping an upload because of
 * its extension is worse than handing the agent something it must inspect.
 */
export function describeAttachment(
  data,
  { filename = '', mimeType = '', defaultKind = undefined as string | undefined, unique = '' } = {},
) {
  const ext = path.extname(filename).toLowerCase();
  const kind = classify(ext, mimeType, defaultKind);
  if (kind === 'image' && !looksLikeImage(data)) return null;

  // A Telegram photo has no name and no type, so its format comes from its bytes
  // and the extension follows from that rather than from a guess.
  const sniffed = kind === 'image' ? sniffImageMime(data) : null;
  const fallbackExt = ext
    || (sniffed && MIME_EXT[sniffed])
    || (kind === 'image' ? '.jpg' : kind === 'video' ? '.mp4' : kind === 'audio' ? '.ogg' : '.bin');

  const displayName = filename ? safeName(filename) : `${kind}${fallbackExt}`;
  // Keeps the user's own name visible on disk while guaranteeing no collision.
  const fileName = `${kind}_${unique}_${displayName}`;

  const resolvedMime = sniffed
    || mimeType
    || IMAGE_EXT_MIME[fallbackExt] || VIDEO_EXT_MIME[fallbackExt]
    || (kind === 'audio' ? `audio/${fallbackExt.slice(1)}` : 'application/octet-stream');

  const out: { kind: string; mimeType: any; fileName: string; displayName: string; inlineText?: string } =
    { kind, mimeType: resolvedMime, fileName, displayName };

  if ((TEXT_INLINE_EXTS.has(ext) || resolvedMime.startsWith('text/')) && data.length <= MAX_TEXT_INLINE_BYTES) {
    try { out.inlineText = new TextDecoder('utf-8', { fatal: true }).decode(data); } catch { /* not text after all */ }
  }
  return out;
}

export interface StoredAttachment {
  /** Absolute path in the chat's staging dir. */
  path: string;
  mimeType: string;
  kind: MediaKind;
  /** Human-readable name for the note — the original filename where we have one. */
  displayName: string;
  /** Contents, for small text files. The note says so when this is set. */
  inlineText?: string;
}

/**
 * Write one attachment into `dir` — the chat's staging dir, which BOTH hosts keep
 * outside the git checkout so nothing reaches the workspace until the agent is
 * asked to put it there. The caller owns the directory (the companion's
 * `chatFilesDir`, the desktop's `chatScratchDir`); this owns the write.
 *
 * Returns null when bytes claiming to be an image clearly aren't; see
 * `describeAttachment` for why every other type is accepted.
 */
export async function writeAttachment(
  dir: string,
  data: Buffer,
  opts: { filename?: string; mimeType?: string; defaultKind?: MediaKind } = {},
): Promise<StoredAttachment | null> {
  const described = describeAttachment(data, { ...opts, unique: crypto.randomBytes(6).toString('hex') });
  if (!described) return null;

  await fs.mkdir(dir, { recursive: true });
  const target = path.join(dir, described.fileName);

  // `safeName` already stripped path separators, so this can only trip if that
  // changes — which is exactly when you want to find out. It is the check that
  // keeps a crafted filename inside the staging dir.
  if (path.resolve(target) !== path.join(path.resolve(dir), path.basename(target))) {
    throw new Error('rejected attachment filename');
  }

  await fs.writeFile(target, data);

  return {
    path: target,
    mimeType: described.mimeType,
    kind: described.kind as MediaKind,
    displayName: described.displayName,
    ...(described.inlineText !== undefined ? { inlineText: described.inlineText } : {}),
  };
}
