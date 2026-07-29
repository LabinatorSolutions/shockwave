// TTL sweep for per-run working dirs (git checkouts + pi scratch). We keep dirs
// keyed by chatId so a re-run can reuse them; this reclaims the ones that
// haven't been touched within the TTL window — the equivalent of knack's
// snapshot expiry, done ourselves since we use plain temp dirs. Runs on boot and
// then hourly (croner).

import fs from 'node:fs/promises';
import path from 'node:path';
import { Cron } from 'croner';
import pino from 'pino';
import { WORK_BASE } from './git.js';
import { RUNS_BASE } from './agentHost.js';

const log = pino({ base: undefined });
const TTL_MS = (Number(process.env.RUN_DIR_TTL_DAYS) || 1) * 24 * 60 * 60 * 1000;

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

export async function sweepOnce(): Promise<void> {
  const cutoff = Date.now() - TTL_MS;
  const [a, b] = await Promise.all([sweepBase(WORK_BASE, cutoff), sweepBase(RUNS_BASE, cutoff)]);
  if (a + b) log.info({ checkouts: a, scratch: b, ttlDays: TTL_MS / 86_400_000 }, 'swept stale run dirs');
}

export function initSweeper(): void {
  sweepOnce().catch((e) => log.error({ err: e?.message }, 'run-dir sweep failed'));
  new Cron('0 * * * *', () => { sweepOnce().catch((e) => log.error({ err: e?.message }, 'run-dir sweep failed')); });
}
