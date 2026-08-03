// The speech-vendor table (agent-core/voiceProviders.ts) — who can listen, who
// can speak, and which key applies to which job.
//
// Why this is tested: the matrix is NOT square. AssemblyAI transcribes and cannot
// synthesize at all, so "the voice provider" is not one choice, and a single
// dropdown driving both directions would either hide a vendor people are already
// using or quietly synthesize against an account that doesn't exist. Everything
// downstream — the two settings dropdowns, the token mint, the Telegram reply —
// reads its answer from here, so the shape is worth pinning by name.
//
// The single-use flag is the other load-bearing fact. It is the difference
// between a microphone that works twice and one that doesn't.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  VOICE_PROVIDERS, voiceProvider, voiceLabel, listenProviders, speakProviders,
  voiceConfigOf, listenProviderOf, speakProviderOf,
  keyForProvider, listenKey, speakKey, canSpeak,
  DEFAULT_LISTEN,
} from '../agent-core/voiceProviders.ts';

// ── the matrix ───────────────────────────────────────────────────────────────

test('the vendors are declared by name', () => {
  assert.deepEqual(VOICE_PROVIDERS.map((p) => p.slug).sort(), ['assemblyai', 'deepgram', 'elevenlabs']);
});

test('AssemblyAI listens and cannot speak', () => {
  // Not an oversight: they ship no standalone synthesis endpoint. If this ever
  // flips it should be a deliberate edit with a reason, not a silent drift.
  const aai = voiceProvider('assemblyai');
  assert.equal(aai.listen, true);
  assert.equal(aai.speak, false);
});

test('the two lists are different, which is the whole reason for two dropdowns', () => {
  assert.deepEqual(listenProviders().map((p) => p.slug), ['assemblyai', 'deepgram', 'elevenlabs']);
  assert.deepEqual(speakProviders().map((p) => p.slug), ['deepgram', 'elevenlabs']);
});

test('every vendor that can listen can also stream a microphone', () => {
  for (const p of listenProviders()) assert.ok(p.mic, `${p.slug} has no mic support declared`);
});

test('only ElevenLabs mints a single-use token', () => {
  // The renderer caches a token and reuses it until it expires. That is correct
  // for a 60-second reusable token and breaks the SECOND microphone click for a
  // token consumed on first use, so the flag has to travel with the token.
  assert.equal(voiceProvider('assemblyai').mic.singleUse, false);
  assert.equal(voiceProvider('deepgram').mic.singleUse, false);
  assert.equal(voiceProvider('elevenlabs').mic.singleUse, true);
  assert.equal(voiceProvider('elevenlabs').mic.tokenTtlMs, 15 * 60_000);
});

test('an unknown slug resolves to nothing and labels as itself', () => {
  assert.equal(voiceProvider('nope'), undefined);
  assert.equal(voiceLabel('nope'), 'nope');
  assert.equal(voiceLabel('elevenlabs'), 'ElevenLabs');
  assert.equal(voiceLabel(undefined), 'that provider');
});

// ── which vendor, and which key ──────────────────────────────────────────────

test('listening has a default and speaking deliberately does not', () => {
  // Speaking costs money on every reply, so an unconfigured install must not
  // arrive already pointed at a vendor.
  assert.equal(listenProviderOf({}), DEFAULT_LISTEN);
  assert.equal(listenProviderOf(null), 'assemblyai');
  assert.equal(speakProviderOf({}), '');
  assert.equal(speakProviderOf(null), '');
});

test('one key per vendor serves both directions', () => {
  // The point of keying by vendor: pick Deepgram for both jobs and the key is
  // entered once, not once per job.
  const config = voiceConfigOf({
    transcription: { provider: 'deepgram' },
    speech: { provider: 'deepgram', voiceId: 'aura-2-thalia-en' },
    voiceKeys: { deepgram: 'dg-key' },
  });
  assert.equal(listenKey(config), 'dg-key');
  assert.equal(speakKey(config), 'dg-key');
});

test('the two halves read different keys when the vendors differ', () => {
  const config = voiceConfigOf({
    transcription: { provider: 'assemblyai' },
    speech: { provider: 'elevenlabs' },
    voiceKeys: { assemblyai: 'aai', elevenlabs: 'xi' },
  });
  assert.equal(listenKey(config), 'aai');
  assert.equal(speakKey(config), 'xi');
});

test('an empty key reads as no key, not as a key', () => {
  const config = voiceConfigOf({ transcription: { provider: 'deepgram' }, voiceKeys: { deepgram: '' } });
  assert.equal(listenKey(config), undefined);
  assert.equal(keyForProvider(config, 'deepgram'), undefined);
  assert.equal(keyForProvider(config, undefined), undefined);
});

test('voiceConfigOf survives a partial or missing settings object', () => {
  // It is called with whatever the companion returned, including nothing.
  for (const input of [undefined, null, {}, { transcription: { provider: 'deepgram' } }]) {
    const config = voiceConfigOf(input);
    assert.ok(config.transcription);
    assert.ok(config.speech);
    assert.ok(config.voiceKeys);
  }
});

// ── the one question every caller asks before doing any work ─────────────────

test('speaking needs a vendor, a key, and a vendor that can speak', () => {
  assert.equal(canSpeak(voiceConfigOf({})), false, 'nothing configured');
  assert.equal(
    canSpeak(voiceConfigOf({ speech: { provider: 'elevenlabs' } })),
    false, 'vendor chosen, no key',
  );
  assert.equal(
    canSpeak(voiceConfigOf({ speech: { provider: 'assemblyai' }, voiceKeys: { assemblyai: 'k' } })),
    false, 'key stored for a vendor that cannot speak',
  );
  assert.equal(
    canSpeak(voiceConfigOf({ speech: { provider: 'deepgram' }, voiceKeys: { deepgram: 'k' } })),
    true,
  );
});
