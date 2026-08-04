// The templates snapshot baked into the system prompt at chat creation.
//
// Templates are ordinary `.md` files sitting directly in a per-workspace folder
// (`templates.folder` in `.shockwave/workspace.json` — the same file
// `readDailyNoteConfig` reads, and the same list the app's template picker
// shows: direct children only, no recursion). The list is read once, when the
// chat is created, and frozen with the prompt — same snapshot behaviour as the
// memory blocks.
//
// Anything invalid — no workspace.json, bad JSON, folder unset, folder missing,
// no `.md` files in it — returns undefined, and the prompt simply has no
// Templates section. Never an error: a workspace without templates is the
// normal case, not a failure.

import fs from 'node:fs/promises';
import path from 'node:path';

export interface TemplatesSnapshot {
  // Workspace-relative folder, no leading/trailing slashes.
  folder: string;
  // Workspace-relative `.md` paths, sorted the way the app's picker sorts them.
  files: string[];
}

export async function readTemplates(workspacePath: string): Promise<TemplatesSnapshot | undefined> {
  let folder = '';
  try {
    const raw = await fs.readFile(path.join(workspacePath, '.shockwave', 'workspace.json'), 'utf8');
    const t = JSON.parse(raw)?.templates;
    if (t && typeof t.folder === 'string') folder = t.folder.replace(/^\/+|\/+$/g, '');
  } catch {
    return undefined;
  }
  if (!folder) return undefined;

  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(path.join(workspacePath, folder), { withFileTypes: true });
  } catch {
    return undefined;
  }
  const files = entries
    .filter((e) => e.isFile() && /\.md$/i.test(e.name))
    .map((e) => `${folder}/${e.name}`)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
  if (!files.length) return undefined;
  return { folder, files };
}
