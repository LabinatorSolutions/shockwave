// Transcript formatting (agent-core/transcriptFormat.ts) — timestamped speech
// turned into a file you can read.
//
// Why this is tested: the format is the whole deliverable. A subtitle file with
// the wrong timestamp shape is silently rejected by every player that opens it,
// and the two formats differ by one character — SRT separates the fraction with a
// comma, WebVTT with a dot. That is exactly the kind of detail that survives code
// review and fails in front of a user.
//
// It is also the half of transcription that has no network in it, which is what
// makes the seam worth having: swapping the speech engine cannot change any of
// the behaviour below, because the engine never produces these strings.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { toSrt, toVtt, toText, formatTranscript, extensionFor } from '../agent-core/transcriptFormat.ts';

const segments = [
  { startMs: 0, endMs: 2500, text: 'Morning.', speaker: 'Speaker A' },
  { startMs: 2500, endMs: 5000, text: 'Did you read it?', speaker: 'Speaker A' },
  { startMs: 5200, endMs: 9000, text: 'Most of it.', speaker: 'Speaker B' },
];

test('srt numbers its cues and uses a comma before the milliseconds', () => {
  const out = toSrt(segments);
  assert.match(out, /^1\n00:00:00,000 --> 00:00:02,500\n\[Speaker A\] Morning\./);
  assert.match(out, /\n2\n00:00:02,500 --> 00:00:05,000\n/);
  assert.match(out, /\n3\n00:00:05,200 --> 00:00:09,000\n\[Speaker B\] Most of it\.\n$/);
});

test('vtt has the header, a dot before the milliseconds, and no numbering', () => {
  const out = toVtt(segments);
  assert.match(out, /^WEBVTT\n\n/);
  assert.match(out, /00:00:00\.000 --> 00:00:02\.500/);
  assert.doesNotMatch(out, /^1$/m);
});

test('hours are carried, not lost past sixty minutes', () => {
  // A long recording is exactly when a transcript is worth having, and a cue
  // that reads 00:01:05 for the sixty-fifth minute is silently wrong.
  const out = toSrt([{ startMs: 3_925_000, endMs: 3_926_000, text: 'later' }]);
  assert.match(out, /01:05:25,000 --> 01:05:26,000/);
});

test('text mode joins one speaker\'s run into a paragraph', () => {
  // Subtitle cues break every few seconds, which is right for playback and
  // unreadable as a document.
  const out = toText(segments);
  assert.equal(out, 'Speaker A: Morning. Did you read it?\n\nSpeaker B: Most of it.\n');
});

test('no speaker labels means no prefixes anywhere', () => {
  const plain = [{ startMs: 0, endMs: 1000, text: 'just one voice' }];
  assert.match(toSrt(plain), /\njust one voice\n?$/);
  assert.equal(toText(plain), 'just one voice\n');
});

test('empty input produces empty output, not a malformed file', () => {
  assert.equal(toText([]), '');
  assert.equal(toVtt([]), 'WEBVTT\n\n\n');
  assert.doesNotMatch(toSrt([]), /-->/);
});

test('an unknown format falls back to srt rather than failing', () => {
  assert.equal(formatTranscript(segments, 'nonsense'), toSrt(segments));
  assert.equal(formatTranscript(segments), toSrt(segments));
});

test('the extension matches the format, with text as .txt', () => {
  assert.equal(extensionFor('srt'), '.srt');
  assert.equal(extensionFor('vtt'), '.vtt');
  assert.equal(extensionFor('text'), '.txt');
});
