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

// GIT_ASKPASS helper: git runs it and reads the first stdout line. Answers the
// username prompt with x-access-token and everything else with the PAT from the
// env var set on that one spawn. The script itself holds no secret.
const ASKPASS_DIR = path.join(os.tmpdir(), 'shockwave-git');
const ASKPASS = path.join(ASKPASS_DIR, 'askpass.sh');
let askpassReady: Promise<string> | null = null;

function ensureAskpass(): Promise<string> {
  askpassReady ??= (async () => {
    await fs.mkdir(ASKPASS_DIR, { recursive: true });
    await fs.writeFile(
      ASKPASS,
      '#!/bin/sh\ncase "$1" in\n  Username*) echo "x-access-token" ;;\n  *)         echo "$GITHUB_PAT" ;;\nesac\n',
      { mode: 0o700 },
    );
    await fs.chmod(ASKPASS, 0o700);
    return ASKPASS;
  })();
  return askpassReady;
}

/** Child env carrying the PAT for exactly one git invocation. */
export async function gitEnv(pat: string): Promise<NodeJS.ProcessEnv> {
  return {
    ...process.env,
    GITHUB_PAT: pat,
    GIT_ASKPASS: await ensureAskpass(),
    GIT_TERMINAL_PROMPT: '0', // never block on a TTY prompt from a background child
  };
}

async function git(cwd: string, args: string[], pat?: string): Promise<{ stdout: string; stderr: string }> {
  const env = pat ? await gitEnv(pat) : undefined;
  return exec('git', args, { cwd, maxBuffer: 32 * 1024 * 1024, ...(env ? { env } : {}) });
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
  const hasGit = await fs.access(path.join(dir, '.git')).then(() => true).catch(() => false);

  if (hasGit) {
    // Reuse — normalize the remote (an older checkout may still carry a
    // credential-bearing URL in .git/config) and reset to origin.
    await git(dir, ['remote', 'set-url', 'origin', remoteUrl(owner, repo)]).catch(() => {});
    await git(dir, ['fetch', '--depth=1', 'origin', branch], pat);
    await git(dir, ['reset', '--hard', `origin/${branch}`]);
    await git(dir, ['clean', '-fd']);
    return dir;
  }

  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(path.dirname(dir), { recursive: true });
  await exec('git', ['clone', '--depth=1', '--branch', branch, remoteUrl(owner, repo), dir], {
    maxBuffer: 32 * 1024 * 1024,
    env: await gitEnv(pat),
  });
  await git(dir, ['config', 'user.name', 'Shockwave Cron']);
  await git(dir, ['config', 'user.email', 'cron@shockwave.local']);
  return dir;
}

export type CheckInResult = 'clean' | 'pushed' | 'conflict' | 'error';

// Deterministic check-in. add -A; nothing staged → clean. Else commit, fetch,
// merge if the remote moved, push. One mechanical merge retry on non-fast-forward.
// Returns 'conflict' when a merge conflict remains (caller hands to the git-fixer).
export async function checkIn(dir: string, branch: string, message: string, pat: string): Promise<CheckInResult> {
  try {
    await git(dir, ['add', '-A']);
    const { stdout: status } = await git(dir, ['status', '--porcelain']);
    if (!status.trim()) return 'clean';
    await git(dir, ['commit', '-m', message]);
    return await syncAndPush(dir, branch, pat);
  } catch {
    return 'error';
  }
}

// Fetch, merge if the remote moved, push. One mechanical retry on
// non-fast-forward. Split out of checkIn because the git-fixer path needs it on
// its own: the fixer resolves and commits with NO credentials, and the push is
// done here afterwards, deterministically.
export async function syncAndPush(dir: string, branch: string, pat: string): Promise<CheckInResult> {
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await git(dir, ['fetch', 'origin', branch], pat);
        const { stdout: behind } = await git(dir, ['rev-list', '--count', `HEAD..origin/${branch}`]);
        if (Number(behind.trim()) > 0) {
          try {
            await git(dir, ['merge', '--no-edit', `origin/${branch}`]);
          } catch {
            // Unresolved conflict markers left in the tree → hand off.
            const { stdout: unmerged } = await git(dir, ['diff', '--name-only', '--diff-filter=U']);
            if (unmerged.trim()) return 'conflict';
          }
        }
        await git(dir, ['push', 'origin', `HEAD:${branch}`], pat);
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
