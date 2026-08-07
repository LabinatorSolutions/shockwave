// The default file set every workspace gets — the manifest, and the two
// functions that write it.
//
// ── The rule for this folder ────────────────────────────────────────────────
//
// One module per seeded file, named after it, exporting `<X>_FILENAME` and
// `DEFAULT_<X>`. No exceptions — including the two whose default is the empty
// string, which is exactly where the rule earns itself: `DEFAULT_MEMORY = ''`
// has somewhere to say that empty is deliberate, where a bare `''` in the
// manifest below read as an unwritten stub.
//
// This replaced a split with no rule behind it. `soul.ts` held SOUL and AGENTS
// (plus their filenames, plus `readSoul`), while `files.ts` held IGNORE,
// GITIGNORE and the two memory filenames — so where a default lived was a
// coin-toss, and the odd one out was named `AGENTS_STUB` while its three
// neighbours were `DEFAULT_*`.
//
// `readSoul` stays in `soul.ts` and is re-exported here: `DEFAULT_SOUL` is the
// one default that is also a RUNTIME FALLBACK, returned in memory for a
// workspace that has no SOUL.md, so it has a consumer beyond this manifest.
//
// ── These are FILES, not settings, on purpose ───────────────────────────────
//
// The user can read, edit, diff and sync them like anything else in the
// workspace, and so can the agent.
//
// WHEN THIS RUNS
//   - `createWorkspaceRepo` only — a repo the user just created through the app.
//     It's theirs and it's empty, so seeding it is the point.
//   - On explicit user request (`workspace:ensureFiles`), to fill in files that
//     are missing — e.g. an older workspace, or a clone.
//
// NOT on clone / adopt / set-up-here (`ensureCheckout`). Cloning means adopting
// someone else's repo, and the sync engine commits and pushes on its next tick —
// so scaffolding there would push our whole manifest into a repo the user may not
// own and may share. `.gitignore` is the sharpest: adding one changes git's
// behavior for every collaborator. Clone stays untouched; the manual action is
// how you opt in.
//
// It deliberately does NOT run on workspace activation. Writing to the user's
// folder every time they switch workspaces is the wrong shape: silent, repeated,
// and surprising.
//
// NEVER CLOBBERS. Every write is `wx` (fail-if-exists), so a tuned SOUL.md or a
// hand-maintained .gitignore survives untouched. Adding a file to DEFAULT_FILES
// is therefore safe to ship: existing workspaces pick it up on the next explicit
// request, and nobody loses an edit.

import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import { SOUL_FILENAME, DEFAULT_SOUL, readSoul } from './soul.ts';
import { AGENTS_FILENAME, DEFAULT_AGENTS } from './agents.ts';
import { MEMORY_FILENAME, DEFAULT_MEMORY } from './memory.ts';
import { USER_FILENAME, DEFAULT_USER } from './user.ts';
import { IGNORE_FILENAME, DEFAULT_IGNORE } from './ignore.ts';
import { GITIGNORE_FILENAME, DEFAULT_GITIGNORE } from './gitignore.ts';

export { SOUL_FILENAME, DEFAULT_SOUL, readSoul } from './soul.ts';
export { AGENTS_FILENAME, DEFAULT_AGENTS } from './agents.ts';
export { MEMORY_FILENAME, DEFAULT_MEMORY } from './memory.ts';
export { USER_FILENAME, DEFAULT_USER } from './user.ts';
export { IGNORE_FILENAME, DEFAULT_IGNORE } from './ignore.ts';
export { GITIGNORE_FILENAME, DEFAULT_GITIGNORE } from './gitignore.ts';

export interface DefaultFile {
  name: string;
  content: string;
  /** Shown in the UI when reporting what was added. */
  purpose: string;
}

export const DEFAULT_FILES: DefaultFile[] = [
  { name: SOUL_FILENAME, content: `${DEFAULT_SOUL}\n`, purpose: "The agent's identity for this workspace" },
  { name: AGENTS_FILENAME, content: DEFAULT_AGENTS, purpose: 'Your project-specific instructions to the agent' },
  { name: MEMORY_FILENAME, content: DEFAULT_MEMORY, purpose: 'What the agent has learned about working here' },
  { name: USER_FILENAME, content: DEFAULT_USER, purpose: 'What the agent has learned about you' },
  { name: IGNORE_FILENAME, content: DEFAULT_IGNORE, purpose: 'Paths the agent should skip when searching' },
  { name: GITIGNORE_FILENAME, content: DEFAULT_GITIGNORE, purpose: 'Paths git should not track' },
];

// Write the default files. Returns the names actually written, so callers can
// tell the user what landed. Best-effort throughout: a write failure must never
// block workspace setup, so failures are skipped rather than thrown.
//
// `names` narrows the write to those entries of the manifest — how the UI
// restores one file rather than all six. Omit it and the whole manifest is
// written, which is what every automatic caller wants. A name that isn't in the
// manifest is ignored rather than an error: the list the caller is choosing from
// came from DEFAULT_FILES in the first place, and the alternative is a failure
// mode that only appears when the two are already out of step.
//
// `overwrite: false` (the default) writes with 'wx' — fail-if-exists — so a
// tuned SOUL.md or hand-maintained .gitignore survives. Every automatic caller
// uses this.
//
// `overwrite: true` replaces every file in the manifest with the current
// defaults. Only the explicit "Reset to defaults" action passes it, and the
// renderer confirms first: the workspace is a git repo so a reset is
// recoverable, but only for what's already COMMITTED — an edit made since the
// last sync tick has no git copy to come back from.
//
// That confirmation names MEMORY.md and USER.md specifically, because overwrite
// EMPTIES them. Everything else in the manifest is text the user wrote and could
// write again; those two are everything the agent has learned.
export async function ensureWorkspaceFiles(
  workspacePath: string,
  { overwrite = false, names }: { overwrite?: boolean; names?: string[] } = {},
): Promise<string[]> {
  if (!workspacePath) return [];
  const wanted = names?.length ? new Set(names) : null;
  const written: string[] = [];
  for (const file of DEFAULT_FILES) {
    if (wanted && !wanted.has(file.name)) continue;
    try {
      await fs.writeFile(join(workspacePath, file.name), file.content, overwrite ? undefined : { flag: 'wx' });
      written.push(file.name);
    } catch {
      // Already exists (when not overwriting), or unwritable: leave it alone.
    }
  }
  return written;
}

// Which defaults are absent — lets the UI say what an explicit run would add
// before the user commits to it.
export async function missingWorkspaceFiles(workspacePath: string): Promise<string[]> {
  if (!workspacePath) return [];
  const missing: string[] = [];
  for (const file of DEFAULT_FILES) {
    try {
      await fs.access(join(workspacePath, file.name));
    } catch {
      missing.push(file.name);
    }
  }
  return missing;
}
