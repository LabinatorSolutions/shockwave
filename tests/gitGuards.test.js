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

const CREDENTIAL_HELPER = '!f() { echo username=x-access-token; echo password=$GITHUB_PAT; }; f';

/** Not a directory. Git looks up `<hooksPath>/<hookname>`, and a path under the
 *  null device is ENOTDIR, so no hook is ever found — and unlike an empty
 *  directory there is nothing to keep empty. */
const NO_HOOKS = process.platform === 'win32' ? 'NUL' : '/dev/null';

/** The production guards, mirrored. Kept in one place so a drift shows up as a
 *  failing test rather than a test that quietly stops covering anything.
 *
 *  `originUrl` stands in for production's `remote.origin.url` pin: the URL is
 *  passed on the command line rather than read from a .git/config the agent can
 *  rewrite. Here it points at the test's local bare repo instead of GitHub. */
function guards(originUrl) {
  return [
    '-c', 'credential.helper=',
    '-c', `credential.https://github.com.helper=${CREDENTIAL_HELPER}`,
    ...(originUrl ? ['-c', `remote.origin.url=${originUrl}`] : []),
    '-c', `core.hooksPath=${NO_HOOKS}`,
    '-c', 'core.fsmonitor=',
    '-c', 'core.sshCommand=',
    '-c', 'protocol.ext.allow=never',
  ];
}

/** What git hands a credential helper, and what it gets back. `git credential
 *  fill` is the same lookup a push does, minus the network — so it settles
 *  "would the PAT go to this host" directly. */
function credentialFill(host) {
  try {
    return execFileSync('git', [...guards(), 'credential', 'fill'], {
      input: `protocol=https\nhost=${host}\n\n`,
      env: { ...process.env, GITHUB_PAT: PAT, GIT_TERMINAL_PROMPT: '0' },
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    // No helper answered and there is no terminal to prompt on — git exits
    // non-zero. That is the outcome we want for a host that isn't GitHub.
    return String(e?.stdout ?? '');
  }
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
  const { root, work, origin } = scratchRepo();
  const out = path.join(root, 'stolen');
  fs.writeFileSync(path.join(work, '.git', 'hooks', 'pre-push'), thief(out), { mode: 0o755 });

  push(work, guards(origin));

  assert.equal(fs.existsSync(out), false, 'core.hooksPath + --no-verify must stop the hook');
});

test('GUARDED: a hook planted where core.hooksPath points cannot exist', () => {
  // The guard used to name an EMPTY DIRECTORY, which is only empty until the
  // agent — same user, dir sitting beside its own checkout — drops a file in.
  // `--no-verify` covers pre-push and nothing else, so post-checkout (clone) and
  // reference-transaction (fetch) would still have fired with the PAT in env.
  // Pointing at the null device means the lookup is ENOTDIR, every time.
  assert.equal(fs.existsSync(NO_HOOKS), true, 'the null device must exist to be pointed at');
  assert.throws(() => fs.writeFileSync(path.join(NO_HOOKS, 'pre-push'), thief('/tmp/x')),
    'nothing can be placed under the null device — that is the whole property');
});

test('GUARDED: a credential.helper planted in .git/config never runs', () => {
  // Consulted BEFORE any askpass, so this is a second route to the same
  // environment. `-c credential.helper=` resets the list, which is why the empty
  // assignment has to come first in guards().
  const { root, work, git, origin } = scratchRepo();
  const out = path.join(root, 'stolen');
  const helper = path.join(root, 'helper.sh');
  fs.writeFileSync(helper, thief(out), { mode: 0o755 });
  git(work, ['config', 'credential.helper', `!${helper}`]);

  push(work, guards(origin));

  assert.equal(fs.existsSync(out), false, 'a repo-configured credential helper must not run');
});

test('the helper answers for github.com', () => {
  // Positive control: without this, the test below passes even if the helper is
  // registered under a name git never matches and sync is quietly broken.
  assert.match(credentialFill('github.com'), new RegExp(`password=${PAT}`),
    'a real GitHub push must still get the token');
});

test('the helper stays silent for any other host (the insteadOf redirect)', () => {
  // `url.<base>.insteadOf` in the workspace .git/config rewrites the URL AFTER we
  // pin remote.origin.url, and no `-c` can clear it — the subsection name is the
  // agent's to choose. So the push can leave for a host of its choosing. What
  // stops the token going with it is that the helper is registered for github.com
  // alone: git asks for evil.example's credentials and finds nobody to ask.
  // A bare `credential.helper` answered every host, because the helper echoes the
  // PAT without ever reading the host git hands it on stdin.
  assert.doesNotMatch(credentialFill('evil.example'), new RegExp(PAT),
    'a redirected request must not be answered with the token');
});

test('a hook survives reset --hard + clean -fd (why the guard, not cleanup, is the fix)', () => {
  // prepareCheckout reuses a checkout and brings it back to pristine with exactly
  // these two commands. Neither touches .git, so yesterday's hook is still armed.
  const { root, work, git, origin } = scratchRepo();
  const hook = path.join(work, '.git', 'hooks', 'pre-push');
  fs.writeFileSync(hook, thief(path.join(root, 'stolen')), { mode: 0o755 });

  push(work, guards(origin));
  git(work, ['fetch', '-q', 'origin', 'main']);
  git(work, ['reset', '-q', '--hard', 'origin/main']);
  git(work, ['clean', '-qfd']);

  assert.equal(fs.existsSync(hook), true,
    'reset+clean leave .git alone — cleanup alone can never be the fix');
});

test('guards keep a normal push working', () => {
  // The guards must not cost the feature they protect.
  const { work, origin } = scratchRepo();

  push(work, guards(origin));

  const refs = execFileSync('git', ['--git-dir', origin, 'log', '--oneline', 'main'], { encoding: 'utf8' });
  assert.match(refs, /first/, 'the commit must actually reach origin with the guards applied');
});
