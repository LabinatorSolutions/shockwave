import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVersion, classifyVersions } from '../src/main/versionCompare.ts';

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
