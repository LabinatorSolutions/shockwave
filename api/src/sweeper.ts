// TTL sweep for per-run working dirs (git checkouts + pi scratch). We keep dirs
// keyed by chatId so a re-run can reuse them; this reclaims the ones that
// haven't been touched within the TTL window — the equivalent of knack's
// snapshot expiry, done ourselves since we use plain temp dirs. Runs on boot and
// then hourly (croner).

import fs from 'node:fs/promises';
import path from 'node:path';
import { Cron } from 'croner';
import { WORK_BASE } from './git.js';
import { RUNS_BASE, FILES_BASE } from './dataDirs.js';
import type { PgPool } from './db.js';
import { getDb } from './db.js';
import * as store from './store.js';
import { logger } from './log.js';

const log = logger('sweeper');
// How long an idle working dir survives. A synced setting rather than env, so the
// desktop's own scratch cleanup uses the same number and there is one place to
// change it. Unset ⇒ 1 day, read at the point of use — the companion stores no
// defaults, so an unset row must never look configured.
const DEFAULT_TTL_DAYS = 1;

async function ttlMs(pool: PgPool, key: Buffer): Promise<number> {
  let days = DEFAULT_TTL_DAYS;
  try {
    days = Number((await store.readSettings(getDb(pool), key))?.codingAgent?.scratchTtlDays) || DEFAULT_TTL_DAYS;
  } catch { /* unreadable settings must not stop the sweep */ }
  return days * 24 * 60 * 60 * 1000;
}

async function sweepBase(base: string, cutoff: number): Promise<number> {
  let removed = 0;
  let entries: string[];
  try { entries = await fs.readdir(base); } catch { return 0; } // base doesn't exist yet
  for (const name of entries) {
    const dir = path.join(base, name);
    try {
      const st = await fs.stat(dir);
      // mtime is bumped on reuse (fetch/reset/clean write into it), so an idle
      // dir ages out while an actively-reused one survives.
      if (st.mtimeMs < cutoff) { await fs.rm(dir, { recursive: true, force: true }); removed++; }
    } catch { /* vanished mid-sweep */ }
  }
  return removed;
}

export async function sweepOnce(pool: PgPool, key: Buffer): Promise<void> {
  const ms = await ttlMs(pool, key);
  const cutoff = Date.now() - ms;
  // The agent's scratch pad ages out on the same clock as the checkouts. What is
  // left there is by definition what nobody kept — anything worth keeping was
  // moved into the workspace and committed.
  const [a, b, c] = await Promise.all([
    sweepBase(WORK_BASE, cutoff), sweepBase(RUNS_BASE, cutoff), sweepBase(FILES_BASE, cutoff),
  ]);
  if (a + b + c) log.info({ checkouts: a, piScratch: b, scratchPads: c, ttlDays: ms / 86_400_000 }, 'swept stale run dirs');
}

export function initSweeper(pool: PgPool, key: Buffer): void {
  const run = () => sweepOnce(pool, key).catch((e) => log.error({ err: e?.message }, 'run-dir sweep failed'));
  run();
  new Cron('0 * * * *', run);
}
