// The credential boundary (agent-core/credentials.ts) — the one declaration of
// WHICH settings fields are credentials, and the path helpers the two consumers
// share.
//
// Why this is tested: this list is what keeps your keys off the screen and stops
// an unrelated save from deleting them. It used to be written out three times —
// the companion deciding what to encrypt, main deciding what to strip, the
// renderer deciding what not to send back — and a mismatch is not cosmetic. Miss a
// field in the strip and it leaks to the screen; miss it in the send guard and
// editing a sync interval wipes your GitHub token.
//
// I wrote the strip and the send guard and left this untested, which is how the
// URL-change hole survived. So: the list, and the helpers both consumers run.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SETTINGS_CREDENTIALS, AGENT_SECRET_CREDENTIALS,
  settingsCredentialPatterns, agentSecretFields, oauthOwnedFields,
  getPath, deletePath, setPathCopy, isSet, isDeletableCredential,
} from '../agent-core/credentials.ts';

// ── the list itself ──────────────────────────────────────────────────────────

test('every known credential is declared', () => {
  // A field missing here is a field that leaks. Pinned by name so removing one is
  // a deliberate act with a failing test, not a silent regression.
  const paths = SETTINGS_CREDENTIALS.map((c) => c.path).sort();
  assert.deepEqual(paths, [
    'codingAgent.providerKeys',
    'sync.pat',
    // Keyed by VENDOR, not by job. Speech runs in two directions across three
    // vendors, and choosing one vendor for both is one account with one key — a
    // field per job would ask for it twice and store it twice.
    'voiceKeys',
  ]);

  const secretPaths = AGENT_SECRET_CREDENTIALS.map((c) => c.path).sort();
  assert.deepEqual(secretPaths, ['oauth.accessToken', 'oauth.clientSecret', 'oauth.refreshToken', 'token']);
});

test('every credential carries a flag, and the flags are distinct', () => {
  // The flag is what the renderer gets instead of the value. A missing one means
  // the box can't tell whether a key is stored; a duplicate means two fields
  // collapse into one and a dot appears for a key that isn't there.
  const all = [...SETTINGS_CREDENTIALS, ...AGENT_SECRET_CREDENTIALS];
  for (const c of all) assert.ok(c.flag, `${c.path} has no flag`);
  const flags = all.map((c) => c.flag);
  assert.equal(new Set(flags).size, flags.length, 'flag names must be unique');
});

test('only the OAuth-flow-owned pair is marked as such', () => {
  // These two must never be authored by a bulk save: Google rotates the refresh
  // token on every refresh, so a stale echo permanently kills the connection.
  assert.deepEqual(oauthOwnedFields().sort(), ['oauth.accessToken', 'oauth.refreshToken']);
  // clientSecret is deliberately NOT owned — the user types it in Settings.
  assert.ok(!oauthOwnedFields().includes('oauth.clientSecret'));
});

// ── what the companion derives from it ───────────────────────────────────────

test('the companion patterns match real keys and nothing else', () => {
  const match = (k) => settingsCredentialPatterns().some((re) => re.test(k));
  assert.equal(match('sync.pat'), true);
  assert.equal(match('codingAgent.providerKeys.anthropic'), true);
  assert.equal(match('codingAgent.providerKeys.openai-compatible'), true);
  // A top-level wildcard map matches the same way a nested one does.
  assert.equal(match('voiceKeys.assemblyai'), true);
  assert.equal(match('voiceKeys.elevenlabs'), true);
  // Neither map is a leaf itself — both are reconciled, not stored as one row.
  assert.equal(match('codingAgent.providerKeys'), false);
  assert.equal(match('voiceKeys'), false);
  // Nested deeper than one slug isn't a key either.
  assert.equal(match('codingAgent.providerKeys.a.b'), false);
  assert.equal(match('voiceKeys.a.b'), false);
  // Neighbours that merely look similar.
  assert.equal(match('sync.pullIntervalSeconds'), false);
  assert.equal(match('transcription.provider'), false);
  assert.equal(match('speech.voiceId'), false);
  assert.equal(match('codingAgent.model'), false);
});

test('agent-secret field names are the storage form', () => {
  assert.deepEqual(agentSecretFields().sort(), ['oauth.accessToken', 'oauth.clientSecret', 'oauth.refreshToken', 'token']);
});

// ── path helpers, run by both the strip and the send guard ───────────────────

test('getPath reads nested values and tolerates gaps', () => {
  const o = { sync: { pat: 'ghp_x' }, codingAgent: { providerKeys: { anthropic: 'sk' } } };
  assert.equal(getPath(o, 'sync.pat'), 'ghp_x');
  assert.equal(getPath(o, 'codingAgent.providerKeys.anthropic'), 'sk');
  assert.equal(getPath(o, 'sync.nope'), undefined);
  assert.equal(getPath(o, 'nothing.here.at.all'), undefined);
  assert.equal(getPath(null, 'sync.pat'), undefined);
});

test('deletePath removes the leaf and does NOT mutate the input', () => {
  // Non-mutation matters: the strip runs on the object main is about to use for
  // itself. Mutating it would delete main's own copy of the credential.
  const o = { sync: { pat: 'ghp_x', pullIntervalSeconds: 10 } };
  const out = deletePath(o, 'sync.pat');
  assert.equal(out.sync.pat, undefined);
  assert.equal(out.sync.pullIntervalSeconds, 10, 'siblings survive');
  assert.equal(o.sync.pat, 'ghp_x', 'input untouched');
});

test('deletePath is a no-op on a path that does not exist', () => {
  const o = { sync: { pullIntervalSeconds: 10 } };
  assert.deepEqual(deletePath(o, 'sync.pat'), { sync: { pullIntervalSeconds: 10 } });
  assert.deepEqual(deletePath(o, 'a.b.c'), { sync: { pullIntervalSeconds: 10 } });
});

test('setPathCopy writes without mutating, creating parents as needed', () => {
  const o = { sync: { pullIntervalSeconds: 10 } };
  const out = setPathCopy(o, 'sync.hasPat', true);
  assert.equal(out.sync.hasPat, true);
  assert.equal(out.sync.pullIntervalSeconds, 10);
  assert.equal(o.sync.hasPat, undefined, 'input untouched');
  assert.equal(setPathCopy({}, 'a.b.c', 1).a.b.c, 1);
});

test('isSet treats an empty string as not set', () => {
  // This is the whole absent-vs-empty distinction: an empty credential means
  // DELETE on the server, so "is one stored" must not be true for ''.
  assert.equal(isSet('x'), true);
  assert.equal(isSet(''), false);
  assert.equal(isSet(undefined), false);
  assert.equal(isSet(null), false);
  assert.equal(isSet(0), true, 'non-strings are set if present');
});

// ── what may be deleted ──────────────────────────────────────────────────────

test('every declared credential is deletable', () => {
  // Deleting needs its own route: the renderer holds no credential VALUES, so
  // everything it sends reads as empty and empty ones are stripped from saves on
  // purpose. That left no way to remove one at all — clearing the box did nothing
  // and the old value stayed on the companion, so a leaked key couldn't be revoked
  // from the app. The allowlist is this same declaration, so the two can't drift.
  assert.equal(isDeletableCredential('sync.pat'), true);
  assert.equal(isDeletableCredential('codingAgent.providerKeys.anthropic'), true);
  assert.equal(isDeletableCredential('codingAgent.providerKeys.openai-compatible'), true);
  // Revoking one vendor's voice key must not require clearing the others.
  assert.equal(isDeletableCredential('voiceKeys.deepgram'), true);
  assert.equal(isDeletableCredential('voiceKeys.elevenlabs'), true);
  // The map itself is not deletable — that would take every vendor's key at once.
  assert.equal(isDeletableCredential('voiceKeys'), false);
});

test('a non-credential settings path is refused', () => {
  // The handler writes an empty string straight through, so an unchecked path
  // would let the renderer blank any setting it named.
  assert.equal(isDeletableCredential('codingAgent.model'), false);
  assert.equal(isDeletableCredential('sync.pullIntervalSeconds'), false);
  assert.equal(isDeletableCredential('appearance.themeMode'), false);
  assert.equal(isDeletableCredential('timezone'), false);
});

test('the wildcard map itself is not deletable, only its leaves', () => {
  // 'codingAgent.providerKeys' is reconciled, not a stored leaf — deleting it as
  // one would write an empty string over the map.
  assert.equal(isDeletableCredential('codingAgent.providerKeys'), false);
  assert.equal(isDeletableCredential('codingAgent.providerKeys.a.b'), false, 'one slug deep only');
});

test('junk paths are refused', () => {
  assert.equal(isDeletableCredential(''), false);
  assert.equal(isDeletableCredential(undefined), false);
  assert.equal(isDeletableCredential(null), false);
  assert.equal(isDeletableCredential(42), false);
});
