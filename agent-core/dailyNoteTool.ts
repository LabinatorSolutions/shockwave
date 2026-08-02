// `daily_note` — resolve (and optionally create) the user's daily note.
//
// The filesystem half of the daily-note feature. The naming rules live in the
// pure, renderer-safe `dailyNote.ts`; this file is the I/O around them, the same
// split as `transcriptFormat.ts` beside `transcribe.ts`.
//
// WHY A TOOL AND NOT A PROMPT INSTRUCTION. The note's name comes from a format
// string the user chose (`YYYY.MM.DD`, `YYYY/MM/YYYY-MM-DD`, …) stored per
// workspace, and its folder from another setting. An agent told to "write to
// today's journal" has to read two settings, apply dayjs tokens, and know that
// slashes in the format mean subfolders — every turn, correctly. It resolves the
// same file the calendar button opens or it silently starts a second one.
//
// NO HOST PLUMBING. Unlike `transcribe` (which needs the AssemblyAI key) this
// reads its config straight off disk: `.shockwave/workspace.json` sits inside the
// workspace checkout, which exists in BOTH hosts — the companion's cron runner
// already reads that exact file for `builtinSkills`. So there is no `AgentHost`
// getter and no desktop/companion split.

import fs from 'node:fs/promises';
import path from 'node:path';
import {
  DEFAULT_DAILY_NOTE_FORMAT,
  basenameIdentifiesDate,
  formatDailyNote,
  isValidISO,
  resolveDailyNotePath,
  shallowest,
  todayISO,
} from './dailyNote.ts';

export interface DailyNoteConfig {
  format: string;
  folder: string;
  templatePath: string;
}

// Directories that are never part of a user's notes. `.git` alone would be most
// of the walk in a synced workspace.
const SKIP_DIRS = new Set(['.git', 'node_modules', '.shockwave', '.agents']);
// A workspace is a notes folder, not a monorepo — this is a runaway guard, not a
// real limit.
const MAX_SCAN_ENTRIES = 20_000;

const fail = (text: string) => ({ content: [{ type: 'text', text }], isError: true });

/**
 * The workspace's daily-note settings, defaulted exactly like the desktop's
 * `normalizeWorkspaceData`. A missing or unreadable file is not an error — a
 * workspace that has never opened the settings page simply has no file yet, and
 * the defaults are what the app would use.
 */
export async function readDailyNoteConfig(workspacePath: string): Promise<DailyNoteConfig> {
  const d: DailyNoteConfig = { format: DEFAULT_DAILY_NOTE_FORMAT, folder: '', templatePath: '' };
  try {
    const raw = await fs.readFile(path.join(workspacePath, '.shockwave', 'workspace.json'), 'utf8');
    const dn = JSON.parse(raw)?.dailyNote;
    if (dn && typeof dn === 'object') {
      if (typeof dn.format === 'string' && dn.format) d.format = dn.format;
      if (typeof dn.folder === 'string') d.folder = dn.folder;
      if (typeof dn.templatePath === 'string') d.templatePath = dn.templatePath;
    }
  } catch {
    // No file, bad JSON, no permission — the defaults stand.
  }
  return d;
}

const exists = async (p: string) => { try { await fs.stat(p); return true; } catch { return false; } };

/**
 * Every `<name>.md` in the workspace, workspace-relative, shallowest first.
 *
 * Used only when the basename alone identifies the date (see `locate`).
 */
async function findByBasename(workspacePath: string, name: string): Promise<string[]> {
  const target = `${name.toLowerCase()}.md`;
  const hits: string[] = [];
  let seen = 0;
  const walk = async (dir: string, rel: string) => {
    if (seen > MAX_SCAN_ENTRIES) return;
    let entries: any[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (seen++ > MAX_SCAN_ENTRIES) return;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        await walk(path.join(dir, e.name), childRel);
      } else if (e.name.toLowerCase() === target) {
        hits.push(childRel);
      }
    }
  };
  await walk(workspacePath, '');
  return hits;
}

/**
 * Where the note for `iso` is, or would go.
 *
 * Two steps, in order:
 *   1. The path the settings say it should have. This is the answer almost
 *      always, and it costs one stat.
 *   2. Only when the basename identifies the date on its own: any file with that
 *      basename anywhere in the workspace. This is what lets an existing note be
 *      found after the user changed the folder setting or moved their notes, and
 *      it mirrors the calendar button. See `basenameIdentifiesDate`.
 */
export async function locate(workspacePath: string, cfg: DailyNoteConfig, iso: string) {
  const formatted = formatDailyNote(cfg.format, iso);
  if (!formatted) return null;
  const { dir, name, absPath, relPath } = resolveDailyNotePath(workspacePath, cfg.folder, formatted);

  if (await exists(absPath)) return { dir, name, absPath, relPath, found: relPath };

  if (basenameIdentifiesDate(formatted)) {
    const other = shallowest(await findByBasename(workspacePath, name));
    if (other) return { dir, name, absPath, relPath, found: other };
  }
  return { dir, name, absPath, relPath, found: null };
}

/**
 * `daily_note` — built per session, closed over the workspace it belongs to
 * (same shape as `transcribe` closing over the chat's scratch pad).
 *
 * `timezone` is `settings.timezone`, forwarded so "today" matches what the app's
 * calendar button shows. Both hosts also set `process.env.TZ`, so this is
 * belt-and-braces rather than the only defence — but it keeps the answer correct
 * even if a host ever stops doing that.
 */
export function makeDailyNoteTool(workspacePath: string, timezone?: string): any {
  return {
    name: 'daily_note',
    label: 'Daily Note',
    description: [
      "Find the user's daily note (journal / diary) for a date, and create it if asked.",
      'Returns the workspace-relative path, whether it already exists, and the naming settings used.',
      'Always use this instead of guessing a filename — the name comes from a per-workspace format setting and the folder from another, and a guess silently creates a second note alongside the real one.',
      'Omit `date` for today. Pass `create: true` only when you are about to write into it.',
    ].join(' '),
    promptSnippet: "Resolve the user's daily note for a date (default today), optionally creating it from their template.",
    parameters: {
      type: 'object',
      properties: {
        date: {
          type: 'string',
          description: 'Calendar date as YYYY-MM-DD. Omit for today. Work out relative dates ("yesterday", "last Monday") yourself before calling.',
        },
        create: {
          type: 'boolean',
          description: "Create the note if it doesn't exist, seeded from the user's configured template. Default false, so reading an old day never leaves an empty file behind.",
        },
      },
      additionalProperties: false,
    },
    async execute(_id: string, params: any = {}) {
      try {
        const iso = params?.date ? String(params.date) : todayISO(timezone);
        if (!isValidISO(iso)) {
          return fail(`"${iso}" is not a calendar date. Use YYYY-MM-DD, or omit the date for today.`);
        }

        const cfg = await readDailyNoteConfig(workspacePath);
        const at = await locate(workspacePath, cfg, iso);
        if (!at) {
          return fail(
            `The daily-note format in this workspace ("${cfg.format}") is not a valid date format, so the note cannot be named. `
            + 'The user can fix it in Settings → Daily Notes.',
          );
        }

        const where = `folder "${cfg.folder || '/'}", format "${cfg.format}"`;
        const details = {
          date: iso, path: at.found ?? at.relPath, exists: !!at.found,
          format: cfg.format, folder: cfg.folder, templatePath: cfg.templatePath,
        };

        if (at.found) {
          return {
            content: [{ type: 'text', text: `The daily note for ${iso} is \`${at.found}\`. It already exists — read it before writing, and add to it rather than replacing what is there.\nSettings: ${where}.` }],
            details,
          };
        }

        if (!params?.create) {
          return {
            content: [{ type: 'text', text: `There is no daily note for ${iso} yet. It would be \`${at.relPath}\`. Call again with create: true to make it.\nSettings: ${where}.` }],
            details,
          };
        }

        // Seed from the configured template, if any. Copied verbatim — nothing
        // in Shockwave substitutes placeholders, in this path or the app's.
        let initial = '';
        if (cfg.templatePath) {
          try {
            initial = await fs.readFile(path.join(workspacePath, cfg.templatePath), 'utf8');
          } catch {
            initial = '';   // Template missing/unreadable — an empty note beats no note.
          }
        }
        await fs.mkdir(at.dir, { recursive: true });
        // 'wx' so a note created between the check above and here is never
        // clobbered; that race loses a day of writing.
        try {
          await fs.writeFile(at.absPath, initial, { encoding: 'utf8', flag: 'wx' });
        } catch (e: any) {
          if (e?.code !== 'EEXIST') throw e;
          return {
            content: [{ type: 'text', text: `The daily note for ${iso} is \`${at.relPath}\` — it was created just now by something else. Read it before writing.` }],
            details: { ...details, exists: true },
          };
        }

        const seeded = cfg.templatePath && initial ? ` Started from the template \`${cfg.templatePath}\`.` : '';
        return {
          content: [{ type: 'text', text: `Created the daily note for ${iso} at \`${at.relPath}\`.${seeded}\nSettings: ${where}.` }],
          details: { ...details, exists: true, created: true },
        };
      } catch (e: any) {
        return fail(`Could not resolve the daily note: ${e?.message || e}`);
      }
    },
  };
}
