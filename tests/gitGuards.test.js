// The guards that let a PAT-carrying git call run inside a working copy the
// coding agent controls (`guards()` in api/src/git.ts, `guardArgs()` in
// src/main/sync.ts).
//
// Why this is tested with REAL git rather than by asserting on the argv: the
// claim is not "we pass these flags", it is "git does not execute the agent's
// code while holding the token". Only git can settle that, and the flags are
// worthless if a version of git ignores one. So each test plants the attack,
// runs an actual push against a local bare repo, and checks whether the token
// leaked.
//
// The bug being pinned: the agent writes .git/hooks/pre-push (or a
// credential.helper into .git/config) in its own working directory. The server's
// push afterwards puts the PAT in the git child's environment, git runs the
// planted code, and it reads the token straight out of that environment. It
// survives `reset --hard` + `clean -fd` — neither touches .git — so it fires on
// every later push until the checkout ages out.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PAT = 'ghp_test_token_do_not_use';

/** A bare origin + a working clone with one commit, in a fresh temp dir. */
function scratchRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shockwave-gitguards-'));
  const origin = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  const git = (cwd, args) => execFileSync('git', args, { cwd, stdio: 'pipe' });

  execFileSync('git', ['init', '-q', '--bare', origin], { stdio: 'pipe' });
  execFileSync('git', ['init', '-q', work], { stdio: 'pipe' });
  git(work, ['config', 'user.email', 'test@example.com']);
  git(work, ['config', 'user.name', 'test']);
  fs.writeFileSync(path.join(work, 'a.txt'), 'hello\n');
  git(work, ['add', '-A']);
  git(work, ['commit', '-qm', 'first']);
  git(work, ['remote', 'add', 'origin', origin]);
  return { root, origin, work, git };
}

/** A shell snippet that writes the PAT it can see to `out`. */
function thief(out) {
  return `#!/bin/sh\nprintf '%s' "$GITHUB_PAT" > '${out}'\nexit 0\n`;
}

/** The production guards, mirrored. Kept in one place so a drift shows up as a
 *  failing test rather than a test that quietly stops covering anything. */
function guards(noHooks) {
  return [
    '-c', 'credential.helper=',
    '-c', 'credential.helper=!f() { echo username=x-access-token; echo password=$GITHUB_PAT; }; f',
    '-c', `core.hooksPath=${noHooks}`,
    '-c', 'core.fsmonitor=',
    '-c', 'core.sshCommand=',
    '-c', 'protocol.ext.allow=never',
  ];
}

/** Push with the PAT in the environment, exactly as the server does.
 *
 *  `guardArgs = null` reproduces the code as it shipped: no `-c` overrides and no
 *  `--no-verify`. Passing the guards adds BOTH, because production adds both —
 *  putting `--no-verify` in this helper unconditionally is what made the
 *  "unguarded" case silently guarded on the first run of this file. */
function push(work, guardArgs = null) {
  const pre = guardArgs ?? [];
  const noVerify = guardArgs ? ['--no-verify'] : [];
  try {
    execFileSync('git', [...pre, 'push', ...noVerify, '-q', 'origin', 'HEAD:refs/heads/main'], {
      cwd: work,
      env: { ...process.env, GITHUB_PAT: PAT, GIT_TERMINAL_PROMPT: '0' },
      stdio: 'pipe',
    });
  } catch { /* a blocked attack can also mean a failed push; the leak check is what matters */ }
}

test('UNGUARDED: a planted pre-push hook reads the token (the bug)', () => {
  const { root, work } = scratchRepo();
  const out = path.join(root, 'stolen');
  fs.writeFileSync(path.join(work, '.git', 'hooks', 'pre-push'), thief(out), { mode: 0o755 });

  push(work);

  assert.equal(fs.existsSync(out), true, 'expected the hook to run at all');
  assert.equal(fs.readFileSync(out, 'utf8'), PAT,
    'the hook read the PAT out of the push environment — this is the bug');
});

test('GUARDED: the same hook never runs', () => {
  const { root, work } = scratchRepo();
  const out = path.join(root, 'stolen');
  const noHooks = path.join(root, 'no-hooks');
  fs.mkdirSync(noHooks);
  fs.writeFileSync(path.join(work, '.git', 'hooks', 'pre-push'), thief(out), { mode: 0o755 });

  push(work, guards(noHooks));

  assert.equal(fs.existsSync(out), false, 'core.hooksPath + --no-verify must stop the hook');
});

test('GUARDED: a credential.helper planted in .git/config never runs', () => {
  // Consulted BEFORE any askpass, so this is a second route to the same
  // environment. `-c credential.helper=` resets the list, which is why the empty
  // assignment has to come first in guards().
  const { root, work, git } = scratchRepo();
  const out = path.join(root, 'stolen');
  const noHooks = path.join(root, 'no-hooks');
  fs.mkdirSync(noHooks);
  const helper = path.join(root, 'helper.sh');
  fs.writeFileSync(helper, thief(out), { mode: 0o755 });
  git(work, ['config', 'credential.helper', `!${helper}`]);

  push(work, guards(noHooks));

  assert.equal(fs.existsSync(out), false, 'a repo-configured credential helper must not run');
});

test('a hook survives reset --hard + clean -fd (why the guard, not cleanup, is the fix)', () => {
  // prepareCheckout reuses a checkout and brings it back to pristine with exactly
  // these two commands. Neither touches .git, so yesterday's hook is still armed.
  const { root, work, git } = scratchRepo();
  const hook = path.join(work, '.git', 'hooks', 'pre-push');
  fs.writeFileSync(hook, thief(path.join(root, 'stolen')), { mode: 0o755 });

  push(work, guards(fs.mkdtempSync(path.join(root, 'nh-'))));
  git(work, ['fetch', '-q', 'origin', 'main']);
  git(work, ['reset', '-q', '--hard', 'origin/main']);
  git(work, ['clean', '-qfd']);

  assert.equal(fs.existsSync(hook), true,
    'reset+clean leave .git alone — cleanup alone can never be the fix');
});

test('guards keep a normal push working', () => {
  // The guards must not cost the feature they protect.
  const { root, work, origin } = scratchRepo();
  const noHooks = path.join(root, 'no-hooks');
  fs.mkdirSync(noHooks);

  push(work, guards(noHooks));

  const refs = execFileSync('git', ['--git-dir', origin, 'log', '--oneline', 'main'], { encoding: 'utf8' });
  assert.match(refs, /first/, 'the commit must actually reach origin with the guards applied');
});
