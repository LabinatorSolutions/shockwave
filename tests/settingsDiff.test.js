// Patch-diffing for settings saves (src/renderer/settingsDiff.ts).
//
// The stakes: settings are stored one row per leaf key, but per-field setters
// build whole sub-objects, so they read every sibling — credentials included —
// out of the local cache. If those siblings reach the store, a slider nudge
// re-encrypts the GitHub PAT, and a stale cache value overwrites a fresher one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPatch, changedLeaves, dropEmptyCredentials } from '../src/renderer/settingsDiff.ts';

test('a changed leaf is sent alone, siblings are not', () => {
  const prev = { sync: { pat: 'ghp_secret', pullIntervalSeconds: 10, disabledWorkspaceIds: [] } };
  const next = { sync: { ...prev.sync, pullIntervalSeconds: 11 } };
  // This is exactly what onSyncChange builds — note it carries `pat` verbatim.
  assert.deepEqual(buildPatch(next, prev), { 'sync.pullIntervalSeconds': 11 });
});

test('an unchanged sub-object produces no write at all', () => {
  const prev = { appearance: { themeMode: 'light', hideLineNumbers: true, treePanel: { content: 'recent', count: 7 } } };
  assert.deepEqual(buildPatch({ appearance: { ...prev.appearance } }, prev), {});
});

test('a nested leaf is addressed by its full dotted path', () => {
  const prev = { appearance: { themeMode: 'light', treePanel: { content: 'recent', count: 7 } } };
  const next = { appearance: { ...prev.appearance, treePanel: { content: 'recent', count: 12 } } };
  assert.deepEqual(buildPatch(next, prev), { 'appearance.treePanel.count': 12 });
});

test('a credential is written only when it actually changes', () => {
  const prev = { sync: { pat: 'old', pullIntervalSeconds: 10 } };
  assert.deepEqual(buildPatch({ sync: { pat: 'new', pullIntervalSeconds: 10 } }, prev), { 'sync.pat': 'new' });
  assert.deepEqual(buildPatch({ sync: { pat: 'old', pullIntervalSeconds: 10 } }, prev), {});
});

test('provider keys are addressed individually', () => {
  // Changing the model must not rewrite (and re-encrypt) every provider key.
  const prev = { codingAgent: { model: 'a', providerKeys: { anthropic: 'sk-1', openai: 'sk-2' } } };
  const next = { codingAgent: { model: 'b', providerKeys: { ...prev.codingAgent.providerKeys } } };
  assert.deepEqual(buildPatch(next, prev), { 'codingAgent.model': 'b' });
});

test('an unset leaf stays unset — a display default must not become a write', () => {
  // The regression this pins, measured: the settings page rebuilt the whole
  // codingAgent object out of its `?? fallback` display locals, so picking a
  // reasoning level ALSO wrote `codingAgent.baseUrl: ''` — a row nobody typed,
  // for a field the DB had no value for. `'' !== undefined` at the leaf, so the
  // fabrication is indistinguishable from an edit by the time it gets here.
  //
  // The store is the source of truth (root CLAUDE.md: nothing faked on read), so
  // a section must spread what the server sent, not what it chose to render.
  const prev = { codingAgent: { provider: 'anthropic', model: 'claude-opus-5' } };

  // What a section does when it spreads the PROP: unset leaves compare equal.
  assert.deepEqual(
    buildPatch({ codingAgent: { ...prev.codingAgent, thinkingLevel: 'high' } }, prev),
    { 'codingAgent.thinkingLevel': 'high' },
  );

  // What it did when it rebuilt from defaulted locals: two extra rows invented.
  assert.deepEqual(
    buildPatch({ codingAgent: { ...prev.codingAgent, baseUrl: '', thinkingLevel: 'high' } }, prev),
    { 'codingAgent.baseUrl': '', 'codingAgent.thinkingLevel': 'high' },
  );
});

test('collections pass through whole, even when unchanged', () => {
  // They reconcile by membership in the store — a "nothing changed" diff would
  // be wrong, and an empty array must still be able to clear the table.
  const list = [{ id: 'w1', name: 'demo', path: '/demo' }];
  assert.deepEqual(buildPatch({ workspaces: list }, { workspaces: list }), { workspaces: list });
  assert.deepEqual(buildPatch({ agentSecrets: [] }, { agentSecrets: [] }), { agentSecrets: [] });
});

test('main-owned keys are never authored by the renderer', () => {
  assert.deepEqual(buildPatch({ windowBounds: { x: 1 } }, {}), {});
});

test('arrays are compared structurally, not by identity', () => {
  const prev = { sync: { disabledWorkspaceIds: ['a', 'b'] } };
  assert.deepEqual(buildPatch({ sync: { disabledWorkspaceIds: ['a', 'b'] } }, prev), {});
  assert.deepEqual(buildPatch({ sync: { disabledWorkspaceIds: ['a'] } }, prev),
    { 'sync.disabledWorkspaceIds': ['a'] });
});

test('a key absent from the cache is treated as changed', () => {
  // First write of a setting that has no row yet must not be swallowed.
  assert.deepEqual(buildPatch({ viewMode: 'raw' }, {}), { viewMode: 'raw' });
});

test('null and false are real values, not "unset"', () => {
  assert.deepEqual(buildPatch({ bookmarkFilterActive: false }, { bookmarkFilterActive: true }),
    { bookmarkFilterActive: false });
  assert.deepEqual(buildPatch({ activeWorkspaceId: null }, { activeWorkspaceId: 'ws_1' }),
    { activeWorkspaceId: null });
  // …and an unchanged false must still produce nothing.
  assert.deepEqual(buildPatch({ bookmarkFilterActive: false }, { bookmarkFilterActive: false }), {});
});

test('changedLeaves writes into the accumulator it is given', () => {
  const out = {};
  changedLeaves('a', { b: 1, c: 2 }, { b: 1, c: 9 }, out);
  assert.deepEqual(out, { 'a.c': 2 });
});

// ── Open-ended maps ──────────────────────────────────────────────────────────

test('providerKeys travels whole so removals are visible to the store', () => {
  // A per-leaf diff would only mention keys still present, so a deleted slug
  // would never be written — leaving the credential encrypted on disk and
  // reappearing on the next read.
  const prev = { codingAgent: { model: 'a', providerKeys: { anthropic: 'sk-1', openai: 'sk-2' } } };
  const next = { codingAgent: { model: 'a', providerKeys: { anthropic: 'sk-1' } } };
  assert.deepEqual(buildPatch(next, prev), { 'codingAgent.providerKeys': { anthropic: 'sk-1' } });
});

test('an unchanged providerKeys map is still not sent', () => {
  const prev = { codingAgent: { model: 'a', providerKeys: { anthropic: 'sk-1' } } };
  const next = { codingAgent: { model: 'b', providerKeys: { anthropic: 'sk-1' } } };
  assert.deepEqual(buildPatch(next, prev), { 'codingAgent.model': 'b' });
});

test('clearing the last provider key sends an empty map, not nothing', () => {
  const prev = { codingAgent: { providerKeys: { anthropic: 'sk-1' } } };
  assert.deepEqual(buildPatch({ codingAgent: { providerKeys: {} } }, prev),
    { 'codingAgent.providerKeys': {} });
});

// ── Renaming an agent secret ─────────────────────────────────────────────────

test('a rename marker survives the send guard that drops the empty token', () => {
  // THIS COMBINATION IS THE BUG. Renaming an entry with the token box left blank
  // wiped the key: the stored credential is filed under the secret's NAME, so the
  // companion read a new name as a new entity and deleted the old one — and this
  // window holds no copy of the token to resend, so the guard below (correctly)
  // strips the empty one and there was nothing left to carry it across.
  //
  // `previousName` is what turns that into a re-file. If it were ever dropped here
  // the failure would look exactly like the original bug, so it is pinned next to
  // the strip that made the bug possible rather than on its own.
  const patch = dropEmptyCredentials({
    agentSecrets: [{ name: 'FIRECRAWL', previousName: 'FIRECRAWL_API_KEY', description: 'x', token: '' }],
  });
  assert.deepEqual(patch.agentSecrets, [
    { name: 'FIRECRAWL', previousName: 'FIRECRAWL_API_KEY', description: 'x' },
  ]);
});

test('a typed token still travels alongside the rename', () => {
  const patch = dropEmptyCredentials({
    agentSecrets: [{ name: 'B', previousName: 'A', description: '', token: 'sk-live' }],
  });
  assert.equal(patch.agentSecrets[0].token, 'sk-live');
  assert.equal(patch.agentSecrets[0].previousName, 'A');
});

test('agentSecrets travels whole and undiffed, so a rename is never diffed away', () => {
  // Collections pass through as a unit (COLLECTION_KEYS). A per-leaf diff would
  // compare `previousName` against a cache that has never held one and could drop
  // it as unchanged — the marker only exists on the save that performs the rename.
  const prev = { agentSecrets: [{ name: 'A', description: '' }] };
  const next = { agentSecrets: [{ name: 'B', previousName: 'A', description: '' }] };
  assert.deepEqual(buildPatch(next, prev), next);
});
