import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVersion, classifyVersions } from '../src/main/versionCompare.ts';
import { isCompanionStale } from '../src/shared/constants.ts';

test('parseVersion accepts plain and v-prefixed x.y.z', () => {
  assert.deepEqual(parseVersion('1.0.21'), [1, 0, 21]);
  assert.deepEqual(parseVersion('v1.0.21'), [1, 0, 21]);
  assert.deepEqual(parseVersion(' v2.10.0 '), [2, 10, 0]);
});

test('parseVersion rejects everything else', () => {
  for (const v of ['dev', '', null, undefined, '1.0', 'v1', '1.0.0-beta', 'v1.0.21; rm -rf /']) {
    assert.equal(parseVersion(v), null, `should reject ${JSON.stringify(v)}`);
  }
});

test('classifyVersions: match', () => {
  assert.equal(classifyVersions('1.0.21', 'v1.0.21'), 'match');
});

test('classifyVersions: companion behind -> companion-older', () => {
  assert.equal(classifyVersions('1.0.22', 'v1.0.21'), 'companion-older');
  assert.equal(classifyVersions('1.1.0', 'v1.0.99'), 'companion-older');
  assert.equal(classifyVersions('2.0.0', 'v1.9.9'), 'companion-older');
});

test('classifyVersions: companion ahead -> companion-newer', () => {
  assert.equal(classifyVersions('1.0.21', 'v1.0.22'), 'companion-newer');
  assert.equal(classifyVersions('1.0.99', 'v1.1.0'), 'companion-newer');
});

test('classifyVersions: numeric compare, not lexicographic', () => {
  assert.equal(classifyVersions('1.0.9', 'v1.0.10'), 'companion-newer');
});

test('classifyVersions: dev/unparseable on either side -> dev', () => {
  assert.equal(classifyVersions('1.0.21', 'dev'), 'dev');
  assert.equal(classifyVersions('dev', 'v1.0.21'), 'dev');
  assert.equal(classifyVersions('1.0.21', undefined), 'dev');
});

// ── What arms the kill switch ───────────────────────────────────────────────
// `isCompanionStale` is the one predicate main and the renderer both read: main
// to refuse every non-GET to the companion, the renderer for the toast, the
// sidebar icon, the settings gate and the chat composer. Getting it wrong is
// silent in BOTH directions — too narrow and writes go through against a server
// that can't store them correctly, too wide and the app refuses to save anything
// while showing no reason.

test('isCompanionStale: both real mismatches are stale', () => {
  assert.equal(isCompanionStale('companion-older'), true);
  assert.equal(isCompanionStale('companion-newer'), true);
});

test('isCompanionStale: dev is NEVER stale', () => {
  // A local companion reports APP_VERSION='dev', so classifyVersions answers
  // 'dev' for every development session. Treating that as a mismatch would
  // block every write on a machine that runs a dev install at all.
  assert.equal(isCompanionStale('dev'), false);
  assert.equal(isCompanionStale(classifyVersions('1.0.21', 'dev')), false);
  assert.equal(isCompanionStale(classifyVersions('dev', 'v1.0.21')), false);
});

test('isCompanionStale: matching and not-yet-known are fine', () => {
  assert.equal(isCompanionStale('match'), false);
  // Null is main having no answer — unreachable, or the first probe hasn't
  // returned. Not knowing is not a reason to refuse; an unreachable server
  // already fails at the transport.
  assert.equal(isCompanionStale(undefined), false);
  assert.equal(isCompanionStale(null), false);
});

test('isCompanionStale: an unrecognized status is not stale', () => {
  // The statuses arrive over IPC from a build that may be older than this one.
  // An unknown string must read as "no reason to block", never as a mismatch —
  // the fail-open direction here is the safe one, because the failure it guards
  // (a wrong-shaped write) is far rarer than the failure it would cause
  // (an app that saves nothing and can't say why).
  assert.equal(isCompanionStale('unreachable'), false);
  assert.equal(isCompanionStale(''), false);
});
