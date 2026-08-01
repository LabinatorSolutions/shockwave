import { useState, useCallback } from 'react';
import type { MutableRefObject } from 'react';
import {
  basenameIdentifiesDate, formatDailyNote, resolveDailyNotePath, shallowest,
} from '../dailyNote.js';

interface DailyNoteConfig {
  format: string;
  folder: string;
  // Workspace-relative path of the template seeded into a new daily note
  // ('' = none).
  templatePath: string;
}

interface UseDailyNoteOpts {
  workspacePath: string | null;
  // Today's calendar date (YYYY-MM-DD) in the user's configured timezone.
  // Handed in rather than read here so ONE place in the app decides what day it
  // is — see `todayISO` in agent-core/dailyNote.js.
  today: string;
  // Read via ref so openJournal always sees the latest format/folder without
  // being rebuilt when the setting changes.
  dailyNoteRef: MutableRefObject<DailyNoteConfig>;
  writeNow: () => Promise<unknown>;
  openInActiveTab: (path: string) => Promise<unknown> | unknown;
  linkIndex: {
    cache: { candidatesFor: (basename: string) => string[] };
    updateFile: (path: string, text: string, mtime: number) => void;
  };
  fileOps: { treeAndIndexChanged: () => Promise<unknown> };
  showError: (msg: string) => void;
}

// Daily notes: the calendar date-picker anchor + openJournal, which opens (or
// creates) the daily note for a date using the user's configured format/folder.
export function useDailyNote({
  workspacePath,
  today,
  dailyNoteRef,
  writeNow,
  openInActiveTab,
  linkIndex,
  fileOps,
  showError,
}: UseDailyNoteOpts) {
  // Anchor for the JournalDatePicker popover ({x, y} on right-click, else null).
  const [journalPickerAnchor, setJournalPickerAnchor] = useState<{ x: number; y: number } | null>(null);

  // openJournal(iso?) — opens (or creates) the daily note for a calendar date
  // (YYYY-MM-DD, default today) using the user's configured format + folder. If
  // the format contains "/" the leading segments become subfolders.
  const openJournal = useCallback(async (iso?: string) => {
    if (!workspacePath) return;
    const d = iso ?? today;
    const dn = dailyNoteRef.current;
    const formatted = formatDailyNote(dn.format, d);
    if (!formatted) {
      showError('Daily note format is invalid. Open Settings → Daily Note to fix it.');
      return;
    }
    const { dir, name, absPath } = resolveDailyNotePath(workspacePath, dn.folder, formatted);
    try {
      await writeNow();
      // An existing note is opened in place wherever it lives, so moving your
      // notes or changing the folder setting doesn't start a second one — but
      // only when the basename identifies the date on its own (see
      // `basenameIdentifiesDate`; same rule as `locate` in dailyNoteTool.ts).
      const candidates = linkIndex.cache.candidatesFor(name.toLowerCase()) || [];
      const existing = basenameIdentifiesDate(formatted)
        ? shallowest(candidates)
        : candidates.find((p) => p === absPath) ?? null;
      if (existing) {
        await openInActiveTab(existing);
        return;
      }
      // Seed a new daily note with the configured default template, if any.
      let initial = '';
      if (dn.templatePath) {
        try {
          initial = await window.api.readFile(`${workspacePath}/${dn.templatePath}`);
        } catch {
          // Template missing/unreadable — fall back to an empty note.
          initial = '';
        }
      }
      await window.api.ensureDir(dir);
      const { path: newPath, mtime } = await window.api.createFile(dir, `${name}.md`, initial);
      linkIndex.updateFile(newPath, initial, mtime);
      await fileOps.treeAndIndexChanged();
      await openInActiveTab(newPath);
    } catch (err: any) {
      showError(err.message ?? String(err));
    }
  }, [workspacePath, today, dailyNoteRef, writeNow, linkIndex, openInActiveTab, fileOps, showError]);

  return { journalPickerAnchor, setJournalPickerAnchor, openJournal };
}
