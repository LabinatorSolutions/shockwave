// The TTL sweep for per-chat working directories, shared by both hosts.
//
// The desktop keeps one such base (`<userData>/agent-scratch`) and the companion
// keeps three (`work/`, `runs/`, `files/`), but the rule is identical on both
// sides and must stay that way: a directory whose chat is pinned is never
// deleted, and everything else goes once it has been idle for the TTL. Two
// copies of that rule is how the two sides drift into deleting different things
// on the same setting — so it lives here, in the only tree bundled into both
// builds, next to `credentials.ts` for the same reason.
//
// Directories are keyed by chatId (the directory NAME is the chat id), which is
// what makes the pinned exemption a set-membership test rather than a lookup.

import fs from 'node:fs/promises';
import path from 'node:path';

// The setting is `codingAgent.scratchTtlDays`; unset ⇒ this. A week rather than
// a day because the dirs a sweep reclaims are also the ones a chat resumed
// mid-week wants back — a re-clone and a re-parse, plus scratch-pad files that
// exist nowhere else. Disk is the cheaper side of that trade.
export const DEFAULT_SCRATCH_TTL_DAYS = 7;

/** The setting as a usable number of days. Unset, 0, or junk ⇒ the default. */
export function resolveTtlDays(value: unknown): number {
  const n = Number(value);
  return n > 0 ? n : DEFAULT_SCRATCH_TTL_DAYS;
}

export type SweepOpts = {
  /**
   * Days a directory survives with no activity — the raw setting value, since
   * both callers read it straight off `codingAgent.scratchTtlDays` where unset
   * is a real state. Resolved here so neither has to.
   */
  ttlDays: unknown;
  /** Chat ids that are never swept, whatever their age — the pinned chats. */
  keep: ReadonlySet<string>;
};

/**
 * Delete every directory under `bases` that is older than the TTL and not
 * pinned. Returns how many were removed per base, in the order given.
 *
 * mtime-based: reuse bumps it (a fetch/reset/clean, a file the agent writes), so
 * an actively-used chat survives and an abandoned one ages out. A base that
 * doesn't exist yet contributes 0, and an entry that vanishes mid-sweep is not
 * an error — another process (a chat delete) getting there first is the normal
 * race, not a fault.
 */
export async function sweepScratchDirs(bases: readonly string[], opts: SweepOpts): Promise<number[]> {
  const cutoff = Date.now() - resolveTtlDays(opts.ttlDays) * 24 * 60 * 60 * 1000;
  return Promise.all(bases.map((base) => sweepBase(base, cutoff, opts.keep)));
}

async function sweepBase(base: string, cutoff: number, keep: ReadonlySet<string>): Promise<number> {
  let entries: string[];
  try { entries = await fs.readdir(base); } catch { return 0; } // base doesn't exist yet
  let removed = 0;
  for (const name of entries) {
    if (keep.has(name)) continue; // pinned chat — age is irrelevant
    const dir = path.join(base, name);
    try {
      if ((await fs.stat(dir)).mtimeMs >= cutoff) continue;
      await fs.rm(dir, { recursive: true, force: true });
      removed++;
    } catch { /* vanished mid-sweep */ }
  }
  return removed;
}
