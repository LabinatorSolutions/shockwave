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

  execFileSync('git', ['clone', '-q', origin, work], { stdio: 'pipe' });
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
 *  Catching up is `merge --ff-only`, never `reset --hard` + `clean -fd`. */
function reuseCheckout(dir, branch) {
  fs.rmSync(path.join(dir, '.git', 'hooks'), { recursive: true, force: true });
  git(dir, ['fetch', '-q', 'origin', branch]);
  tryGit(dir, ['merge', '--ff-only', '--no-verify', `origin/${branch}`]);
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

  // The fast-forward is refused (or carries the edit through) — either way the
  // agent's file is still here. checkIn's fetch+merge reconciles at the end.
  assert.ok(fs.existsSync(path.join(s.work, 'mine.md')), 'agent work was destroyed');
});
