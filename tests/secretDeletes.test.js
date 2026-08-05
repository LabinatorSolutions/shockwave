// Where a stored credential may be DESTROYED (api/src/store.ts).
//
// This is a source scan, like tests/rendererSettingsDoor.test.js and
// tests/chatSources.test.js, and for the same reason: the property is about which
// code path is allowed to do a thing, the queries need a live Postgres, and the
// failure mode is silence. A credential that gets deleted for the wrong reason
// does not throw, does not log at the call site, and is unrecoverable — the
// ciphertext is gone, not orphaned.
//
// The rule: DESTRUCTION IS A REQUEST, NEVER AN INFERENCE. A save carrying an
// empty value, or a list that fails to mention a name, must not delete anything.
// Every one of the four ways keys were lost came from inferring it:
//
//   - renaming an entry (the name IS the credential's owner, so a new name read
//     as a new entity and the old one was deleted for being absent);
//   - a value that would not decrypt (`unseal` returns '' on failure, and empty
//     used to mean delete — so "I can't read this" became "delete it" on the next
//     launch that wrote the list back);
//   - the desktop's own writes, which never had the renderer's drop-empties guard;
//   - a stale list from a second machine or a dropped live feed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = readFileSync(path.join(root, 'api/src/store.ts'), 'utf8');

// Walk the file tracking the last top-level function declared, so a delete can be
// attributed to the function it sits in. Every function in this file is flat
// top-level, which is what makes this reliable rather than clever.
function deleteSitesByFunction(source, table) {
  const needle = `.delete(${table})`;
  const sites = [];
  let current = '<file scope>';
  source.split('\n').forEach((line, i) => {
    const decl = line.match(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)/);
    if (decl) current = decl[1];
    if (line.includes(needle)) sites.push({ fn: current, line: i + 1 });
  });
  return sites;
}

// The three that are allowed, and why each one is a request rather than a guess:
//   dropSecret          — the primitive the two explicit deletes below are built on
//   deleteAgentSecret   — DELETE /agent-secret/:name, the user removing an entry
//   clearTelegramAccount— disconnecting the bot, which owns its own two rows
const ALLOWED = new Set(['dropSecret', 'deleteAgentSecret', 'clearTelegramAccount']);

test('only the explicit delete paths remove a stored credential', () => {
  const sites = deleteSitesByFunction(src, 'secretValue');
  assert.ok(sites.length > 0, 'expected to find the delete sites at all — did the table get renamed?');
  for (const { fn, line } of sites) {
    assert.ok(
      ALLOWED.has(fn),
      `api/src/store.ts:${line} deletes from secret_value inside ${fn}(), which is not one of the explicit `
      + `delete paths (${[...ALLOWED].join(', ')}). If ${fn} is a save, this is the bug that wiped API keys: `
      + 'an empty value or a missing name must not destroy a credential. Add a route and a named function instead.',
    );
  }
});

test('writeAgentSecrets deletes nothing — a name absent from the list is left alone', () => {
  // The caller's list is legitimately stale: another machine may have added a
  // secret, the live feed may have dropped, an offline boot seeds an empty list.
  // Deleting by omission made every one of those a data-loss event.
  const body = bodyOf(src, 'writeAgentSecrets');
  assert.doesNotMatch(body, /\.delete\(/, 'writeAgentSecrets must not delete anything — see deleteAgentSecret');
});

test('putSecret refuses an empty value instead of treating it as a delete', () => {
  const body = bodyOf(src, 'putSecret');
  assert.doesNotMatch(body, /\.delete\(/, 'putSecret must never delete — that one line was four data-loss paths');
  assert.match(body, /if \(!plain\) return;/, 'an empty value must be a no-op, explicitly');
});

test('a rename re-files the credential rather than recreating the entry', () => {
  // secret_value.owner IS the secret's name, and nothing else can put the value
  // back: the renderer never receives credential values, so its empty token box
  // means "keep what is stored". The row has to move.
  const body = bodyOf(src, 'writeAgentSecrets');
  assert.match(body, /previousName/, 'writeAgentSecrets must honour the rename marker');
  assert.match(body, /update\(secretValue\)[\s\S]{0,120}owner/, 'a rename must move the secret_value rows to the new owner');
});

// Everything from `function <name>` to the next top-level `}`. Crude, and exact
// for this file: its functions are flat and its closing braces are in column 0.
function bodyOf(source, name) {
  const lines = source.split('\n');
  const start = lines.findIndex((l) => new RegExp(`^(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\b`).test(l));
  assert.notEqual(start, -1, `could not find ${name}() in api/src/store.ts`);
  const end = lines.findIndex((l, i) => i > start && l === '}');
  return lines.slice(start, end === -1 ? lines.length : end).join('\n');
}
