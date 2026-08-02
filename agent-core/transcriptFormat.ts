// Turning timestamped speech into a transcript file.
//
// The provider's job is to return segments; this turns them into something
// readable. Kept separate and pure so swapping the speech engine can't change the
// output format, and so the formats can be tested without a network call.
//
// Plain `.js` for the same reason as `credentials.ts` — `node --test` loads it
// directly and both TypeScript builds import it without ceremony.
//
// A segment is `{ startMs, endMs, text, speaker? }`. That is the whole contract a
// new engine has to satisfy.

/** `HH:MM:SS,mmm` (SRT) or `HH:MM:SS.mmm` (WebVTT). */
function stamp(ms, sep) {
  const total = Math.max(0, Math.round(ms));
  const h = String(Math.floor(total / 3_600_000)).padStart(2, '0');
  const m = String(Math.floor(total / 60_000) % 60).padStart(2, '0');
  const s = String(Math.floor(total / 1000) % 60).padStart(2, '0');
  const msec = String(total % 1000).padStart(3, '0');
  return `${h}:${m}:${s}${sep}${msec}`;
}

/** Speaker prefix, when the engine identified who was talking. */
function line(seg) {
  const text = String(seg.text ?? '').trim();
  return seg.speaker ? `[${seg.speaker}] ${text}` : text;
}

/** SubRip. Numbered cues, `-->` between stamps, blank line between entries. */
export function toSrt(segments) {
  return (segments || [])
    .map((seg, i) => `${i + 1}\n${stamp(seg.startMs, ',')} --> ${stamp(seg.endMs, ',')}\n${line(seg)}`)
    .join('\n\n') + '\n';
}

/** WebVTT. Same shape as SRT with a header, dots for the fraction, no numbering. */
export function toVtt(segments) {
  const cues = (segments || [])
    .map((seg) => `${stamp(seg.startMs, '.')} --> ${stamp(seg.endMs, '.')}\n${line(seg)}`)
    .join('\n\n');
  return `WEBVTT\n\n${cues}\n`;
}

/**
 * Readable prose, no timestamps. Consecutive segments from one speaker are joined
 * into a paragraph — a subtitle cue breaks every few seconds, which is right for
 * playback and unreadable as a document.
 */
export function toText(segments) {
  const paras: Array<{ speaker: any; parts: string[] }> = [];
  for (const seg of segments || []) {
    const text = String(seg.text ?? '').trim();
    if (!text) continue;
    const prev = paras[paras.length - 1];
    if (prev && prev.speaker === seg.speaker) prev.parts.push(text);
    else paras.push({ speaker: seg.speaker, parts: [text] });
  }
  return paras
    .map((p) => (p.speaker ? `${p.speaker}: ` : '') + p.parts.join(' '))
    .join('\n\n') + (paras.length ? '\n' : '');
}

export const FORMATS = { srt: toSrt, vtt: toVtt, text: toText };

/** File extension for a format — `text` is `.txt`, the others match their name. */
export function extensionFor(format) {
  return format === 'text' ? '.txt' : `.${format}`;
}

/** Format segments, defaulting to SRT for an unknown name. */
export function formatTranscript(segments, format = 'srt') {
  return (FORMATS[format] || toSrt)(segments);
}
