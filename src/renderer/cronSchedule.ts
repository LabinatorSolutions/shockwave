// Turning a cron.json `schedule` into something a human reads at a glance.
//
// Two forms exist (see `SCHEDULED_RUNS` in agent-core/defaults/helper.ts): a
// 5-field cron expression for recurring jobs, or an ISO datetime for a one-time
// job. The panel shows the schedule as its headline, and `0 2 * * *` is not a
// headline.
//
// TIMEZONE. Both forms are evaluated by the companion in `settings.timezone`
// (api/src/scheduler.ts passes it to croner), NOT in the machine's local zone.
// Those differ whenever the user travels or deliberately pins a zone, so the
// one-time formatter is handed the setting rather than reading the machine.
// A cron EXPRESSION carries no zone at all — "at 2:00 AM" is the same words in
// every zone — so cronstrue needs nothing; the panel states the zone once in its
// footer instead of repeating it on every row.

import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezonePlugin from 'dayjs/plugin/timezone';
import cronstrue from 'cronstrue';

dayjs.extend(utc);
dayjs.extend(timezonePlugin);

// A one-time job's schedule, e.g. "2026-03-14T18:50:00". Seconds optional, and a
// space is accepted where the T goes because hand-edited files have both.
const ISO_LOCAL = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?$/;

/** Does this schedule name a single instant (a one-time job) rather than a recurrence? */
export function isOneTimeSchedule(schedule: string): boolean {
  return ISO_LOCAL.test((schedule ?? '').trim());
}

/**
 * The instant a one-time schedule names, or null if it isn't one.
 *
 * The string is WALL-CLOCK TIME IN `tz` — "18:50" means 6:50 PM there — so it is
 * parsed in that zone, not the machine's. Parsing it locally is the bug this
 * argument exists to prevent: on a machine three zones over, a 6:50 PM reminder
 * would render as 3:50 PM and look like the schedule was written wrong.
 */
export function parseOnceAt(schedule: string, tz: string): Date | null {
  const raw = (schedule ?? '').trim();
  if (!ISO_LOCAL.test(raw)) return null;
  const d = dayjs.tz(raw.replace(' ', 'T'), tz);
  return d.isValid() ? d.toDate() : null;
}

/**
 * A human sentence for a schedule, or null when it can't be read at all (caller
 * falls back to the raw expression in mono — a schedule we can't describe is
 * usually one the companion can't run either).
 */
export function describeSchedule(schedule: string, tz: string): string | null {
  const raw = (schedule ?? '').trim();
  if (!raw) return null;

  const onceAt = parseOnceAt(raw, tz);
  if (onceAt) return dayjs(onceAt).tz(tz).format('ddd MMM D, h:mm A');

  try {
    // Throwing (rather than cronstrue's default of returning the error text as
    // the description) is what lets an unparseable expression fall back to the
    // raw string instead of printing "An error occurred…" where a schedule goes.
    return cronstrue.toString(raw, { throwExceptionOnParseError: true, verbose: false });
  } catch {
    return null;
  }
}

/**
 * The zone label for the panel footer — `null` when the setting already matches
 * the machine, since naming the zone you're standing in is noise.
 */
export function timezoneNote(tz: string): string | null {
  if (!tz) return null;
  let machine = '';
  try { machine = Intl.DateTimeFormat().resolvedOptions().timeZone ?? ''; } catch { /* ignore */ }
  return tz === machine ? null : tz;
}
