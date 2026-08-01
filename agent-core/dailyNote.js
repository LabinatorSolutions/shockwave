// Daily-note naming — the one definition of what a daily note is called.
//
// Plain `.js` so `node --test` loads it directly and both TypeScript builds
// import it without ceremony, same as `credentials.js` and `linkParser.js`. It
// lives in `agent-core` because that is the only code bundled into BOTH builds,
// and both sides need it: the renderer opens today's note from the calendar
// button, the agent's `daily_note` tool resolves the same file. Two copies of
// this would drift silently — the agent writing `2026-08-01.md` while the app
// looks for `Journal/2026/08/2026-08-01.md` leaves the user with two notes and
// neither side finding the other's.
//
// NOTE: no `node:` imports here. The renderer bundles this file, and it has no
// Node available. The filesystem half of the feature lives in `dailyNoteTool.ts`.
//
// TIMEZONE. Exactly one question in this module needs a timezone: "what is
// today's date?" — and `todayISO` is the only function that asks it. Everything
// downstream works on a CALENDAR DATE (`YYYY-MM-DD`), which has no timezone by
// construction, so naming and parsing cannot fall back to the machine clock
// because they never look at a clock at all.
//
// That split is the fix for a real disagreement: the agent runs with
// `process.env.TZ = settings.timezone` (set by all three hosts) while the
// renderer never had it, so near midnight the calendar button and the agent
// resolved different days.

import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezonePlugin from 'dayjs/plugin/timezone.js';
import customParseFormat from 'dayjs/plugin/customParseFormat.js';

// `.tz()` needs utc+timezone; strict-parsing a basename back into a date needs
// customParseFormat.
dayjs.extend(utc);
dayjs.extend(timezonePlugin);
dayjs.extend(customParseFormat);

/** The calendar-date format used as this module's interchange type. */
export const ISO_DATE = 'YYYY-MM-DD';

// Format presets shown in the Daily Note settings dropdown. The 4th entry is
// path-style — the "/" in the format becomes a folder separator on disk so
// you can bucket notes under year/month folders automatically.
export const DAILY_NOTE_FORMAT_PRESETS = [
  'YYYY-MM-DD',
  'YYYY.MM.DD',
  'YYYY/MM/DD',
  'YYYY/MM/YYYY-MM-DD',
];

export const DEFAULT_DAILY_NOTE_FORMAT = 'YYYY-MM-DD';
export const DAILY_NOTE_FORMAT_HELP_URL = 'https://day.js.org/docs/en/display/format';

/**
 * Today's calendar date (`YYYY-MM-DD`) in `timezone`.
 *
 * THE ONLY PLACE THAT DECIDES WHAT DAY IT IS. Every caller that needs "today"
 * goes through here, so there is one behaviour to reason about rather than one
 * per feature.
 *
 * `timezone` is `settings.timezone`. It is an optional setting, and unset means
 * the machine's own zone — which is what the desktop already does
 * (`main.ts` sets `process.env.TZ` only when the setting has a value). An
 * unrecognized zone falls back the same way rather than throwing: a bad string
 * in settings should not brick the calendar button.
 */
export function todayISO(timezone) {
  if (timezone) {
    try {
      return dayjs().tz(timezone).format(ISO_DATE);
    } catch {
      // Unknown/invalid zone — fall through to the machine's zone.
    }
  }
  return dayjs().format(ISO_DATE);
}

/**
 * A `Date` → its calendar date (`YYYY-MM-DD`), read in the machine's zone.
 *
 * For dates that came from a date PICKER. The user clicked a box labelled "12";
 * they picked a calendar day, not an instant, so the Y/M/D shown on screen is
 * the answer and converting through a timezone here would shift it by a day.
 */
export function isoFromDate(date) {
  return dayjs(date).format(ISO_DATE);
}

/** A calendar date (`YYYY-MM-DD`) → a `Date` at local midnight, for calendar UI. */
export function dateFromISO(iso) {
  const m = dayjs(iso, ISO_DATE, true);
  return m.isValid() ? m.toDate() : null;
}

/** Is this a well-formed `YYYY-MM-DD` calendar date? */
export function isValidISO(iso) {
  return !!iso && dayjs(iso, ISO_DATE, true).isValid();
}

/**
 * Name the daily note for a calendar date, using the workspace's `format`
 * (dayjs / moment-compatible tokens).
 *
 * Takes a calendar date, never a `Date` — see the timezone note at the top.
 * Returns '' for an invalid date or format so the UI can show "Invalid format"
 * rather than crash, and so the tool can report it rather than write a file
 * named "Invalid Date".
 */
export function formatDailyNote(format, iso) {
  try {
    const m = dayjs(iso, ISO_DATE, true);
    if (!m.isValid()) return '';
    const out = m.format(format || DEFAULT_DAILY_NOTE_FORMAT);
    return out.includes('Invalid Date') ? '' : out;
  } catch {
    return '';
  }
}

/**
 * The inverse: strict-parse a workspace-relative path (no `.md`, forward
 * slashes) against `format`. Returns the calendar date if it matches cleanly,
 * else null.
 *
 * Used to detect which files inside the daily-note folder are daily notes.
 * Slashes in the format are folder boundaries, so `relPathNoExt` includes any
 * subdirs (e.g. '2026/06/02' against 'YYYY/MM/DD'). Strict mode rejects
 * anything that isn't an exact format match, so non-daily files are filtered out.
 */
export function parseDailyNoteDate(relPathNoExt, format) {
  if (!relPathNoExt || !format) return null;
  const m = dayjs(relPathNoExt, format, true);
  return m.isValid() ? m.format(ISO_DATE) : null;
}

/**
 * Resolve where a daily note lives. `folder` is workspace-relative ('' or '/' =
 * root). `formatted` may contain "/"; the last segment is the basename, leading
 * segments become subfolders.
 *
 * Returns { dir, name, absPath, relPath } where `dir` is the absolute folder,
 * `name` the basename with no `.md`, and `relPath` the workspace-relative path
 * of the file (what the agent should be shown — absolute paths inside a
 * workspace mean nothing to a user reading a reply).
 */
export function resolveDailyNotePath(workspacePath, folder, formatted) {
  const cleanFolder = (folder ?? '').replace(/^\/+|\/+$/g, '');
  const segments = formatted.split('/').filter(Boolean);
  const name = segments.pop() || formatted;
  const subdirs = segments.join('/');

  const relParts = [];
  if (cleanFolder) relParts.push(cleanFolder);
  if (subdirs) relParts.push(subdirs);
  const relDir = relParts.join('/');

  const dir = relDir ? `${workspacePath}/${relDir}` : workspacePath;
  const relPath = relDir ? `${relDir}/${name}.md` : `${name}.md`;
  return { dir, name, absPath: `${dir}/${name}.md`, relPath };
}

/**
 * Does the note's basename alone say which date it is?
 *
 * Decides whether it is safe to look an existing note up by basename anywhere in
 * the workspace — which is what lets a note still be found after the user moved
 * their notes or changed the folder setting.
 *
 * False for a path-style format (`YYYY/MM/DD`), where the basename is a bare day
 * number: searching the workspace for `01` when asked for August 1st happily
 * returns July's note. There, the computed path is the only trustworthy answer.
 *
 * Takes the FORMATTED name, not the format string, because that's what both
 * callers already have in hand.
 */
export function basenameIdentifiesDate(formatted) {
  return !!formatted && !formatted.includes('/');
}

/**
 * Pick the note to open when several files share the daily note's basename.
 *
 * Shallowest path wins, then shortest — the tiebreaker the app has always used
 * for duplicate basenames. Exported so the tool and the renderer agree on WHICH
 * existing note is "the" one, not just on what a new one would be called.
 */
export function shallowest(paths) {
  if (!paths || !paths.length) return null;
  return paths
    .slice()
    .sort((a, b) => a.split('/').length - b.split('/').length || a.length - b.length)[0];
}
