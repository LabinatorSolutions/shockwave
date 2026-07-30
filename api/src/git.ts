// Server-side git for cron runs — plain `git` CLI, deterministic. Fresh shallow
// clone per run into a temp dir; after the turn, a separate check-in step commits
// and pushes what the agent changed; then the checkout is deleted.
//
// The PAT is NEVER in the remote URL — it goes to one child process at a time via
// GIT_ASKPASS, and the URL in .git/config stays plain. See the note above
// remoteUrl below, and gitRemote.js.
//
// Conflict recovery via a bounded git-fixer AGENT is a separate step: this module
// is the deterministic happy path + one mechanical merge retry, and reports
// 'conflict' when that isn't enough for the caller to hand off. The fixer holds no
// credentials — it commits, and syncAndPush here does the pushing.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { remoteUrl } from './gitRemote.js';

const exec = promisify(execFile);

export const WORK_BASE = process.env.CRON_WORK_DIR || path.join(os.tmpdir(), 'shockwave-cron');

// Plain remote — NO credentials. `git clone <url>` and `git remote set-url` both
// persist whatever URL they're given into <dir>/.git/config, and <dir> is the
// agent's own working directory for the turn, so a PAT embedded here is a file
// the agent can simply read (`git remote -v`). That hands it write access to
// every repo the token covers, and the checkout outlives the run by
// RUN_DIR_TTL_DAYS. Auth goes through GIT_ASKPASS instead — same approach the
// desktop already uses (src/main/sync.ts) — so the PAT lives in one child
// process's environment and never touches disk.
//
// The builder is pure and unit-tested (gitRemote.js), so the "no credentials in
// the URL" property is pinned by a test rather than by this comment.

// ── Carrying the PAT safely into a working copy the agent controls ──────────
//
// The PAT lives in ONE child process's environment, for one git call. That
// environment is readable by ANYTHING git decides to execute — and the working
// copy git runs in is the agent's own cwd for the turn, so the agent chooses
// what git finds there. Each guard below closes one of those:
//
//   .git/hooks/pre-push        git runs it on every push, with our env
//                              → core.hooksPath at an empty dir, plus --no-verify
//   credential.helper in config  consulted BEFORE any askpass
//                              → `-c credential.helper=` resets the list, then ours
//   core.fsmonitor             names a command git runs to check the worktree
//   core.sshCommand            same, for transports we don't use but shouldn't leave open
//   remote.origin.url          can be `ext::sh -c …`, which is a command
//                              → we pass the URL on the command line, never a remote name
//
// There is no on-disk askpass helper any more. It was a script at a fixed path,
// owned by the same user the agent runs as, that git executed with the PAT in its
// environment — i.e. a file the agent could rewrite to capture the token, once,
// and have fire on every push afterwards. The credential helper below is passed
// as an argument instead, so there is nothing on disk to tamper with.
//
// `tests/gitGuards.test.js` plants a real hook and runs a real push.

/** Answers git's credential prompt from the env var set on that one call. Passed
 *  on the command line — never written to disk, never into .git/config. */
const CREDENTIAL_HELPER = '!f() { echo username=x-access-token; echo password=$GITHUB_PAT; }; f';

/** An empty directory. Pointing core.hooksPath here means no hook runs, from any
 *  source, without deleting anything of the user's. */
const NO_HOOKS = path.join(WORK_BASE, '.no-hooks');
let noHooksReady: Promise<void> | null = null;
function ensureNoHooks(): Promise<void> {
  noHooksReady ??= fs.mkdir(NO_HOOKS, { recursive: true }).then(() => undefined);
  return noHooksReady;
}

/** What a network git call needs: the token, and the repo it is allowed to reach. */
export interface GitAuth { pat: string; owner: string; repo: string }

/** Config overrides that must precede EVERY git call carrying the PAT.
 *
 *  Command-line `-c` beats repository config, which is the whole point — every
 *  value here is one the agent could otherwise set in `.git/config`. The empty
 *  `credential.helper` comes first because the setting is a LIST: assigning empty
 *  resets it, so a helper planted in the repo can't run ahead of ours.
 *
 *  `remote.origin.url` is pinned for the same reason. Left to the repo, it can be
 *  `ext::sh -c …`, which is a command, not an address. Pinning it here also means
 *  the refs stay `origin/<branch>` — passing a bare URL would land the result in
 *  FETCH_HEAD and quietly change what the merge below compares against. */
export function guards({ owner, repo }: GitAuth): string[] {
  return [
    '-c', 'credential.helper=',
    '-c', `credential.helper=${CREDENTIAL_HELPER}`,
    '-c', `remote.origin.url=${remoteUrl(owner, repo)}`,
    '-c', `core.hooksPath=${NO_HOOKS}`,
    '-c', 'core.fsmonitor=',
    '-c', 'core.sshCommand=',
  ];
}

/** Child env carrying the PAT for exactly one git invocation. */
export function gitEnv(pat: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GITHUB_PAT: pat,
    GIT_TERMINAL_PROMPT: '0', // never block on a TTY prompt from a background child
  };
}

async function git(cwd: string, args: string[], auth?: GitAuth): Promise<{ stdout: string; stderr: string }> {
  if (!auth) return exec('git', args, { cwd, maxBuffer: 32 * 1024 * 1024 });
  await ensureNoHooks();
  return exec('git', [...guards(auth), ...args], {
    cwd, maxBuffer: 32 * 1024 * 1024, env: gitEnv(auth.pat),
  });
}

// Prepare a checkout for a run, keyed by chatId. If the dir already exists
// (a prior run of this chat), REUSE it — but bring it to a pristine, up-to-date
// state first: fetch + reset --hard + clean, so no stale files or half-committed
// work carries over. Otherwise a fresh shallow clone. The dir is kept after the
// run (the TTL sweeper reclaims old ones) so a re-run can reuse it. Mirrors
// knack's init/fetch/reset reuse.
export async function prepareCheckout(
  chatId: string,
  owner: string, repo: string, branch: string, pat: string,
): Promise<string> {
  const dir = path.join(WORK_BASE, chatId);
  const auth: GitAuth = { pat, owner, repo };
  const hasGit = await fs.access(path.join(dir, '.git')).then(() => true).catch(() => false);

  if (hasGit) {
    // Reuse — normalize the remote (an older checkout may still carry a
    // credential-bearing URL in .git/config) and reset to origin.
    await git(dir, ['remote', 'set-url', 'origin', remoteUrl(owner, repo)]).catch(() => {});
    // A hook planted on a previous run survives reset --hard and clean -fd —
    // neither touches .git — so it would fire on the next push. The hooksPath
    // guard already neuters it; removing it means it isn't sitting there waiting
    // for a call that forgets the guard.
    await fs.rm(path.join(dir, '.git', 'hooks'), { recursive: true, force: true }).catch(() => {});
    await git(dir, ['fetch', '--depth=1', 'origin', branch], auth);
    await git(dir, ['reset', '--hard', `origin/${branch}`]);
    await git(dir, ['clean', '-fd']);
    return dir;
  }

  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(path.dirname(dir), { recursive: true });
  await ensureNoHooks();
  await exec('git', [...guards(auth), 'clone', '--depth=1', '--branch', branch, remoteUrl(owner, repo), dir], {
    maxBuffer: 32 * 1024 * 1024,
    env: gitEnv(pat),
  });
  await git(dir, ['config', 'user.name', 'Shockwave Cron']);
  await git(dir, ['config', 'user.email', 'cron@shockwave.local']);
  return dir;
}

export type CheckInResult = 'clean' | 'pushed' | 'conflict' | 'error';

// Deterministic check-in. add -A; nothing staged → clean. Else commit, fetch,
// merge if the remote moved, push. One mechanical merge retry on non-fast-forward.
// Returns 'conflict' when a merge conflict remains (caller hands to the git-fixer).
export async function checkIn(dir: string, branch: string, message: string, auth: GitAuth): Promise<CheckInResult> {
  try {
    await git(dir, ['add', '-A']);
    const { stdout: status } = await git(dir, ['status', '--porcelain']);
    if (!status.trim()) return 'clean';
    // No token on the commit, so a pre-commit hook gets nothing worth having —
    // but --no-verify anyway, because a hook that can rewrite the tree between
    // `add -A` and the commit changes what we are about to push.
    await git(dir, ['commit', '--no-verify', '-m', message]);
    return await syncAndPush(dir, branch, auth);
  } catch {
    return 'error';
  }
}

// Fetch, merge if the remote moved, push. One mechanical retry on
// non-fast-forward. Split out of checkIn because the git-fixer path needs it on
// its own: the fixer resolves and commits with NO credentials, and the push is
// done here afterwards, deterministically.
export async function syncAndPush(dir: string, branch: string, auth: GitAuth): Promise<CheckInResult> {
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await git(dir, ['fetch', 'origin', branch], auth);
        const { stdout: behind } = await git(dir, ['rev-list', '--count', `HEAD..origin/${branch}`]);
        if (Number(behind.trim()) > 0) {
          try {
            await git(dir, ['merge', '--no-edit', '--no-verify', `origin/${branch}`]);
          } catch {
            // Unresolved conflict markers left in the tree → hand off.
            const { stdout: unmerged } = await git(dir, ['diff', '--name-only', '--diff-filter=U']);
            if (unmerged.trim()) return 'conflict';
          }
        }
        // --no-verify belts the hooksPath guard: two independent things would both
        // have to be wrong for a planted pre-push hook to see the token.
        await git(dir, ['push', '--no-verify', 'origin', `HEAD:${branch}`], auth);
        return 'pushed';
      } catch (e: any) {
        // Non-fast-forward (someone pushed between fetch and push) → retry once.
        if (/non-fast-forward|fetch first|rejected/i.test(String(e?.stderr || e))) continue;
        throw e;
      }
    }
    return 'conflict';
  } catch {
    return 'error';
  }
}

export async function cleanup(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => { /* best-effort */ });
}
