// The clock for the two background processes: every few minutes, look for a chat
// that has done enough since it was last examined, and examine it.
//
//   review  — enough TOOL CALLS since last time → update the agent's skills
//   memory  — enough of YOUR MESSAGES since last time → update MEMORY.md / USER.md
//
// ── Two processes, one timer ────────────────────────────────────────────────
//
// They are separate in every way that decides an outcome: their own counter,
// their own high-water mark on the chat row, their own setting, their own
// instruction, their own tool set, their own chat. What they share is the alarm
// clock, and only the alarm clock.
//
// Sharing it is the whole guarantee. `protect: true` bounds a croner against
// ITSELF, not against a sibling — so two timers could wake in the same second
// and start two unattended agent runs against the same repo, which then push
// over each other and leave one resolving a conflict caused by the other. One
// timer that awaits its run makes that unrepresentable, with no lock for either
// side to forget to take.
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
// carries incremented counters precisely because it cannot count what actually
// happened.
//
// Separate croner from cron on purpose. A job somebody scheduled for 2am should
// fire at 2am rather than queue behind background maintenance; neither of these
// has a deadline and both can wait for anything.

import crypto from 'node:crypto';
import { Cron } from 'croner';
import type { PgPool } from './db.js';
import { getDb } from './db.js';
import * as store from './store.js';
import { runBackground, REVIEW, MEMORY } from './backgroundRun.js';
import { logger, errStr } from './log.js';

const log = logger('background');

/** Server tuning, like `CRON_REFRESH_SCHEDULE` — not a user setting. The numbers
 *  a user would want to change are the thresholds, and those are synced. */
const SCHEDULE = process.env.REVIEW_SCHEDULE || '*/5 * * * *';
const ENABLED = (process.env.REVIEW_ENABLED ?? 'true').toLowerCase() !== 'false';

/** Unset ⇒ 10 for both, read at the point of use: the companion stores no
 *  defaults, so an unset row must never look configured. hermes defaults both
 *  its equivalents to 10. */
const DEFAULT_INTERVAL = 10;

/** Unset ⇒ 5 minutes, read at the point of use for the same reason. */
const DEFAULT_QUIET_MINUTES = 5;

/**
 * A threshold, or 0 meaning the user turned that process off.
 *
 * 0 has to survive here rather than collapsing to the default — that is the
 * difference between "not configured" and "configured off", the same
 * distinction the checkout-pool size makes.
 */
function threshold(settings: any, field: 'reviewInterval' | 'memoryInterval'): number {
  const raw = Number(settings?.codingAgent?.[field]);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : DEFAULT_INTERVAL;
}

/**
 * How long a chat must have been quiet before either process may open it.
 *
 * ONE number for both, unlike the thresholds. The two processes measure
 * different work and so come due at different times, but "is the user still in
 * this conversation?" is a fact about the source chat, not about which pass is
 * asking — two knobs would be two answers to one question.
 *
 * 0 survives, and here it means "no wait" rather than "off": the thresholds are
 * what switch a process off, and this number can only ever delay one.
 */
function quietMs(settings: any): number {
  const raw = Number(settings?.codingAgent?.backgroundQuietMinutes);
  const minutes = Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_QUIET_MINUTES;
  return minutes * 60_000;
}

type Kind = 'review' | 'memory';
interface Candidate { kind: Kind; due: store.DueChat }

/**
 * One pass: find the single oldest thing owed, of either kind, and do it.
 *
 * Exactly one run per tick, across both processes. Several chats being due is
 * not a reason to start several unattended model runs at once — the backlog
 * drains a tick at a time, and nothing is waiting on it. Which one goes first is
 * decided by `oldest`, the timestamp of the earliest unexamined row, so a busy
 * process cannot starve a quiet one.
 */
export async function sweepOnce(pool: PgPool, key: Buffer, runtime: any): Promise<void> {
  const db = getDb(pool);
  // One settings read for both thresholds and the quiet window. Unreadable
  // settings must not wedge the loop, so a failure falls back to the defaults
  // rather than throwing.
  let settings: any = {};
  try { settings = await store.readSettings(db, key); } catch { /* defaults */ }

  const candidates: Candidate[] = [];
  const quiet = quietMs(settings);
  const reviewThreshold = threshold(settings, 'reviewInterval');
  if (reviewThreshold > 0) {
    const [due] = await store.chatsDueForReview(db, reviewThreshold, quiet, 1);
    if (due) candidates.push({ kind: 'review', due });
  }
  const memoryThreshold = threshold(settings, 'memoryInterval');
  if (memoryThreshold > 0) {
    const [due] = await store.chatsDueForMemory(db, memoryThreshold, quiet, 1);
    if (due) candidates.push({ kind: 'memory', due });
  }
  if (!candidates.length) return;

  candidates.sort((a, b) => a.due.oldest - b.due.oldest);
  const { kind, due } = candidates[0];
  const { chatId: sourceChatId, workspaceId, count, maxSeq } = due;

  // Move the mark BEFORE running, and only this process's own mark. A run that
  // throws must not leave the chat eligible on the very next tick — that would
  // retry a failing run every five minutes forever. The work is not lost:
  // whatever happens after this seq makes the chat due again in the normal way.
  if (kind === 'review') await store.setLastReviewedSeq(db, sourceChatId, maxSeq);
  else await store.setLastMemorySeq(db, sourceChatId, maxSeq);

  const runChatId = crypto.randomUUID();
  log.info({ kind, source: sourceChatId, ws: workspaceId, count, chatId: runChatId }, 'chat is due');

  try {
    const r = await runBackground(
      pool, key, runtime, kind === 'review' ? REVIEW : MEMORY,
      workspaceId, sourceChatId, runChatId,
    );
    if (r.checkIn === 'conflict' || r.checkIn === 'error') {
      log.error({ kind, source: sourceChatId, chatId: runChatId, checkIn: r.checkIn },
        'run finished but its changes did not reach GitHub');
    }
  } catch (e: any) {
    log.error({ kind, source: sourceChatId, chatId: runChatId, err: errStr(e) }, 'background run failed');
  }
}

export function initBackgroundSweeper(pool: PgPool, key: Buffer, runtime: any): void {
  if (!ENABLED) { log.info('background runs disabled (REVIEW_ENABLED=false)'); return; }
  // `protect` + awaiting inside the handler is what bounds this to one run.
  new Cron(SCHEDULE, { protect: true }, async () => {
    try {
      await sweepOnce(pool, key, runtime);
    } catch (e: any) {
      log.error({ err: errStr(e) }, 'background sweep failed');
    }
  });
  log.info({ schedule: SCHEDULE }, 'background sweeper started');
}
