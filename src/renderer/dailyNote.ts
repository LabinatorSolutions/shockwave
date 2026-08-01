// Daily-note naming lives in `agent-core/dailyNote.js` — the app and the coding
// agent both resolve daily notes, and two copies of these rules would drift into
// each side opening a different file. This module is the renderer's door onto it.
//
// It stays as a file (rather than every call site importing agent-core directly)
// so the renderer has one import path for the feature, and so the deliberate
// choice of WHICH functions the renderer uses is visible in one place.
export {
  DAILY_NOTE_FORMAT_PRESETS,
  DEFAULT_DAILY_NOTE_FORMAT,
  DAILY_NOTE_FORMAT_HELP_URL,
  todayISO,
  isoFromDate,
  dateFromISO,
  isValidISO,
  formatDailyNote,
  parseDailyNoteDate,
  resolveDailyNotePath,
  basenameIdentifiesDate,
  shallowest,
} from '../../agent-core/dailyNote.js';
