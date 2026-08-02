// The trigger for self-improvement runs: every few minutes, look for a chat
// that has done enough work since it was last reviewed, and review it.
//
// ── Why this lives on the companion ─────────────────────────────────────────
//
// Turns happen three ways — a desktop chat, a Telegram message, a cron job —
// across two processes. Only the companion sees all of them, because every
// turn's messages land in its `message` table whoever ran it. Hooking the end of
// a turn instead would mean implementing this twice and having it never fire
// while the desktop is closed.
//
// It also means there is no counter to keep. "How much has happened since we
// last looked" is a count of rows past a mark on the chat, which cannot drift,
// survives restarts, and is identical whichever client produced the work. hermes
// and knack both carry an incremented counter precisely because neither can
// count what actually happened.
//
// ── One run at a time ───────────────────────────────────────────────────────
//
// The tick is a croner with `protect: true` and it AWAITS the run, so a tick
// that arrives while a review is going is skipped — the same mechanism
// `scheduler.ts` uses to stop a cron job overlapping itself. One review is in
// flight at most, which is why a review's claim on the warm-checkout queue is
// lighter than cron's: cron can fire several jobs at once, this cannot.
//
// Separate croner from cron on purpose. A job somebody scheduled for 2am should
// fire at 2am rather than queue behind background maintenance; a review has no
// deadline and can wait for anything.

import crypto from 'node:crypto';
import { Cron } from 'croner';
import type { PgPool } from './db.js';
import { getDb } from './db.js';
import * as store from './store.js';
import { runReview } from './reviewRun.js';
import { logger, errStr } from './log.js';

const log = logger('review');

/** Server tuning, like `CRON_REFRESH_SCHEDULE` — not a user setting. The number
 *  a user would want to change is the threshold, and that one is synced. */
const SCHEDULE = process.env.REVIEW_SCHEDULE || '*/5 * * * *';
const ENABLED = (process.env.REVIEW_ENABLED ?? 'true').toLowerCase() !== 'false';

/** Tool calls a chat must accumulate before it is reviewed. Unset ⇒ 10, read at
 *  the point of use: the companion stores no defaults, so an unset row must
 *  never look configured. hermes and knack both default to 10. */
const DEFAULT_INTERVAL = 10;

/** The threshold, or 0 meaning the user turned self-improvement off. 0 has to
 *  survive here rather than collapsing to the default — that is the difference
 *  between "not configured" and "configured off", and the same distinction the
 *  checkout-pool size makes. */
async function reviewInterval(pool: PgPool, key: Buffer): Promise<number> {
  try {
    const raw = Number((await store.readSettings(getDb(pool), key))?.codingAgent?.reviewInterval);
    return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : DEFAULT_INTERVAL;
  } catch {
    return DEFAULT_INTERVAL; // unreadable settings must not wedge the loop
  }
}

/**
 * One pass: find the oldest chat that is due and review it.
 *
 * Exactly one run per tick. Several chats being due is not a reason to start
 * several unattended model runs at once — the backlog drains a tick at a time,
 * and nothing is waiting on it.
 */
export async function sweepOnce(pool: PgPool, key: Buffer, runtime: any): Promise<void> {
  const db = getDb(pool);
  const threshold = await reviewInterval(pool, key);
  if (threshold === 0) return; // turned off

  const due = await store.chatsDueForReview(db, threshold, 1);
  if (!due.length) return;

  const { chatId: sourceChatId, workspaceId, toolCalls, maxSeq } = due[0];

  // Move the mark BEFORE running. A run that throws must not leave this chat
  // eligible on the very next tick — that would retry a failing review every
  // five minutes forever. The work is not lost: whatever happens after this seq
  // makes the chat due again in the normal way.
  await store.setLastReviewedSeq(db, sourceChatId, maxSeq);

  const reviewChatId = crypto.randomUUID();
  log.info({ source: sourceChatId, ws: workspaceId, toolCalls, threshold, chatId: reviewChatId }, 'chat is due for review');

  try {
    const r = await runReview(pool, key, runtime, workspaceId, sourceChatId, reviewChatId);
    if (r.checkIn === 'conflict' || r.checkIn === 'error') {
      log.error({ source: sourceChatId, chatId: reviewChatId, checkIn: r.checkIn },
        'review ran but its changes did not reach GitHub');
    }
  } catch (e: any) {
    log.error({ source: sourceChatId, chatId: reviewChatId, err: errStr(e) }, 'review run failed');
  }
}

export function initReviewSweeper(pool: PgPool, key: Buffer, runtime: any): void {
  if (!ENABLED) { log.info('self-improvement reviews disabled (REVIEW_ENABLED=false)'); return; }
  // `protect` + awaiting inside the handler is what bounds this to one run.
  new Cron(SCHEDULE, { protect: true }, async () => {
    try {
      await sweepOnce(pool, key, runtime);
    } catch (e: any) {
      log.error({ err: errStr(e) }, 'review sweep failed');
    }
  });
  log.info({ schedule: SCHEDULE }, 'self-improvement sweeper started');
}
