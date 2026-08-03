// The per-workspace reply mode (`agent-core/voiceReply.ts`).
//
// Why this is tested: the three modes are NOT a scale, and every delivery path
// asks the same two questions of them — does this send the words, does this
// speak. `sendsText` / `speaks` are the one place that mapping lives, and getting
// either backwards is silent: you get a voice note with no text, or text with no
// voice, and nothing errors.
//
// The agent writes this key itself (`send_message(save: true)`), so the
// normalizer also has to survive a value nothing here recognizes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  normalizeVoiceReply, sendsText, speaks, readVoiceReply, writeVoiceReply,
  DEFAULT_VOICE_REPLY, VOICE_REPLY_MODES,
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
  // The agent writes this key, so a typo must not become a mode nothing renders.
  for (const junk of ['Voice', 'audio', '', null, undefined, 0, {}, 'both ']) {
    assert.equal(normalizeVoiceReply(junk), 'text', String(junk));
  }
  assert.equal(normalizeVoiceReply('voice'), 'voice');
  assert.equal(normalizeVoiceReply('both'), 'both');
});

// ── on disk ──────────────────────────────────────────────────────────────────

test('reading a workspace that has no file is not an error', async () => {
  // A missing or unreadable settings file means a workspace on the default.
  // Failing a reply over it would be absurd.
  assert.equal(await readVoiceReply(null), 'text');
  assert.equal(await readVoiceReply('/nonexistent/workspace'), 'text');
});

test('writing preserves everything else in the file', async () => {
  // The file also holds bookmarks and skill toggles. The agent may set the mode
  // mid-turn, and it has no business rewriting the rest.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'voicereply-'));
  const file = path.join(dir, '.shockwave', 'workspace.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ bookmarks: ['keep-me'], builtinSkills: { a: 'disabled' } }));

  assert.equal(await writeVoiceReply(dir, 'both'), true);
  assert.equal(await readVoiceReply(dir), 'both');

  const after = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(after.bookmarks, ['keep-me']);
  assert.deepEqual(after.builtinSkills, { a: 'disabled' });

  await fs.rm(dir, { recursive: true, force: true });
});

test('a corrupt file is replaced rather than left unwritable', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'voicereply-'));
  const file = path.join(dir, '.shockwave', 'workspace.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, 'not json at all');

  assert.equal(await writeVoiceReply(dir, 'voice'), true);
  assert.equal(await readVoiceReply(dir), 'voice');

  await fs.rm(dir, { recursive: true, force: true });
});

test('a write that cannot land reports false rather than throwing', async () => {
  // The caller uses this to tell the user the mode applied to one message only,
  // instead of promising a lasting change that did not stick.
  assert.equal(await writeVoiceReply(null, 'voice'), false);
});
