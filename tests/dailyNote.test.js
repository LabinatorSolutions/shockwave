// Daily-note naming — the rules the app's calendar button and the agent's
// `daily_note` tool both resolve through (agent-core/dailyNote.js).
//
// Worth pinning because the failure is silent: a naming change that makes the
// two sides disagree doesn't throw, it quietly produces a second note beside the
// user's real one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DAILY_NOTE_FORMAT_PRESETS,
  DEFAULT_DAILY_NOTE_FORMAT,
  todayISO,
  isoFromDate,
  dateFromISO,
  isValidISO,
  formatDailyNote,
  parseDailyNoteDate,
  resolveDailyNotePath,
  basenameIdentifiesDate,
  shallowest,
} from '../agent-core/dailyNote.js';

const WS = '/ws';

test('formatDailyNote renders every shipped preset', () => {
  assert.equal(formatDailyNote('YYYY-MM-DD', '2026-08-01'), '2026-08-01');
  assert.equal(formatDailyNote('YYYY.MM.DD', '2026-08-01'), '2026.08.01');
  assert.equal(formatDailyNote('YYYY/MM/DD', '2026-08-01'), '2026/08/01');
  assert.equal(formatDailyNote('YYYY/MM/YYYY-MM-DD', '2026-08-01'), '2026/08/2026-08-01');
  // Every preset must produce something — an empty name means no file.
  for (const p of DAILY_NOTE_FORMAT_PRESETS) {
    assert.ok(formatDailyNote(p, '2026-08-01'), `preset ${p} produced nothing`);
  }
});

test('formatDailyNote falls back to the default format, and rejects bad input', () => {
  assert.equal(formatDailyNote('', '2026-08-01'), '2026-08-01');
  assert.equal(DEFAULT_DAILY_NOTE_FORMAT, 'YYYY-MM-DD');
  // An unparseable date must yield '' so callers show an error rather than
  // creating a file called "Invalid Date.md".
  assert.equal(formatDailyNote('YYYY-MM-DD', 'not-a-date'), '');
  assert.equal(formatDailyNote('YYYY-MM-DD', '2026-13-45'), '');
  assert.equal(formatDailyNote('YYYY-MM-DD', ''), '');
});

test('formatDailyNote takes a calendar date, so it has no timezone to get wrong', () => {
  // The whole point of the string interchange: same input, same name, whatever
  // the machine's zone is. This is what stopped the app and the agent
  // disagreeing about "today" near midnight.
  const before = process.env.TZ;
  try {
    process.env.TZ = 'Pacific/Kiritimati';        // UTC+14
    const a = formatDailyNote('YYYY-MM-DD', '2026-08-01');
    process.env.TZ = 'Pacific/Midway';            // UTC-11
    const b = formatDailyNote('YYYY-MM-DD', '2026-08-01');
    assert.equal(a, '2026-08-01');
    assert.equal(b, '2026-08-01');
  } finally {
    if (before === undefined) delete process.env.TZ; else process.env.TZ = before;
  }
});

test('todayISO answers in the requested zone', () => {
  // Two zones a full day apart can't both be right, so at least one of these is
  // NOT the machine's own answer — which is the behaviour being pinned.
  const east = todayISO('Pacific/Kiritimati');
  const west = todayISO('Pacific/Midway');
  assert.match(east, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(west, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(east >= west, 'UTC+14 should never be behind UTC-11');
});

test('todayISO survives an unset or invalid timezone', () => {
  // An optional setting that was never filled in, and a bad string, must not
  // brick the calendar button.
  assert.match(todayISO(undefined), /^\d{4}-\d{2}-\d{2}$/);
  assert.match(todayISO(''), /^\d{4}-\d{2}-\d{2}$/);
  assert.match(todayISO('Not/AZone'), /^\d{4}-\d{2}-\d{2}$/);
});

test('isoFromDate reads the day off a picked Date, without shifting it', () => {
  // A date picker hands back local midnight for the box the user clicked.
  assert.equal(isoFromDate(new Date(2026, 7, 1)), '2026-08-01');
  assert.equal(isoFromDate(new Date(2026, 0, 31)), '2026-01-31');
});

test('dateFromISO round-trips with isoFromDate', () => {
  assert.equal(isoFromDate(dateFromISO('2026-08-01')), '2026-08-01');
  assert.equal(dateFromISO('nope'), null);
});

test('isValidISO accepts calendar dates only', () => {
  assert.equal(isValidISO('2026-08-01'), true);
  assert.equal(isValidISO('2026-02-29'), false);   // 2026 is not a leap year
  assert.equal(isValidISO('2026-8-1'), false);     // strict — must be padded
  assert.equal(isValidISO('01/08/2026'), false);
  assert.equal(isValidISO(''), false);
  assert.equal(isValidISO(undefined), false);
});

test('resolveDailyNotePath puts a flat format in the configured folder', () => {
  const r = resolveDailyNotePath(WS, 'Journal', '2026-08-01');
  assert.equal(r.dir, '/ws/Journal');
  assert.equal(r.name, '2026-08-01');
  assert.equal(r.absPath, '/ws/Journal/2026-08-01.md');
  assert.equal(r.relPath, 'Journal/2026-08-01.md');
});

test('slashes in the format become subfolders under the configured folder', () => {
  const r = resolveDailyNotePath(WS, 'Journal', '2026/08/2026-08-01');
  assert.equal(r.dir, '/ws/Journal/2026/08');
  assert.equal(r.name, '2026-08-01');
  assert.equal(r.absPath, '/ws/Journal/2026/08/2026-08-01.md');
  assert.equal(r.relPath, 'Journal/2026/08/2026-08-01.md');

  // `YYYY/MM/DD` leaves the basename a bare day number — the case that makes a
  // workspace-wide basename lookup unsafe (it would match every other month's).
  const bare = resolveDailyNotePath(WS, '', '2026/08/01');
  assert.equal(bare.name, '01');
  assert.equal(bare.relPath, '2026/08/01.md');
});

test('an empty or slashed folder means the workspace root', () => {
  for (const folder of ['', '/', '//']) {
    const r = resolveDailyNotePath(WS, folder, '2026-08-01');
    assert.equal(r.dir, '/ws', `folder ${JSON.stringify(folder)}`);
    assert.equal(r.absPath, '/ws/2026-08-01.md');
    assert.equal(r.relPath, '2026-08-01.md');
  }
  // Stray edge slashes are trimmed rather than doubling up the path.
  assert.equal(resolveDailyNotePath(WS, '/Journal/', '2026-08-01').dir, '/ws/Journal');
});

test('parseDailyNoteDate strict-parses a daily note back to its date', () => {
  assert.equal(parseDailyNoteDate('2026-08-01', 'YYYY-MM-DD'), '2026-08-01');
  assert.equal(parseDailyNoteDate('2026/08/2026-08-01', 'YYYY/MM/YYYY-MM-DD'), '2026-08-01');
  assert.equal(parseDailyNoteDate('2026/08/01', 'YYYY/MM/DD'), '2026-08-01');
});

test('parseDailyNoteDate rejects anything that is not a daily note', () => {
  // This is what keeps ordinary files out of the tree panel's Daily Notes list.
  assert.equal(parseDailyNoteDate('Meeting notes', 'YYYY-MM-DD'), null);
  assert.equal(parseDailyNoteDate('2026-08-01 draft', 'YYYY-MM-DD'), null);
  assert.equal(parseDailyNoteDate('2026-08-01', 'YYYY/MM/DD'), null);
  assert.equal(parseDailyNoteDate('', 'YYYY-MM-DD'), null);
  assert.equal(parseDailyNoteDate('2026-08-01', ''), null);
});

test('format and parse round-trip for every preset', () => {
  for (const p of DAILY_NOTE_FORMAT_PRESETS) {
    const named = formatDailyNote(p, '2026-08-01');
    assert.equal(parseDailyNoteDate(named, p), '2026-08-01', `preset ${p} did not round-trip`);
  }
});

test('basenameIdentifiesDate gates the workspace-wide lookup', () => {
  // True → safe to find an existing note by basename anywhere in the workspace.
  assert.equal(basenameIdentifiesDate('2026-08-01'), true);
  assert.equal(basenameIdentifiesDate('2026.08.01'), true);
  // False → the basename is a bare day number, shared with every other month,
  // so only the computed path can be trusted.
  assert.equal(basenameIdentifiesDate('2026/08/01'), false);
  // …and still false when the last segment happens to be date-shaped: an
  // existing note under a different folder setting is not findable either way.
  assert.equal(basenameIdentifiesDate('2026/08/2026-08-01'), false);
  assert.equal(basenameIdentifiesDate(''), false);
});

test('the two shipped path-style presets both require the computed path', () => {
  for (const p of DAILY_NOTE_FORMAT_PRESETS) {
    const named = formatDailyNote(p, '2026-08-01');
    assert.equal(basenameIdentifiesDate(named), !p.includes('/'), `preset ${p}`);
  }
});

test('shallowest picks the note the app would open', () => {
  assert.equal(
    shallowest(['/ws/a/b/2026-08-01.md', '/ws/2026-08-01.md', '/ws/a/2026-08-01.md']),
    '/ws/2026-08-01.md',
  );
  // Equal depth → shortest, so the choice is stable rather than order-dependent.
  assert.equal(shallowest(['/ws/longer/x.md', '/ws/ab/x.md']), '/ws/ab/x.md');
  assert.equal(shallowest([]), null);
  assert.equal(shallowest(null), null);
});
