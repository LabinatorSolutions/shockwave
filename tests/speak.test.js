// Text to speech (agent-core/speak.ts) — the parts that can be checked without a
// vendor: the container sniffer, and the guards around the network call.
//
// Why this is tested: the sniffer exists because vendors ignore the format you
// asked for, and its failure is invisible — you get a `.ogg` file Telegram
// refuses as a voice message with an error naming neither the format nor the
// file. hermes hit exactly that and added the same check.
//
// The other half is the promise that speaking NEVER costs the user their reply.
// `speakToFile` returns null instead of throwing on every path that can fail
// before the request, and those paths are the ones enumerated here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sniffContainer, speakToFile, speakLimitFor, isSpeakProvider } from '../agent-core/speak.ts';
import { voiceConfigOf } from '../agent-core/voiceProviders.ts';

// ── the sniffer ──────────────────────────────────────────────────────────────

const bytes = (...parts) => Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'latin1') : Buffer.from(p))));

test('Ogg is recognized — the format everything here is aiming at', () => {
  assert.equal(sniffContainer(bytes('OggS', [0, 2, 0, 0])), 'ogg');
});

test('the containers a vendor might send instead', () => {
  assert.equal(sniffContainer(bytes('ID3', [3, 0])), 'mp3');
  assert.equal(sniffContainer(bytes('RIFF', [0, 0, 0, 0], 'WAVE')), 'wav');
  assert.equal(sniffContainer(bytes('fLaC', [0])), 'flac');
  assert.equal(sniffContainer(bytes([0, 0, 0, 0], 'ftyp', 'M4A ')), 'mp4');
  assert.equal(sniffContainer(bytes([0x1a, 0x45, 0xdf, 0xa3])), 'webm');
});

test('MP3 and ADTS AAC share a sync word and are still told apart', () => {
  // `FF Fx` is both. Bits 3-1 of the second byte are the only difference, and
  // reading it wrong means converting a file that needed no conversion.
  assert.equal(sniffContainer(Buffer.from([0xff, 0xf1])), 'aac');
  assert.equal(sniffContainer(Buffer.from([0xff, 0xfb])), 'mp3');
});

test('unknown or truncated bytes claim nothing', () => {
  // Returning a guess here would skip a conversion that was needed.
  assert.equal(sniffContainer(Buffer.from('not audio at all')), null);
  assert.equal(sniffContainer(Buffer.alloc(0)), null);
  assert.equal(sniffContainer(Buffer.from([0xff])), null);
});

// ── speaking never costs the reply ───────────────────────────────────────────

test('an unconfigured setup returns null rather than throwing', async () => {
  // The caller has already written the user's answer. There is no failure here
  // worth turning into a thrown error.
  assert.equal(await speakToFile('hello', voiceConfigOf({}), '/tmp/nope.ogg'), null);
});

test('a vendor that cannot speak returns null', async () => {
  const config = voiceConfigOf({ speech: { provider: 'assemblyai' }, voiceKeys: { assemblyai: 'k' } });
  assert.equal(await speakToFile('hello', config, '/tmp/nope.ogg'), null);
});

test('a script that cleans down to nothing is silence, not an empty voice note', async () => {
  // A reply that was only a file tag or only a code block has nothing to say
  // aloud — and a request would be rejected for empty input anyway.
  const config = voiceConfigOf({ speech: { provider: 'deepgram' }, voiceKeys: { deepgram: 'k' } });
  assert.equal(await speakToFile('```js\nconst x = 1;\n```', config, '/tmp/nope.ogg'), null);
  assert.equal(await speakToFile('   ', config, '/tmp/nope.ogg'), null);
});

// ── the per-vendor input limit ───────────────────────────────────────────────

test('each speaking vendor declares a character limit', () => {
  // Over it the request is REJECTED, so this is not a style preference — a reply
  // longer than the limit fails entirely unless it is cut first.
  assert.ok(speakLimitFor(voiceConfigOf({ speech: { provider: 'deepgram' } })) > 0);
  assert.ok(speakLimitFor(voiceConfigOf({ speech: { provider: 'elevenlabs' } })) > 0);
  assert.equal(speakLimitFor(voiceConfigOf({})), null);
});

test('only the vendors with an implementation are speak providers', () => {
  assert.equal(isSpeakProvider('deepgram'), true);
  assert.equal(isSpeakProvider('elevenlabs'), true);
  assert.equal(isSpeakProvider('assemblyai'), false);
  assert.equal(isSpeakProvider('nope'), false);
});
