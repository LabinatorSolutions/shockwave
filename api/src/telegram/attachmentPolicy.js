// What an inbound attachment IS, and what we tell the agent about it. Pure —
// no filesystem, no db, no Telegram — so it can be unit-tested directly, same
// arrangement as `gitRemote.js` beside `git.ts` and `keys.js` beside `store.ts`.
// `attachments.ts` adds the two lines that touch disk.
//
// The note wording is the load-bearing part and is copied from hermes-agent
// (`gateway/run.py:1875`). An earlier version there told the agent to "ask the
// user what they'd like you to do with it", and it did exactly that — you sent a
// PDF and got back a question you had already answered. Telling it to act, and to
// ask only when the intent is genuinely unclear, is what makes a bare path
// pointer work at all.

import path from 'node:path';

/** Telegram's getFile ceiling for bots. Not our choice, and not raisable. */
export const MAX_INBOUND_BYTES = 20 * 1024 * 1024;

/** Inline a text file's contents rather than pointing at it, up to this size. */
export const MAX_TEXT_INLINE_BYTES = 100 * 1024;

// Extensions whose contents are safe to paste into the prompt. This is an
// EXTENSION gate, never "did the bytes happen to decode as UTF-8" — PDF, zip and
// docx all begin with decodable ASCII headers and would be pasted in as garbage.
// Anything not listed is still saved and still described; this only chooses
// inline-vs-pointer.
export const TEXT_INLINE_EXTS = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.log',
  '.json', '.jsonl', '.ndjson', '.xml', '.yaml', '.yml', '.toml',
  '.ini', '.cfg', '.conf', '.env', '.properties',
  '.html', '.htm', '.css', '.scss', '.sass', '.less',
  '.py', '.pyi', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat',
  '.c', '.h', '.cpp', '.cc', '.hpp', '.cs', '.java', '.kt',
  '.go', '.rs', '.rb', '.php', '.pl', '.lua', '.r', '.jl',
  '.swift', '.m', '.scala', '.clj', '.ex', '.exs', '.erl',
  '.sql', '.graphql', '.proto', '.tf', '.hcl',
  '.dockerfile', '.makefile', '.cmake', '.gradle',
  '.rst', '.tex', '.srt', '.vtt', '.diff', '.patch',
]);

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
 * file type is accepted — the gate that matters is who is allowed to message the
 * bot, not what they chose to send, and silently dropping an upload because of
 * its extension is worse than handing the agent something it must inspect.
 */
export function describeAttachment(data, { filename = '', mimeType = '', defaultKind, unique = '' } = {}) {
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

  const out = { kind, mimeType: resolvedMime, fileName, displayName };

  if ((TEXT_INLINE_EXTS.has(ext) || resolvedMime.startsWith('text/')) && data.length <= MAX_TEXT_INLINE_BYTES) {
    try { out.inlineText = new TextDecoder('utf-8', { fatal: true }).decode(data); } catch { /* not text after all */ }
  }
  return out;
}

// ── The notes prepended to the user's message ────────────────────────────────

export function documentNote(a) {
  if (a.inlineText !== undefined) {
    return `[The user sent a text document: '${a.displayName}'. Its content has been included below. `
      + `The file is also saved at: ${a.path}]`;
  }
  return `[The user sent a document: '${a.displayName}'. It is saved at: ${a.path}. `
    + `Its text is not inlined here (it's a binary format such as PDF or DOCX). `
    + `To read it, extract the document's text yourself — for example with the terminal tool — `
    + `before answering, instead of asking the user to paste the contents.]`;
}

export function audioFileNote(a) {
  return `[The user sent an audio file attachment: '${a.displayName}'. It is saved at: ${a.path}. `
    + `Its content is not inlined here. If the user's request involves what the audio contains, `
    + `transcribe or process it yourself — for example by passing the path to a transcription or `
    + `media tool — instead of asking the user to describe it. Only ask what to do with it if their `
    + `intent is genuinely unclear.]`;
}

export function videoNote(a) {
  return `[The user sent a video attachment: '${a.displayName}'. It is saved at: ${a.path}. `
    + `Its content is not inlined here. If the user's request involves what the video contains, `
    + `inspect or process it yourself — for example by passing the path to a video analysis or `
    + `media tool — instead of asking the user to describe it. Only ask what to do with it if their `
    + `intent is genuinely unclear.]`;
}

/**
 * The image note.
 *
 * `visible` says whether the pixels were also attached for the model to see. When
 * they were, the path is still given — the agent needs a string handle to move,
 * copy or commit the file without another round trip. When they weren't, saying
 * so stops it claiming to have looked at something it cannot see.
 */
export function imageNote(a, visible) {
  return visible
    ? `[Image attached at: ${a.path}]`
    : `[The user sent an image: '${a.displayName}'. It is saved at: ${a.path}. `
      + `This model cannot view images, so describe what you can do with the file rather than its contents.]`;
}

/** Notes, then any inlined file contents, then what the user actually typed. */
export function composeMessage(attachments, userText, visionAvailable) {
  const notes = [];
  const inlined = [];

  for (const a of attachments || []) {
    if (a.kind === 'image') notes.push(imageNote(a, visionAvailable));
    else if (a.kind === 'video') notes.push(videoNote(a));
    else if (a.kind === 'audio') notes.push(audioFileNote(a));
    else notes.push(documentNote(a));
    if (a.inlineText !== undefined) inlined.push(`[Content of ${a.displayName}]:\n${a.inlineText}`);
  }

  return [...notes, ...inlined, userText].filter((s) => s && s.trim()).join('\n\n');
}
