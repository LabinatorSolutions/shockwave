// Server-side git for cron runs — plain `git` CLI, deterministic. Fresh shallow
// clone per run into a temp dir; after the turn, a separate check-in step commits
// and pushes what the agent changed; then the checkout is deleted. The PAT is
// embedded in the remote URL (never written to .git/config beyond the clone).
//
// Conflict recovery via a bounded git-fixer AGENT is a separate step (see plan) —
// this module is the deterministic happy path + one mechanical merge retry; it
// reports 'conflict' when that isn't enough, for the caller to hand off.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const exec = promisify(execFile);

export const WORK_BASE = process.env.CRON_WORK_DIR || path.join(os.tmpdir(), 'shockwave-cron');

function remoteUrl(owner: string, repo: string, pat: string): string {
  return `https://x-access-token:${pat}@github.com/${owner}/${repo}.git`;
}

async function git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return exec('git', args, { cwd, maxBuffer: 32 * 1024 * 1024 });
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
    // Reuse — refresh the remote (the PAT may have rotated) and reset to origin.
    await git(dir, ['remote', 'set-url', 'origin', remoteUrl(owner, repo, pat)]).catch(() => {});
    await git(dir, ['fetch', '--depth=1', 'origin', branch]);
    await git(dir, ['reset', '--hard', `origin/${branch}`]);
    await git(dir, ['clean', '-fd']);
    return dir;
  }

  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(path.dirname(dir), { recursive: true });
  await exec('git', ['clone', '--depth=1', '--branch', branch, remoteUrl(owner, repo, pat), dir], { maxBuffer: 32 * 1024 * 1024 });
  await git(dir, ['config', 'user.name', 'Shockwave Cron']);
  await git(dir, ['config', 'user.email', 'cron@shockwave.local']);
  return dir;
}

export type CheckInResult = 'clean' | 'pushed' | 'conflict' | 'error';

// Deterministic check-in. add -A; nothing staged → clean. Else commit, fetch,
// merge if the remote moved, push. One mechanical merge retry on non-fast-forward.
// Returns 'conflict' when a merge conflict remains (caller hands to the git-fixer).
export async function checkIn(dir: string, branch: string, message: string): Promise<CheckInResult> {
  try {
    await git(dir, ['add', '-A']);
    const { stdout: status } = await git(dir, ['status', '--porcelain']);
    if (!status.trim()) return 'clean';
    await git(dir, ['commit', '-m', message]);

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await git(dir, ['fetch', 'origin', branch]);
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
        await git(dir, ['push', 'origin', `HEAD:${branch}`]);
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
