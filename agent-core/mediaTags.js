// Finding files the agent wants to send, in the text it wrote.
//
// The agent delivers a file by naming its path in its reply — either flagged
// (`MEDIA:/path/report.pdf`) or bare (`/path/report.pdf`). This module finds
// those paths, removes them from the text the user reads, and says how each one
// should be sent. It knows nothing about Telegram: the caller delivers.
//
// It lives in agent-core because both hosts need the same rules, and the folders
// a path must live under differ per host — the companion allows the chat's git
// checkout plus its attachment staging dir, the desktop only its workspace. So
// `validateDeliveryPath` takes the roots as an argument rather than knowing them.
//
// Plain `.js` so `node --test` loads it directly and both TypeScript builds
// import it without ceremony, same as `credentials.js` and `linkParser.js`.
//
// Ported from hermes-agent (`gateway/platforms/base.py`), including the parts
// that look like paranoia. Each one is load-bearing:
//   - Paths inside code fences, inline code, and blockquotes are ignored, or an
//     answer that *shows* you a path would send that file.
//   - Paths inside JSON string values are ignored, because stored tool results
//     embed an earlier reply verbatim and would re-send a file every turn after.
//   - The tag pattern is anchored to a known extension, so a bare `MEDIA:` in
//     prose matches nothing.
// Masking is offset-preserving (characters become spaces, newlines survive) so a
// match located in the masked copy can be cut from the real text by position.

import fs from 'node:fs/promises';
import path from 'node:path';

/** Extensions we will deliver. Anything else is not a file the user gets. */
export const MEDIA_DELIVERY_EXTS = [
  // Images (sent as photos)
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff', '.svg',
  // Video (plays inline)
  '.mp4', '.mov', '.avi', '.mkv', '.webm',
  // Audio (voice note or audio file)
  '.mp3', '.wav', '.ogg', '.opus', '.m4a', '.flac',
  // Documents
  '.pdf', '.docx', '.doc', '.odt', '.rtf', '.txt', '.md', '.epub',
  // Spreadsheets / data
  '.xlsx', '.xls', '.ods', '.csv', '.tsv', '.json', '.xml', '.yaml', '.yml',
  // Presentations
  '.pptx', '.ppt', '.odp', '.key',
  // Archives
  '.zip', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar', '.apk', '.ipa',
  // Rendered web output
  '.html', '.htm',
];

// Longest-first, so the alternation never matches a short extension where a
// longer one was meant.
const EXT_ALTERNATION = MEDIA_DELIVERY_EXTS
  .map((e) => e.slice(1))
  .sort((a, b) => b.length - a.length)
  .join('|');

// A flagged path: optionally quoted, `MEDIA:`, then either a quoted path or a
// bare one anchored to `/`, `~/`, or a Windows drive letter and ending in a
// known extension. The trailing lookahead keeps sentence punctuation out of the
// path. A `MEDIA:` whose path has an UNKNOWN extension deliberately fails here
// and is left in the text for the bare-path pass to consider.
const MEDIA_TAG_SRC =
  '[`"\']?MEDIA:\\s*' +
  '(?<path>`[^`\\n]+`|"[^"\\n]+"|\'[^\'\\n]+\'|' +
  `(?:~/|/|[A-Za-z]:[/\\\\])\\S+(?:[^\\S\\n]+\\S+)*?\\.(?:${EXT_ALTERNATION}))` +
  '(?=[\\s`"\',;:)\\]}]|$)[`"\']?';

// A bare path: absolute, `~/`, or a Windows drive letter, ending in a known
// extension. The lookbehind rejects URLs (`https://host/a.png`) and relative
// paths (`./a.png`).
const BARE_PATH_SRC =
  `(?<![/:\\w.])(?:~/|/|[A-Za-z]:[/\\\\])(?:[\\w.\\-]+[/\\\\])*[\\w.\\-]+\\.(?:${EXT_ALTERNATION})\\b`;

// Built fresh per use: a /g/ regex carries lastIndex, and a shared instance
// silently skips matches when two scans interleave.
const mediaTagRe = () => new RegExp(MEDIA_TAG_SRC, 'gi');
const barePathRe = () => new RegExp(BARE_PATH_SRC, 'gi');

/** Replace a span with spaces, keeping newlines and total length. */
function blank(chars, start, end) {
  for (let i = start; i < end; i++) if (chars[i] !== '\n') chars[i] = ' ';
}

/**
 * Blank out fenced code blocks, inline code, and blockquotes — places where a
 * path is being SHOWN rather than sent. A backtick span directly after `MEDIA:`
 * is skipped: that is a quoted path, not a code sample.
 */
export function maskProtectedSpans(content) {
  const chars = Array.from(content);
  const spans = [];

  for (const m of content.matchAll(/```[^\n]*\n[\s\S]*?```/g)) spans.push([m.index, m.index + m[0].length]);
  for (const m of content.matchAll(/`[^`\n]+`/g)) {
    // A backtick-quoted path inside a MEDIA: tag is not inline code.
    if (/MEDIA:\s*$/.test(content.slice(Math.max(0, m.index - 20), m.index))) continue;
    spans.push([m.index, m.index + m[0].length]);
  }
  for (const m of content.matchAll(/^>.*$/gm)) spans.push([m.index, m.index + m[0].length]);

  for (const [s, e] of spans) blank(chars, s, e);
  return chars.join('');
}

/**
 * Blank out a `MEDIA:` sitting inside a JSON string VALUE. Stored tool results
 * embed an earlier reply's text, so without this an old path is rediscovered and
 * the same file is re-sent on every later turn. Only a BARE path inside a
 * value-position string is masked — `MEDIA:"…"` is a real output shape the
 * extractor supports and is left alone.
 */
export function maskJsonStringMedia(content) {
  if (!content.includes('"') || !content.includes('MEDIA:')) return content;
  const chars = Array.from(content);
  for (const m of content.matchAll(/(?<=[:,{[])\s*"((?:[^"\\\n]|\\.)*)"/g)) {
    if (!/MEDIA:\s*(?:~\/|\/|[A-Za-z]:[/\\])/.test(m[1])) continue;
    const bodyStart = m.index + m[0].indexOf('"') + 1;
    blank(chars, bodyStart, bodyStart + m[1].length);
  }
  return chars.join('');
}

function unquote(raw) {
  let p = String(raw ?? '').trim();
  if (p.length >= 2 && p[0] === p[p.length - 1] && '`"\''.includes(p[0])) p = p.slice(1, -1).trim();
  return p.replace(/^[`"']+/, '').replace(/[`"',.;:)}\]]+$/, '');
}

/**
 * Pull `MEDIA:` tags out of a reply.
 *
 * Returns `{ media, cleaned, forceDocument }`. The `cleaned` text is what the
 * next pass (`extractLocalFiles`) must scan — that chaining IS the deduplication
 * between the two mechanisms. A path claimed here is gone from the text, so the
 * bare-path pass cannot claim it a second time.
 */
export function extractMedia(content) {
  const src = String(content ?? '');
  const forceDocument = src.includes('[[as_document]]');
  const isVoice = src.includes('[[audio_as_voice]]');
  let cleaned = src.split('[[audio_as_voice]]').join('').split('[[as_document]]').join('');

  // Locate tags in a masked copy so examples never match, then read the real text.
  const scan = maskJsonStringMedia(maskProtectedSpans(src));
  const media = [];
  for (const m of scan.matchAll(mediaTagRe())) {
    const p = unquote(m.groups?.path);
    if (p) media.push({ path: p, isVoice });
  }

  if (media.length) {
    // Mask `cleaned` (not `src`) so offsets survive the directive removal above.
    // Masking only LOCATES the spans — protected regions must stay verbatim in
    // the delivered text, so the cut happens on the unmasked copy.
    const maskedCleaned = maskJsonStringMedia(maskProtectedSpans(cleaned));
    const spans = [];
    for (const m of maskedCleaned.matchAll(mediaTagRe())) spans.push([m.index, m.index + m[0].length]);
    if (spans.length) {
      const chars = Array.from(cleaned);
      for (const [s, e] of spans.sort((a, b) => b[0] - a[0])) chars.splice(s, e - s);
      cleaned = chars.join('').replace(/\n{3,}/g, '\n\n').trim();
    }
  }

  return { media, cleaned, forceDocument };
}

/**
 * Find bare paths — the agent naming a file it made without flagging it. This is
 * the ordinary way files get delivered; `MEDIA:` is the explicit override.
 *
 * A path that isn't a file on disk is dropped. That is the most common reason a
 * promised file never arrives (the agent described a file it never wrote, or got
 * the path slightly wrong), so `onMissing` lets the caller log it rather than
 * have it vanish without a trace.
 */
export async function extractLocalFiles(content, onMissing) {
  const src = String(content ?? '');

  // Ignore paths that are being shown rather than sent.
  const codeSpans = [];
  for (const m of src.matchAll(/```[^\n]*\n[\s\S]*?```/g)) codeSpans.push([m.index, m.index + m[0].length]);
  for (const m of src.matchAll(/`[^`\n]+`/g)) codeSpans.push([m.index, m.index + m[0].length]);
  const inCode = (pos) => codeSpans.some(([s, e]) => pos >= s && pos < e);

  const found = [];
  for (const m of src.matchAll(barePathRe())) {
    if (inCode(m.index)) continue;
    const expanded = expandHome(m[0]);
    if (await isFile(expanded)) found.push([m[0], expanded]);
    else onMissing?.(m[0]);
  }

  const seen = new Set();
  const unique = [];
  for (const [raw, exp] of found) {
    if (seen.has(exp)) continue;
    seen.add(exp);
    unique.push([raw, exp]);
  }

  let cleaned = src;
  if (unique.length) {
    for (const [raw] of unique) cleaned = cleaned.split(raw).join('');
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();
  }
  return { paths: unique.map(([, exp]) => exp), cleaned };
}

function expandHome(p) {
  if (p === '~' || p.startsWith('~/')) return path.join(process.env.HOME || '', p.slice(1));
  return p;
}

async function isFile(p) {
  try { return (await fs.stat(p)).isFile(); } catch { return false; }
}

/**
 * Accept a path only if it resolves inside one of `allowedRoots`.
 *
 * Symlinks are resolved FIRST, so a link planted inside an allowed folder cannot
 * point out of it. The roots are the whole rule — there is no list of forbidden
 * locations to keep up to date, because nothing outside them is reachable.
 */
export async function validateDeliveryPath(candidate, allowedRoots) {
  const cleaned = unquote(candidate);
  if (!cleaned) return null;
  const expanded = expandHome(cleaned);
  if (!path.isAbsolute(expanded)) return null;

  let resolved;
  try {
    resolved = await fs.realpath(expanded);
    if (!(await fs.stat(resolved)).isFile()) return null;
  } catch {
    return null;
  }

  for (const root of allowedRoots || []) {
    if (!root) continue;
    let realRoot;
    try { realRoot = await fs.realpath(root); } catch { continue; }
    if (resolved === realRoot || resolved.startsWith(realRoot + path.sep)) return resolved;
  }
  return null;
}

/**
 * Drop items whose path falls outside the allowed roots, normalizing the rest.
 * Takes and returns `{ path, … }` objects so the `isVoice` flag rides along.
 */
export async function filterDeliveryPaths(items, allowedRoots, onRejected) {
  const out = [];
  for (const item of items || []) {
    const safe = await validateDeliveryPath(item.path, allowedRoots);
    if (safe) out.push({ ...item, path: safe });
    else onRejected?.(item.path);
  }
  return out;
}

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm', '.3gp']);
// Telegram's own rules: sendVoice takes Opus/OGG, sendAudio takes MP3/M4A.
// Everything else is a document, including .wav and .flac.
const VOICE_EXTS = new Set(['.ogg', '.opus']);
const AUDIO_EXTS = new Set(['.mp3', '.m4a']);

/**
 * How a file should be sent: 'photo' | 'video' | 'voice' | 'audio' | 'document'.
 *
 * `isVoice` only matters for Opus/OGG — an ordinary .ogg attachment shouldn't
 * become a voice bubble just because of its format. `forceDocument` sends images
 * as files so Telegram doesn't recompress them.
 */
export function deliveryKind(filePath, opts = {}) {
  const ext = path.extname(String(filePath ?? '')).toLowerCase();
  if (VOICE_EXTS.has(ext)) return opts.isVoice ? 'voice' : 'document';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (IMAGE_EXTS.has(ext) && !opts.forceDocument) return 'photo';
  return 'document';
}
