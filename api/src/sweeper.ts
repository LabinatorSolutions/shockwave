// TTL sweep for per-run working dirs (git checkouts + pi scratch + scratch pad).
// We keep dirs keyed by chatId so a re-run can reuse them; this reclaims the
// ones that haven't been touched within the TTL window — the equivalent of
// knack's snapshot expiry, done ourselves since we use plain temp dirs. Runs on
// boot and then hourly (croner).
//
// The rule itself (age out, except pinned) lives in `agent-core/scratchSweep.ts`
// because the desktop sweeps its own scratch pad by the same rule and the two
// must not drift.

import { Cron } from 'croner';
import { sweepScratchDirs, resolveTtlDays } from '../../agent-core/scratchSweep.js';
import { WORK_BASE } from './git.js';
import { RUNS_BASE, FILES_BASE } from './dataDirs.js';
import type { PgPool } from './db.js';
import { getDb } from './db.js';
import * as store from './store.js';
import { logger } from './log.js';

const log = logger('sweeper');

// How long an idle working dir survives. A synced setting rather than env, so
// the desktop's own scratch cleanup uses the same number and there is one place
// to change it. Returned RAW (unset stays undefined) and resolved to a default
// inside the shared sweep — the companion stores no defaults, so an unset row
// must never look configured.
async function ttlDays(pool: PgPool, key: Buffer): Promise<unknown> {
  try {
    return (await store.readSettings(getDb(pool), key))?.codingAgent?.scratchTtlDays;
  } catch { return undefined; } // unreadable settings must not stop the sweep
}

export async function sweepOnce(pool: PgPool, key: Buffer): Promise<void> {
  // Unlike the settings read, a failed pinned lookup DOES stop the sweep: not
  // knowing which chats are protected is not the same as there being none, and
  // the cost of waiting an hour is disk we were going to spend anyway.
  let pinned: string[];
  try {
    pinned = await store.pinnedChatIds(getDb(pool));
  } catch (e: any) {
    log.warn({ err: e?.message }, 'skipping sweep — could not read pinned chats');
    return;
  }
  const days = await ttlDays(pool, key);
  // The agent's scratch pad ages out on the same clock as the checkouts. What is
  // left there is by definition what nobody kept — anything worth keeping was
  // moved into the workspace and committed, or the chat was pinned.
  const [a, b, c] = await sweepScratchDirs([WORK_BASE, RUNS_BASE, FILES_BASE], {
    ttlDays: days,
    keep: new Set(pinned),
  });
  if (a + b + c) {
    log.info({ checkouts: a, piScratch: b, scratchPads: c, ttlDays: resolveTtlDays(days), pinnedKept: pinned.length },
      'swept stale run dirs');
  }
}

export function initSweeper(pool: PgPool, key: Buffer): void {
  const run = () => sweepOnce(pool, key).catch((e) => log.error({ err: e?.message }, 'run-dir sweep failed'));
  run();
  new Cron('0 * * * *', run);
}
