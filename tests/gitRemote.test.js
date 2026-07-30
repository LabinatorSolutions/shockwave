// The companion's git remote URL (api/src/gitRemote.js).
//
// Why this is tested: the GitHub PAT used to be embedded in this URL. `git clone`
// and `git remote set-url` both persist whatever they're given into
// `<dir>/.git/config`, and `<dir>` is the coding agent's own working directory for
// the turn — so `git remote -v` handed the agent a token with write access to
// every repo it covered, and the checkout outlived the run by RUN_DIR_TTL_DAYS.
// Auth goes through GIT_ASKPASS now; this pins the URL staying plain.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { remoteUrl, hasEmbeddedCredentials } from '../api/src/gitRemote.js';

test('the remote URL carries no credentials', () => {
  const url = remoteUrl('acme', 'notes');
  assert.equal(url, 'https://github.com/acme/notes.git');
  assert.equal(hasEmbeddedCredentials(url), false);
  assert.ok(!url.includes('@'), 'no credential separator');
  assert.ok(!/x-access-token/.test(url), 'no git-over-https username');
});

test('a token cannot sneak in through owner or repo', () => {
  // Not a realistic input, but the property worth pinning is that the builder has
  // no credential parameter at all — there is nothing for a caller to pass.
  assert.equal(remoteUrl.length, 2);
  const url = remoteUrl('acme', 'notes');
  assert.equal(hasEmbeddedCredentials(url), false);
});

test('hasEmbeddedCredentials catches the shape that used to ship', () => {
  assert.equal(
    hasEmbeddedCredentials('https://x-access-token:ghp_secret@github.com/acme/notes.git'),
    true,
  );
  assert.equal(hasEmbeddedCredentials('https://user@github.com/acme/notes.git'), true);
});

test('hasEmbeddedCredentials does not false-positive on @ outside the authority', () => {
  assert.equal(hasEmbeddedCredentials('https://github.com/acme/notes.git?x=a@b'), false);
  assert.equal(hasEmbeddedCredentials('https://github.com/acme/no@tes.git'), false);
  assert.equal(hasEmbeddedCredentials('https://github.com/acme/notes.git#a@b'), false);
});

test('hasEmbeddedCredentials tolerates junk', () => {
  assert.equal(hasEmbeddedCredentials(''), false);
  assert.equal(hasEmbeddedCredentials(undefined), false);
  assert.equal(hasEmbeddedCredentials(null), false);
  assert.equal(hasEmbeddedCredentials(42), false);
});
