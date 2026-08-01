// Reusing a run's checkout must never destroy work that hasn't reached GitHub.
//
// The bug being pinned: `prepareCheckout` used to `reset --hard origin/<branch>`
// + `clean -fd` every time it reused a folder. A turn's work is only safe once
// it is PUSHED, and the push happens after the agent has already replied — so a
// second Telegram message landing in that window started a new run, and step one
// of a new run deleted the previous turn's work. Silently: the checkout is the
// only copy, and reset --hard leaves nothing behind to notice.
//
// Tested with REAL git, like tests/gitGuards.test.js, because the claim is about
// what git does to a working tree, not about which argv we assemble. The reuse
// sequence is mirrored here; if production drifts from it, these stop covering
// what they say they cover — so `mirrors production` names the one function that
// has to stay in step.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const git = (cwd, args) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();
const tryGit = (cwd, args) => { try { git(cwd, args); return true; } catch { return false; } };

/** A bare origin plus a clone of it, both with one commit. */
function scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shockwave-reuse-'));
  const origin = path.join(root, 'origin.git');
  const seed = path.join(root, 'seed');
  const work = path.join(root, 'work');

  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { stdio: 'pipe' });
  execFileSync('git', ['init', '-q', '-b', 'main', seed], { stdio: 'pipe' });
  git(seed, ['config', 'user.email', 'test@example.com']);
  git(seed, ['config', 'user.name', 'test']);
  fs.writeFileSync(path.join(seed, 'a.txt'), 'hello\n');
  git(seed, ['add', '-A']);
  git(seed, ['commit', '-qm', 'first']);
  git(seed, ['remote', 'add', 'origin', origin]);
  git(seed, ['push', '-q', 'origin', 'main']);

  // SHALLOW, like production — and via file:// because git silently ignores
  // --depth on a plain local path ("--depth is ignored in local clones"). This
  // used to be a full clone, which is exactly why these tests passed for months
  // while production failed: every behaviour below depends on whether the
  // checkout has history, and a full clone has all of it.
  execFileSync('git', ['clone', '-q', '--depth=1', '--branch', 'main', `file://${origin}`, work], { stdio: 'pipe' });
  assert.equal(git(work, ['rev-parse', '--is-shallow-repository']).trim(), 'true',
    'the fixture must be shallow or it does not mirror production');
  git(work, ['config', 'user.email', 'test@example.com']);
  git(work, ['config', 'user.name', 'test']);
  return { root, origin, seed, work };
}

/** Push a new commit to origin from the seed clone — someone else moving ahead. */
function remoteMovesAhead({ seed, origin }, name, body) {
  fs.writeFileSync(path.join(seed, name), body);
  git(seed, ['add', '-A']);
  git(seed, ['commit', '-qm', `add ${name}`]);
  git(seed, ['push', '-q', 'origin', 'main']);
  return origin;
}

/** The reuse path of prepareCheckout (api/src/git.ts), mirrored.
 *
 *  Catching up is `fetch` (NO --depth) then a `reset --hard` guarded on "is
 *  there anything here that exists nowhere else?". The guard is the whole
 *  safety property; the fetch having no --depth is what makes the guard
 *  answerable, since a grafted history counts every local commit as unpushed
 *  forever. */
function reuseCheckout(dir, branch) {
  fs.rmSync(path.join(dir, '.git', 'hooks'), { recursive: true, force: true });
  git(dir, ['fetch', '-q', 'origin', branch]);
  if (nothingToLose(dir, branch)) git(dir, ['reset', '-q', '--hard', `origin/${branch}`]);
}

/** Mirrors nothingToLose in api/src/git.ts. */
function nothingToLose(dir, branch) {
  try {
    if (git(dir, ['status', '--porcelain']).trim()) return false;
    return Number(git(dir, ['rev-list', '--count', `origin/${branch}..HEAD`]).trim()) === 0;
  } catch {
    return false;
  }
}

/** What the OLD reuse path did: fetch --depth=1, which rewrites .git/shallow so
 *  the remote branch arrives as its own root with no link to what we hold. Used
 *  to build a checkout already damaged by a previous release. */
function grafItApart(dir, branch) {
  git(dir, ['fetch', '-q', '--depth=1', 'origin', branch]);
}

test('reuse keeps uncommitted edits to a tracked file', () => {
  const s = scratch();
  fs.writeFileSync(path.join(s.work, 'a.txt'), 'EDITED BY THE AGENT\n');

  reuseCheckout(s.work, 'main');

  assert.equal(fs.readFileSync(path.join(s.work, 'a.txt'), 'utf8'), 'EDITED BY THE AGENT\n');
});

test('reuse keeps untracked files the agent created', () => {
  const s = scratch();
  fs.writeFileSync(path.join(s.work, 'notes.md'), 'brand new\n');

  reuseCheckout(s.work, 'main');

  assert.ok(fs.existsSync(path.join(s.work, 'notes.md')), 'untracked file was deleted');
});

test('reuse keeps a commit that was never pushed', () => {
  const s = scratch();
  fs.writeFileSync(path.join(s.work, 'b.txt'), 'committed but not pushed\n');
  git(s.work, ['add', '-A']);
  git(s.work, ['commit', '-qm', 'local work']);
  const head = git(s.work, ['rev-parse', 'HEAD']).trim();

  reuseCheckout(s.work, 'main');

  assert.equal(git(s.work, ['rev-parse', 'HEAD']).trim(), head, 'local commit was discarded');
  assert.ok(fs.existsSync(path.join(s.work, 'b.txt')));
});

test('reuse still catches up when the folder is clean and behind', () => {
  const s = scratch();
  remoteMovesAhead(s, 'fromDesktop.md', 'pushed elsewhere\n');

  reuseCheckout(s.work, 'main');

  assert.ok(
    fs.existsSync(path.join(s.work, 'fromDesktop.md')),
    'a clean checkout must fast-forward to the remote',
  );
});

test('unpushed work survives even when the remote has also moved', () => {
  const s = scratch();
  fs.writeFileSync(path.join(s.work, 'mine.md'), 'agent work\n');
  remoteMovesAhead(s, 'theirs.md', 'someone else\n');

  reuseCheckout(s.work, 'main');

  // The reset is refused — the agent's file is still here. checkIn's fetch+merge
  // reconciles at the end.
  assert.ok(fs.existsSync(path.join(s.work, 'mine.md')), 'agent work was destroyed');
});

// ── The bug: --depth=1 on the REUSE fetch ────────────────────────────────────
//
// It re-grafts the remote branch as a disconnected root, so git refuses every
// later merge as "unrelated histories". The checkout silently never caught up,
// the agent read stale files, and the check-in's push was rejected — the user
// was told the save failed while the work sat in the folder. These two pin the
// fix and the repair; both fail without them.

test('a fetch carrying --depth=1 breaks the link to what we already hold', () => {
  const s = scratch();
  remoteMovesAhead(s, 'fromDesktop.md', 'pushed elsewhere\n');

  grafItApart(s.work, 'main');

  // This is the whole bug in one assertion: after a --depth=1 fetch there is no
  // common commit, so nothing can merge and nothing can fast-forward.
  assert.equal(tryGit(s.work, ['merge-base', 'HEAD', 'origin/main']), false,
    '--depth=1 on a fetch must be understood to sever history — if this starts ' +
    'passing, git changed and prepareCheckout can be simplified');
  assert.equal(tryGit(s.work, ['merge', '--ff-only', '--no-verify', 'origin/main']), false);
});

