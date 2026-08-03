// The reply mode (`agent-core/voiceReply.ts`) — pure policy, no disk.
//
// Why this is tested: the three modes are NOT a scale, and every delivery path
// asks the same two questions of them — does this send the words, does this
// speak. `sendsText` / `speaks` are the one place that mapping lives, and getting
// either backwards is silent: you get a voice note with no text, or text with no
// voice, and nothing errors.
//
// The value lives on the companion's `workspace.voice_reply` column and more than
// one thing writes it (`/voice`, the settings page), so the normalizer has to
// survive anything that column can hold.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeVoiceReply, isVoiceReply, sendsText, speaks,
  DEFAULT_VOICE_REPLY, VOICE_REPLY_MODES, VOICE_REPLY_LABELS,
} from '../agent-core/voiceReply.ts';

test('there are three modes and text is the default', () => {
  // Speaking costs money on every reply, so it is never what you get by doing
  // nothing.
  assert.deepEqual(VOICE_REPLY_MODES, ['text', 'voice', 'both']);
  assert.equal(DEFAULT_VOICE_REPLY, 'text');
});

test('each mode maps to the two questions delivery actually asks', () => {
  assert.equal(sendsText('text'), true);
  assert.equal(speaks('text'), false);

  // Voice is audio ALONE — the one mode that withholds the words.
  assert.equal(sendsText('voice'), false);
  assert.equal(speaks('voice'), true);

  assert.equal(sendsText('both'), true);
  assert.equal(speaks('both'), true);
});

test('anything unrecognized reads as the default', () => {
  // A plain text column with more than one writer: normalize rather than trust.
  for (const junk of ['Voice', 'audio', '', null, undefined, 0, {}, 'both ']) {
    assert.equal(normalizeVoiceReply(junk), 'text', String(junk));
  }
  assert.equal(normalizeVoiceReply('voice'), 'voice');
  assert.equal(normalizeVoiceReply('both'), 'both');
});

test('an unknown argument is rejected rather than silently becoming text', () => {
  // `/voice bogus` has to say so. Normalizing it to the default would look like
  // the command worked and quietly turn speaking off.
  assert.equal(isVoiceReply('bogus'), false);
  assert.equal(isVoiceReply(''), false);
  for (const m of VOICE_REPLY_MODES) assert.equal(isVoiceReply(m), true);
});

test('every mode has a label a person can read', () => {
  // The command echoes these back, so a missing one would render "undefined".
  for (const m of VOICE_REPLY_MODES) assert.equal(typeof VOICE_REPLY_LABELS[m], 'string');
});
