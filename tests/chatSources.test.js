// The chat-history source filter knows every kind of chat that exists.
//
// Written as a RULE, not a list — same shape as `sharedDeps.test.js` — because
// the next `source` is covered the day it is added rather than needing an
// assertion nobody remembers to write.
//
// Why it needs a test at all: a missing source is not a missing checkbox. Chats
// of that kind stay visible while `chatSources` is `null` (the default, meaning
// all), so nothing looks wrong. The moment the user narrows the filter once,
// those chats become invisible with no control to turn them back on — and
// `allSelected` computes true over the known list, so the menu says everything
// is shown while something is hidden. That is a bug you find by losing history,
// which is the worst way to find one.
//
// `memory` was added to `CHAT_SOURCES` with the memory pass, and this test is
// the thing that would have caught it being forgotten.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { CHAT_SOURCES, CHAT_SOURCE_LABELS } from '../src/renderer/constants.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Every .ts under a directory, skipping node_modules. */
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === 'out') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

/**
 * The `source` literals the code actually writes onto a chat row.
 *
 * Matched off `source: '<x>'` in a run payload. The alternative — importing a
 * constant — does not exist: the value is written inline at each run entry
 * point, which is itself why a new one is easy to forget.
 *
 * Scanned over `api/src` only, and that is the precise boundary rather than a
 * convenience: EVERY source but one is written on the companion, because the
 * companion is what runs a chat that no person started. The exception is
 * `desktop`, which is never written as a literal at all — `agent-core` stores
 * `source ?? 'desktop'`, so it is the fallback for a row that has none. Widening
 * the scan to `agent-core` picks up `source: 'builtin'` from the skill scanner,
 * which is a different kind of source entirely.
 */
function sourcesWrittenByTheCode() {
  const found = new Set();
  for (const file of walk(join(root, 'api', 'src'))) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/\bsource:\s*'([a-z]+)'/g)) found.add(m[1]);
  }
  return found;
}

test('every source the code writes has a filter entry and a label', () => {
  const written = sourcesWrittenByTheCode();
  // Sanity: the scan found something, so a regex that stopped matching fails
  // loudly instead of passing vacuously.
  assert.ok(written.size >= 3, `expected to find several sources, found ${[...written]}`);
  for (const source of written) {
    assert.ok(CHAT_SOURCES.includes(source), `chat source '${source}' is written by the code but missing from CHAT_SOURCES`);
    assert.ok(CHAT_SOURCE_LABELS[source], `chat source '${source}' has no label`);
  }
});

test('the known sources are all reachable, with no label left behind', () => {
  // The other direction: a source removed from the code should lose its filter
  // entry too, or the menu offers a checkbox that can never match anything.
  const written = sourcesWrittenByTheCode();
  // `desktop` is the fallback for a row with no source at all (agent-core writes
  // `source ?? 'desktop'`), so it is legitimately in the list without appearing
  // as a literal in a run payload.
  for (const source of CHAT_SOURCES) {
    if (source === 'desktop') continue;
    assert.ok(written.has(source), `CHAT_SOURCES lists '${source}', which nothing writes`);
  }
  assert.deepEqual(
    Object.keys(CHAT_SOURCE_LABELS).sort(),
    [...CHAT_SOURCES].sort(),
    'labels and sources have drifted apart',
  );
});
