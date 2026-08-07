// The rules that decide whether a scheduled job is real (`agent-core/cronValidate.ts`).
//
// Every one of these exists because the failure it prevents is SILENT. `cron.json`
// was hand-written and unchecked, and all three ways of getting it wrong left the
// job sitting in the panel looking scheduled:
//
//   - a schedule that doesn't parse → a `log.warn` on a server nobody reads
//   - a datetime already past → not even a warning; croner accepts it
//   - a job with no prompt → registers fine, throws at every fire, forever
//
// So the tests are about what is REFUSED, and the two-part schedule check is the
// centre of it: parsing and firing are different questions, and the one that
// matters most is invisible to a parser.
//
// `now` is injected everywhere so nothing here races the clock.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { checkSchedule, validateJob, parseJobsFile, scheduleLabel } from '../agent-core/cronValidate.ts';

const NOW = new Date('2026-08-06T12:00:00Z');

test('a valid cron expression passes and reports when it will run', () => {
  const r = checkSchedule('0 9 * * *', 'UTC', NOW);
  assert.equal(r.ok, true);
  assert.equal(r.oneTime, false);
  assert.ok(r.nextRuns.length > 0, 'a recurring schedule must report upcoming runs');
  assert.ok(r.nextRuns[0] > NOW.getTime(), 'the next run must be in the future');
});

test('a future datetime passes and is recognised as one-time', () => {
  const r = checkSchedule('2027-03-14T18:50:00', 'UTC', NOW);
  assert.equal(r.ok, true);
  assert.equal(r.oneTime, true, 'a dated schedule is what makes a job one-time');
  assert.equal(r.nextRuns.length, 1, 'a one-time job fires exactly once');
});

test('A DATETIME ALREADY PAST IS REFUSED — the failure a parser cannot see', () => {
  // This is the one that matters. croner does NOT throw on a past date: it
  // accepts the pattern and reports no next run. So the scheduler registers it,
  // nothing ever fires, and not one line is logged anywhere.
  //
  // It is also the ordinary case, not an exotic one: the agent is told today's
  // DATE but never the time of day, so "remind me at 6:50" written in the evening
  // lands on a 6:50 that has already gone.
  const r = checkSchedule('2020-03-14T18:50:00', 'UTC', NOW);
  assert.equal(r.ok, false);
  assert.equal(r.nextRuns.length, 0);
  // The message has to send the agent somewhere, not just say no.
  assert.match(r.error, /already passed/);
  assert.match(r.error, /date/, 'the fix is to check the clock — say so');
});

test('garbage, empty and malformed datetimes are refused with the shape that works', () => {
  for (const bad of ['not a schedule', '', '   ', '2026-13-45T99:99:00']) {
    const r = checkSchedule(bad, 'UTC', NOW);
    assert.equal(r.ok, false, `accepted "${bad}"`);
    assert.ok(r.error.length > 0);
  }
  // An error that only says "invalid" leaves the agent guessing at the format.
  assert.match(checkSchedule('nope', 'UTC', NOW).error, /0 9 \* \* \*/);
});

test('a job with no prompt is refused', () => {
  // The scheduler registers on name + schedule alone, so this one gets all the
  // way to firing and then throws — every fire, forever, while the panel shows a
  // normal job.
  const r = validateJob({ name: 'nightly', schedule: '0 2 * * *' }, [], { timezone: 'UTC', now: NOW });
  assert.equal(r.ok, false);
  assert.match(r.error, /prompt/);
  // The reason it must be self-contained is the reason it is easy to get wrong.
  assert.match(r.error, /fresh chat|cannot see/);
});

test('a duplicate name is refused, case-insensitively', () => {
  const existing = [{ name: 'Nightly', schedule: '0 2 * * *', prompt: 'x' }];
  const r = validateJob(
    { name: 'nightly', schedule: '0 3 * * *', prompt: 'y' },
    existing, { timezone: 'UTC', now: NOW },
  );
  assert.equal(r.ok, false);
  // Two jobs differing only in case would split their run history in silence.
  assert.match(r.error, /already exists/);
});

test('updating a job does not collide with itself', () => {
  const existing = [{ name: 'nightly', schedule: '0 2 * * *', prompt: 'x' }];
  const r = validateJob(
    { name: 'nightly', schedule: '0 3 * * *', prompt: 'x' },
    existing, { timezone: 'UTC', replacing: 'nightly', now: NOW },
  );
  assert.equal(r.ok, true);
});

test('`once` is DERIVED from the schedule, never asked for', () => {
  // Disposal is gated on this flag: a dated job that fires without it stays in
  // the file forever, listed as scheduled and unable to run again. Deriving it
  // removes the mistake instead of validating against it.
  const dated = validateJob(
    { name: 'remind', schedule: '2027-03-14T18:50:00', prompt: 'ping' },
    [], { timezone: 'UTC', now: NOW },
  );
  assert.equal(dated.job.once, true);

  const recurring = validateJob(
    { name: 'nightly', schedule: '0 2 * * *', prompt: 'x' },
    [], { timezone: 'UTC', now: NOW },
  );
  assert.equal(recurring.job.once, undefined, 'a recurring job must never be marked one-time');
});

test('an enabled job writes no `enabled` key, a paused one does', () => {
  // Absent keeps meaning enabled, so the ordinary entry stays short.
  const on = validateJob({ name: 'a', schedule: '0 2 * * *', prompt: 'x' }, [], { timezone: 'UTC', now: NOW });
  assert.equal('enabled' in on.job, false);
  const off = validateJob({ name: 'b', schedule: '0 2 * * *', prompt: 'x', enabled: false }, [], { timezone: 'UTC', now: NOW });
  assert.equal(off.job.enabled, false);
});

// ── The label the app shows on a broken job ─────────────────────────────────
//
// This is the only way a broken job reaches a HUMAN. Before it, `invalid` was
// hardcoded null in `src/main/api/cron.ts` while `CronModal.tsx` rendered it —
// so a job that could never fire sat in the list looking exactly like one that
// runs nightly, and the only other trace was a log line on the server.
//
// It is tested here, and lives in this module, because the file that consumes it
// imports electron and cannot be loaded by `node --test`. A copy over there
// would be the app's only unchecked statement of what counts as broken.

test('a healthy job gets no label', () => {
  assert.equal(scheduleLabel({ name: 'a', schedule: '0 2 * * *', prompt: 'x' }), null);
  assert.equal(scheduleLabel({ name: 'b', schedule: '2027-03-14T18:50:00', prompt: 'x' }), null);
});

test('each way of being broken gets its own words', () => {
  // Three words each, and they have to distinguish the causes: "already passed"
  // sends you to the schedule, "no prompt" sends you to the job body, and
  // conflating them sends you looking in the wrong place.
  assert.equal(scheduleLabel({ schedule: '2020-01-01T09:00:00', prompt: 'x' }), 'already passed');
  assert.equal(scheduleLabel({ schedule: 'every tuesday-ish', prompt: 'x' }), 'invalid schedule');
  assert.equal(scheduleLabel({ schedule: '0 5 * * *' }), 'no prompt');
  assert.equal(scheduleLabel({ schedule: '', prompt: 'x' }), 'no schedule');
});

test('the panel and the tool never disagree about a job', () => {
  // Both derive from `checkSchedule`, and this is what holds them together: a
  // panel calling a job fine while the tool refuses to write it would be worse
  // than either answer on its own.
  for (const job of [
    { name: 'ok', schedule: '0 2 * * *', prompt: 'x' },
    { name: 'past', schedule: '2020-01-01T09:00:00', prompt: 'x' },
    { name: 'junk', schedule: 'nope', prompt: 'x' },
    { name: 'bare', schedule: '0 2 * * *' },
  ]) {
    const writable = validateJob(job, [], { now: NOW }).ok;
    const labelled = scheduleLabel(job) !== null;
    assert.equal(writable, !labelled, `panel and tool disagree about "${job.name}"`);
  }
});

test('a cron.json that is not an array is refused rather than overwritten', () => {
  // Appending to a hand-edited object would replace every job the user has with
  // a single-entry array, which is the one failure here that destroys data.
  for (const bad of ['{"name":"x"}', 'nonsense', '"a string"']) {
    const r = parseJobsFile(bad);
    assert.equal(r.ok, false, `accepted ${bad}`);
    assert.match(r.error, /before scheduling anything|not valid JSON/);
  }
  // Missing or empty is not an error — that is a workspace with no jobs yet.
  assert.deepEqual(parseJobsFile('').jobs, []);
  assert.equal(parseJobsFile('[]').ok, true);
});
