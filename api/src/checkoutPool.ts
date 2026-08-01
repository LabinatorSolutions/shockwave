// A small queue of workspace checkouts, cloned ahead of time so starting a new
// Telegram chat doesn't begin with a download the user waits through.
//
// ── A folder's LOCATION is its state ────────────────────────────────────────
//
//   pool/setup/<owner>__<repo>__<branch>__<uuid>   being cloned — never read
//   pool/ready/<owner>__<repo>__<branch>__<uuid>   complete, usable
//   work/<chatId>                                  claimed; a chat owns it
//
// Movement is always a rename, and always forward. There is no marker file, no
// status column, and nothing that can disagree with what is on disk: a clone
// that dies halfway is stranded in `setup/` and can never be mistaken for
// usable, because being in `ready/` is what "usable" means.
//
// Renames are what make this safe as well as fast. `rename` within one
// filesystem is atomic, so two chats claiming at the same moment cannot get the
// same folder — one wins, the other gets ENOENT and takes the next or clones.
// No locks. (All three directories live under DATA_BASE for exactly this reason;
// across filesystems `rename` fails and the property is gone.)
//
// ── Nothing a turn does refills the queue ───────────────────────────────────
//
// Claiming is the ONLY thing a turn does here, and it has no side effects: take
// a folder or don't. Restocking, refreshing and cleaning are one periodic tick
// that reconciles the directory to the target — so the queue can be reasoned
// about on its own, and a turn can never be slowed down by maintenance work.
//
// ── Telegram only ───────────────────────────────────────────────────────────
//
// Cron clones its own, exactly as before. It fires far more often than a new
// chat starts, so letting it claim would mean the folder is usually gone by the
// time a person needs one — and nothing is waiting on a scheduled run.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Cron } from 'croner';
import { DATA_BASE } from './dataDirs.js';
import { cloneFresh, refreshPristine } from './git.js';
import type { DB } from './db.js';
import { getDb } from './db.js';
import * as store from './store.js';
import { logger, errStr } from './log.js';

const log = logger('pool');

const POOL_BASE = path.join(DATA_BASE, 'pool');
const SETUP = path.join(POOL_BASE, 'setup');
const READY = path.join(POOL_BASE, 'ready');

/** Unset ⇒ one spare. 0 disables the queue (claims then always fall through to
 *  a clone, i.e. the behaviour before this existed). The companion stores no
 *  defaults, so this is read at the point of use. */
const DEFAULT_SIZE = 1;
/** How old a ready folder may get before the tick brings it up to date. Only
 *  affects how much the claim's own fetch has to pull. */
const DEFAULT_REFRESH_MINUTES = 60;
/** A clone still in `setup/` after this long is a dead one. Generous: a first
 *  clone of a large workspace is legitimately slow. */
const SETUP_STALE_MS = 30 * 60_000;

const TICK_SCHEDULE = '* * * * *';

export interface PoolTarget { owner: string; repo: string; branch: string; pat: string }

// One tick at a time. The tick clones, which takes minutes on a big repo, and a
// second one starting underneath it would work from a stale count and
// double-stock.
let ticking = false;

const slotPrefix = (t: PoolTarget) => `${t.owner}__${t.repo}__${t.branch}__`;
const isFor = (name: string, t: PoolTarget) => name.startsWith(slotPrefix(t));

async function listDir(dir: string): Promise<string[]> {
  try { return await fs.readdir(dir); } catch { return []; } // not created yet
}

const rm = (p: string) => fs.rm(p, { recursive: true, force: true }).catch(() => { /* best-effort */ });

/**
 * Take a ready folder for this chat, if one is waiting.
 *
 * Returns true when `dest` now holds a checkout. Never throws and never blocks
 * on anything but a rename: a caller that gets false simply clones, which is
 * what it did before the queue existed.
 */
export async function claimCheckout(t: Omit<PoolTarget, 'pat'>, dest: string): Promise<boolean> {
  const target = { ...t, pat: '' };
  for (const name of await listDir(READY)) {
    if (!isFor(name, target)) continue;
    try {
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.rename(path.join(READY, name), dest);
      log.info({ dest }, 'claimed a warm checkout');
      return true;
    } catch {
      // Someone else took it between the listing and the rename, or the rename
      // isn't possible. Try the next one.
    }
  }
  return false;
}

/** Which repo the queue should hold folders for: whatever Telegram is pointed
 *  at. Null when Telegram isn't set up, no workspace exists, or there's no PAT
 *  to clone with — in every case the answer is "hold nothing". */
async function resolveTarget(pool: DB, key: Buffer): Promise<PoolTarget | null> {
  const db = getDb(pool);
  const acc = await store.getTelegramAccount(db);
  if (!acc?.enabled) return null;
  const all = await store.listWorkspaces(db);
  const ws = all.find((w) => w.id === acc.activeWorkspaceId) ?? all[0];
  if (!ws) return null;
  const pat = await store.getSecret(db, key, 'settings', 'sync.pat');
  if (!pat) return null;
  return { owner: ws.repoOwner, repo: ws.repoName, branch: ws.defaultBranch, pat };
}

async function settings(pool: DB, key: Buffer): Promise<{ size: number; refreshMs: number }> {
  try {
    const ca = (await store.readSettings(getDb(pool), key))?.codingAgent ?? {};
    const rawSize = Number(ca.checkoutPoolSize);
    const rawRefresh = Number(ca.checkoutPoolRefreshMinutes);
    return {
      size: Number.isFinite(rawSize) && rawSize >= 0 ? Math.floor(rawSize) : DEFAULT_SIZE,
      refreshMs: (Number.isFinite(rawRefresh) && rawRefresh > 0 ? rawRefresh : DEFAULT_REFRESH_MINUTES) * 60_000,
    };
  } catch {
    return { size: DEFAULT_SIZE, refreshMs: DEFAULT_REFRESH_MINUTES * 60_000 };
  }
}

/**
 * Reconcile the queue to what it should be. Everything that isn't claiming
 * happens here, and nothing outside calls it.
 */
export async function tick(pool: DB, key: Buffer): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const target = await resolveTarget(pool, key);
    const { size, refreshMs } = await settings(pool, key);

    // Abandoned clones. Being in setup/ at all means unfinished, so age is the
    // only question.
    const now = Date.now();
    for (const name of await listDir(SETUP)) {
      const p = path.join(SETUP, name);
      const st = await fs.stat(p).catch(() => null);
      if (!st || now - st.mtimeMs > SETUP_STALE_MS) await rm(p);
    }

    // Nothing to hold — Telegram is off, unconfigured, or the queue is disabled.
    if (!target || size === 0) {
      for (const name of await listDir(READY)) await rm(path.join(READY, name));
      return;
    }

    // Folders for a repo we no longer care about (the active workspace moved).
    let ready: string[] = [];
    for (const name of await listDir(READY)) {
      if (isFor(name, target)) ready.push(name);
      else await rm(path.join(READY, name));
    }

    // Bring stale ones up to date. A folder that won't refresh is discarded
    // rather than repaired — a fresh clone is cheap here and always correct,
    // and nothing is waiting on it.
    for (const name of [...ready]) {
      const p = path.join(READY, name);
      const st = await fs.stat(p).catch(() => null);
      if (!st) { ready = ready.filter((n) => n !== name); continue; }
      if (now - st.mtimeMs < refreshMs) continue;
      try {
        await refreshPristine(p, target.owner, target.repo, target.branch, target.pat);
      } catch (e: any) {
        log.warn({ slot: name, err: errStr(e) }, 'ready checkout would not refresh — discarding');
        await rm(p);
        ready = ready.filter((n) => n !== name);
      }
    }

    // Restock. One at a time: a tick that cloned several at once would hold the
    // lock for as many clones, and the next tick is a minute away.
    if (ready.length < size) {
      const name = `${slotPrefix(target)}${crypto.randomUUID()}`;
      const staging = path.join(SETUP, name);
      try {
        await fs.mkdir(SETUP, { recursive: true });
        await cloneFresh(staging, target.owner, target.repo, target.branch, target.pat);
        await fs.mkdir(READY, { recursive: true });
        // Only NOW is it usable, and the rename is what says so.
        await fs.rename(staging, path.join(READY, name));
        log.info({ have: ready.length + 1, want: size }, 'stocked a warm checkout');
      } catch (e: any) {
        log.warn({ err: errStr(e) }, 'could not stock a warm checkout');
        await rm(staging);
      }
    }
  } catch (e: any) {
    log.error({ err: errStr(e) }, 'checkout pool tick failed');
  } finally {
    ticking = false;
  }
}

export function initCheckoutPool(pool: DB, key: Buffer): void {
  // Anything in setup/ predates this process, so by definition its clone died.
  void rm(SETUP);
  const run = () => { void tick(pool, key); };
  run();
  new Cron(TICK_SCHEDULE, run);
  log.info({ schedule: TICK_SCHEDULE }, 'checkout pool started');
}
