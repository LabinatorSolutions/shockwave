// The renderer-facing projection of a workspace (`src/main/workspaceRow.ts`).
//
// This now covers the LIVE path. It used to test a function nothing imported:
// `settingsStore.overlayLocal` built the renderer's shape inline, so the tested
// projection was fiction and the real one had no coverage at all. That is how
// `voiceReply` reached the settings page as undefined — added to the tested copy,
// absent from the one that ran. (That field is gone from here entirely now: the
// Telegram reply mode is app-level, an ordinary setting rather than a property of
// a workspace — see agent-core/voiceReply.ts.)
//
// A workspace comes from two sources and this is where they meet: identity from
// the companion (id, name, repo) and machine-local state from userData (checkout
// path, sync toggle).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { projectWorkspaceRow } from '../src/main/workspaceRow.ts';

// ── sync polarity ────────────────────────────────────────────────────────────
//
// This used to be `!row.syncDisabled`, from a `sync_disabled` column on the
// companion. That column is GONE — the toggle is machine-local and
// `getWorkspaceLocal` already answers in the positive — so negating here inverts
// every Sync switch in Settings with nothing failing. Pinned because the bug is
// invisible: no error, no log, the switches just all read on.

test('syncEnabled is passed through, not negated', () => {
  assert.equal(projectWorkspaceRow({ syncEnabled: true }).syncEnabled, true);
  assert.equal(projectWorkspaceRow({ syncEnabled: false }).syncEnabled, false);
});

test('an absent sync flag reads as syncing', () => {
  // A workspace nobody has touched has no local row, and normal behaviour is to
  // sync — same reason the old column stored *disabled*.
  assert.equal(projectWorkspaceRow({}).syncEnabled, true);
  assert.equal(projectWorkspaceRow({ syncEnabled: undefined }).syncEnabled, true);
});

// ── the rest of the shape ────────────────────────────────────────────────────

test('repo is owner/name and a null path survives', () => {
  const row = projectWorkspaceRow({
    id: 'w1', name: 'Notes', path: null,
    repoOwner: 'acme', repoName: 'widgets', syncEnabled: true,
  });
  assert.equal(row.repo, 'acme/widgets');
  assert.equal(row.path, null);   // "exists, not checked out on this machine"
  assert.equal(row.id, 'w1');
  assert.equal(row.name, 'Notes');
});
