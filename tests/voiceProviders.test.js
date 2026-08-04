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
  voiceConfigOf, listenProviderOf, speakProviderOf, micProviderOf,
  keyForProvider, listenKey, speakKey, micKey, canSpeak,
  providersFor, providerForJob, canDo, micProviders,
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

test('nothing stored resolves to nothing — no vendor is named out of thin air', () => {
  // `DEFAULT_LISTEN = 'assemblyai'` used to sit here and it named a vendor
  // whether or not a key for it existed, so an install was told "No AssemblyAI
  // key — add one" for a provider nobody had picked. Unset must read as unset.
  for (const input of [{}, null, undefined]) {
    assert.equal(listenProviderOf(input), '');
    assert.equal(micProviderOf(input), '');
    assert.equal(speakProviderOf(input), '');
  }
});

test('one key and one capable vendor resolves itself — that is not a default', () => {
  // Resolution from stored data: the answer is unreachable unless the key is
  // actually there, which is the whole difference from the old constant.
  const config = voiceConfigOf({ voiceKeys: { elevenlabs: 'xi' } });
  assert.equal(listenProviderOf(config), 'elevenlabs');
  assert.equal(micProviderOf(config), 'elevenlabs');
});

test('speaking never resolves itself, however few keys there are', () => {
  // It costs money per reply. Pasting a key to transcribe with must not start
  // synthesizing audio nobody asked for.
  const config = voiceConfigOf({ voiceKeys: { elevenlabs: 'xi' } });
  assert.equal(speakProviderOf(config), '');
  assert.equal(canSpeak(config), false);
});

test('two keys and no choice stays unset rather than guessing', () => {
  const config = voiceConfigOf({ voiceKeys: { assemblyai: 'a', deepgram: 'd' } });
  assert.equal(listenProviderOf(config), '');
  assert.equal(micProviderOf(config), '');
});

test('a chosen vendor that cannot do the job is ignored, not obeyed', () => {
  // AssemblyAI in the speaking slot is not a thing that can happen through the
  // UI, but a hand-edited settings row must not make `speak.ts` reach for a
  // vendor with no synthesis endpoint.
  const config = voiceConfigOf({
    speech: { provider: 'assemblyai' },
    voiceKeys: { assemblyai: 'a' },
  });
  assert.equal(speakProviderOf(config), '');
});

// ── the microphone is its own assignment ─────────────────────────────────────

test('the microphone follows transcription until it is pointed somewhere else', () => {
  const shared = voiceConfigOf({
    transcription: { provider: 'deepgram' },
    voiceKeys: { deepgram: 'dg' },
  });
  assert.equal(micProviderOf(shared), 'deepgram', 'one account doing both jobs is the ordinary case');

  // The case the assignment exists for: Deepgram's DEFAULT key transcribes and
  // cannot mint a streaming token, so the mic goes elsewhere while transcription
  // stays put. Before this the mic was simply dead with nowhere to go.
  const split = voiceConfigOf({
    transcription: { provider: 'deepgram', micProvider: 'assemblyai' },
    voiceKeys: { deepgram: 'dg', assemblyai: 'aai' },
  });
  assert.equal(listenProviderOf(split), 'deepgram');
  assert.equal(micProviderOf(split), 'assemblyai');
  assert.equal(listenKey(split), 'dg');
  assert.equal(micKey(split), 'aai');
});

test('providerForJob answers for all three jobs', () => {
  const config = voiceConfigOf({
    transcription: { provider: 'deepgram', micProvider: 'assemblyai' },
    speech: { provider: 'elevenlabs' },
    voiceKeys: { deepgram: 'dg', assemblyai: 'aai', elevenlabs: 'xi' },
  });
  assert.equal(providerForJob(config, 'listen'), 'deepgram');
  assert.equal(providerForJob(config, 'mic'), 'assemblyai');
  assert.equal(providerForJob(config, 'speak'), 'elevenlabs');
});

test('mic is a capability in its own right, separate from listen', () => {
  // `mic` is optional on the table, so a transcribe-only vendor added later
  // cannot silently become the microphone by inheriting the transcription slot.
  assert.deepEqual(micProviders().map((p) => p.slug), ['assemblyai', 'deepgram', 'elevenlabs']);
  assert.equal(canDo(voiceProvider('assemblyai'), 'mic'), true);
  assert.equal(canDo(voiceProvider('assemblyai'), 'speak'), false);
  assert.deepEqual(providersFor('speak').map((p) => p.slug), ['deepgram', 'elevenlabs']);
});

// ── the renderer resolves through the same functions ─────────────────────────

test('presence flags stand in for keys, so Settings resolves as the app does', () => {
  // The renderer never receives key values — main strips them and sends
  // `hasVoiceKey`. If the page had to reimplement "which vendor does this job",
  // Settings could show one answer while the agent used another.
  const fromFlags = voiceConfigOf({ hasVoiceKey: { elevenlabs: true, deepgram: false } });
  assert.equal(listenProviderOf(fromFlags), 'elevenlabs', 'a true flag counts as a key');
  assert.equal(keyForProvider(fromFlags, 'deepgram'), undefined, 'a false flag does not');

  // Real keys still win where they exist — main is not affected by any of this.
  const fromKeys = voiceConfigOf({ voiceKeys: { deepgram: 'dg' }, hasVoiceKey: { elevenlabs: true } });
  assert.equal(keyForProvider(fromKeys, 'deepgram'), 'dg');
  assert.equal(keyForProvider(fromKeys, 'elevenlabs'), undefined);
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
