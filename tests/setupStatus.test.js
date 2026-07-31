import test from 'node:test';
import assert from 'node:assert/strict';
import { setupStatus, anyIncomplete } from '../src/renderer/setupStatus.js';

const COMPLETE = {
  companionUrl: 'https://example.com',
  companionHasKey: true,
  gitInstalled: true,
  hasPat: true,
  provider: 'anthropic',
  model: 'claude-opus-5',
  hasProviderKey: { anthropic: true },
};

test('nothing flagged when every required value is present', () => {
  const s = setupStatus(COMPLETE);
  assert.deepEqual(s, { companion: false, github: false, agent: false });
  assert.equal(anyIncomplete(s), false);
});

test('companion needs both a URL and a key', () => {
  assert.equal(setupStatus({ ...COMPLETE, companionUrl: '' }).companion, true);
  assert.equal(setupStatus({ ...COMPLETE, companionUrl: '   ' }).companion, true);
  assert.equal(setupStatus({ ...COMPLETE, companionHasKey: false }).companion, true);
});

test('github covers the token AND git being installed', () => {
  assert.equal(setupStatus({ ...COMPLETE, hasPat: false }).github, true);
  assert.equal(setupStatus({ ...COMPLETE, gitInstalled: false }).github, true);
});

// The check runs before the git probe answers. Unknown must read as fine, or the
// app opens with a red dot on every launch that then clears itself.
test('git defaults to installed while the probe is still out', () => {
  const withoutGit = { ...COMPLETE };
  delete withoutGit.gitInstalled;
  assert.equal(setupStatus(withoutGit).github, false);
});

test('agent needs provider, model, and a key', () => {
  assert.equal(setupStatus({ ...COMPLETE, provider: '' }).agent, true);
  assert.equal(setupStatus({ ...COMPLETE, model: '' }).agent, true);
  assert.equal(setupStatus({ ...COMPLETE, hasProviderKey: {} }).agent, true);
});

// A key stored for a DIFFERENT provider is not a key for this one.
test('agent key is checked per provider', () => {
  const s = setupStatus({ ...COMPLETE, provider: 'openai', model: 'gpt-5' });
  assert.equal(s.agent, true);
});

// openai-compatible authenticates by URL; requiring a key would badge a page
// that is correctly configured.
test('openai-compatible needs no key', () => {
  const s = setupStatus({
    ...COMPLETE, provider: 'openai-compatible', model: 'local', hasProviderKey: {},
  });
  assert.equal(s.agent, false);
});

test('missing input is treated as nothing configured, not a crash', () => {
  const s = setupStatus();
  assert.deepEqual(s, { companion: true, github: true, agent: true });
  assert.equal(anyIncomplete(s), true);
});

test('anyIncomplete is true when any single item is', () => {
  assert.equal(anyIncomplete(setupStatus({ ...COMPLETE, hasPat: false })), true);
  assert.equal(anyIncomplete(null), false);
});
