// What a scheduled job has to look like before it is written to `cron.json`.
//
// Pure — no disk, no host, one import. Same split as `skillValidate.ts` beside
// `manageSkill.ts`: the rules are the part worth testing, the writing is not.
//
// ── Why this exists ─────────────────────────────────────────────────────────
//
// `cron.json` is hand-writable and nothing checked it. Every way of getting it
// wrong failed the same way — silently, with the job still listed as scheduled:
//
//   - A schedule that doesn't parse throws inside the scheduler's `new Cron(...)`,
//     is caught, and becomes a `log.warn` on a server nobody is reading. The job
//     never registers and the panel shows it as normal.
//   - A datetime that has already passed does NOT throw. croner accepts it and
//     reports `nextRun() === null` — so the registration exists, nothing ever
//     fires, and not even a warning is logged. This is the one that matters,
//     because it is the ordinary one-time reminder: the agent is told today's
//     DATE but never the time of day, so "remind me at 6:50" written in the
//     evening lands in the morning that already happened.
//   - A job with no prompt registers fine and throws at every fire, forever
//     (`scheduler.ts` checks name and schedule; `cronRun.ts` is what needs the
//     prompt).
//
// So validity is two questions, not one: does it parse, and will it ever fire.
// A parser alone answers the first and silently passes the second.
//
// ── croner is the same library the scheduler runs ───────────────────────────
//
// Deliberately the same one, added to the desktop's manifest so `agent-core`
// resolves it in both builds (`tests/sharedDeps.test.js` pins the versions
// matching). A second parser would answer "is this valid" differently from the
// thing that actually fires it, which is worse than not checking.

import { Cron } from 'croner';

export interface CronJob {
  name: string;
  schedule: string;
  prompt: string;
  enabled?: boolean;
  once?: boolean;
}

export interface ScheduleCheck {
  ok: boolean;
  /** Why it was refused — written for the agent to act on, not to log. */
  error?: string;
  /** Epoch ms of the next few fires. Empty when it will never fire again. */
  nextRuns: number[];
  /** True when the schedule is a one-time datetime rather than a repeating
   *  pattern. The caller sets `once` from this rather than asking the agent to
   *  remember it — see `normalizeJob`. */
  oneTime: boolean;
}

/** A schedule that is a fixed moment rather than a repeating pattern. croner
 *  takes an ISO datetime as a pattern natively; a cron expression always has
 *  spaces in it and a datetime never does, which is the whole distinction. */
const looksLikeDatetime = (s: string) => !s.includes(' ') && /\d{4}-\d{2}-\d{2}/.test(s);

/**
 * Does this schedule parse, and will it ever fire?
 *
 * `now` is injectable so the tests don't race the clock — and so "already in the
 * past" can be checked against a fixed instant rather than whenever the suite
 * happens to run.
 */
export function checkSchedule(schedule: string, timezone?: string, now: Date = new Date()): ScheduleCheck {
  const raw = (schedule ?? '').trim();
  const oneTime = looksLikeDatetime(raw);
  if (!raw) {
    return { ok: false, error: 'A schedule is required — a cron expression like "0 9 * * *", or a datetime like "2026-03-14T18:50:00" for a one-time job.', nextRuns: [], oneTime };
  }

  let cron: Cron;
  try {
    cron = timezone ? new Cron(raw, { timezone }) : new Cron(raw);
  } catch (e: any) {
    return {
      ok: false,
      error: `"${raw}" is not a valid schedule (${e?.message ?? e}). Use a 5-field cron expression like "0 9 * * *", or an ISO datetime like "2026-03-14T18:50:00" for a one-time job.`,
      nextRuns: [],
      oneTime,
    };
  }

  // `nextRuns(n, from)` is the only thing that answers "will this ever fire".
  // A past datetime parses cleanly and returns nothing here — the failure the
  // scheduler cannot see.
  const upcoming = (cron.nextRuns(3, now) ?? []).map((d: Date) => d.getTime());
  cron.stop(); // constructing a Cron starts a timer; nothing here wants one running

  if (!upcoming.length) {
    return {
      ok: false,
      error: oneTime
        ? `${raw} has already passed, so this job would never run. Check the current time with \`date\` and pick a moment in the future.`
        : `"${raw}" parses but will never fire again. Pick a schedule that has upcoming runs.`,
      nextRuns: [],
      oneTime,
    };
  }

  return { ok: true, nextRuns: upcoming, oneTime };
}

/**
 * The whole job, checked against the file it is going into.
 *
 * `existing` is every job already in `cron.json`; `replacing` is the name being
 * updated (so an update doesn't collide with itself).
 */
export function validateJob(
  job: Partial<CronJob>,
  existing: CronJob[],
  opts: { timezone?: string; replacing?: string; now?: Date } = {},
): { ok: boolean; error?: string; job?: CronJob; nextRuns: number[] } {
  const name = (job.name ?? '').trim();
  if (!name) return { ok: false, error: 'A job needs a name — it is how the job is identified, and its run history is filed under it.', nextRuns: [] };

  // Same-name check is case-insensitive: the file is keyed by exact string but
  // two jobs differing only in case are a mistake every time, and the run
  // history would silently split between them.
  const clash = existing.find((j) => j?.name?.toLowerCase() === name.toLowerCase() && j.name !== opts.replacing);
  if (clash) return { ok: false, error: `A job named "${clash.name}" already exists. Pick another name, or update that one.`, nextRuns: [] };

  // The failure this prevents is invisible: the scheduler registers on name +
  // schedule alone, so a job with no prompt fires on time and throws every
  // single time, forever, while the panel shows it as a normal job.
  const prompt = (job.prompt ?? '').trim();
  if (!prompt) return { ok: false, error: 'A job needs a prompt — it is what the scheduled run is asked to do. Make it self-contained: the run starts a fresh chat and cannot see this conversation.', nextRuns: [] };

  const sched = checkSchedule(job.schedule ?? '', opts.timezone, opts.now);
  if (!sched.ok) return { ok: false, error: sched.error, nextRuns: [] };

  return { ok: true, job: normalizeJob({ ...job, name, prompt }, sched), nextRuns: sched.nextRuns };
}

/**
 * The entry as it gets written.
 *
 * **`once` is derived, never asked for.** A dated schedule always means a
 * one-time job, and the flag is what makes the run delete its own entry
 * afterwards — so leaving it to be remembered is how a fired reminder stays in
 * the file forever, listed as scheduled and unable to ever run again. Deriving
 * it removes the mistake rather than validating against it.
 *
 * `enabled` is written only when false, so the common entry stays short and an
 * absent key keeps meaning enabled.
 */
export function normalizeJob(job: Partial<CronJob>, sched: ScheduleCheck): CronJob {
  const out: CronJob = {
    name: job.name!.trim(),
    schedule: (job.schedule ?? '').trim(),
    prompt: job.prompt!.trim(),
  };
  if (job.enabled === false) out.enabled = false;
  if (sched.oneTime) out.once = true;
  return out;
}

/**
 * The three-word label the app's cron panel shows on a broken job, or null when
 * the job is fine.
 *
 * Here rather than in `src/main/api/cron.ts` for one reason: that file imports
 * the companion client, which imports electron, so nothing in it can be loaded
 * by `node --test`. A copy living there would be the only unchecked statement of
 * "what counts as broken" in the app, sitting next to the tested one.
 *
 * The tool's errors are a sentence or two written for the agent to act on; a pill
 * has room for three words. So the label is derived from WHICH question failed
 * rather than reusing the prose — and the two questions really are different: a
 * schedule can parse perfectly and still never fire again.
 *
 * No timezone argument: every host sets `process.env.TZ` from `settings.timezone`
 * at startup, so local time already is the user's zone — the same zone the
 * scheduler evaluates the job in.
 */
export function scheduleLabel(job: Partial<CronJob>): string | null {
  // Checked first because it is the most invisible of the three: the scheduler
  // registers on name + schedule alone, so a job with no prompt fires on time
  // and throws at every single fire, forever, looking normal throughout.
  if (!String(job?.prompt ?? '').trim()) return 'no prompt';

  const s = String(job?.schedule ?? '').trim();
  if (!s) return 'no schedule';

  const r = checkSchedule(s);
  if (r.ok) return null;
  // Parsed but has no future runs — a real schedule that can never fire again.
  if (r.nextRuns.length === 0 && !/not a valid schedule/.test(r.error ?? '')) {
    return r.oneTime ? 'already passed' : 'never runs';
  }
  return 'invalid schedule';
}

/** The file's own shape, checked before anything is added to it. A hand-edit can
 *  leave it as an object or as junk, and appending to that would replace the
 *  user's jobs with a single-entry array. */
export function parseJobsFile(raw: string): { ok: boolean; error?: string; jobs: CronJob[] } {
  const text = (raw ?? '').trim();
  if (!text) return { ok: true, jobs: [] };
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch (e: any) {
    return { ok: false, error: `cron.json is not valid JSON (${e?.message ?? e}). Fix the file before scheduling anything — writing to it now would lose what is there.`, jobs: [] };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, error: 'cron.json must be a JSON array of jobs. Fix the file before scheduling anything — writing to it now would lose what is there.', jobs: [] };
  }
  return { ok: true, jobs: parsed as CronJob[] };
}
