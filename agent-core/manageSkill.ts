// Creating and editing skills — the one validated way to write a SKILL.md.
//
// Ported from hermes-agent `tools/manage_skillr_tool.py`. Five actions rather
// than six: **there is no `delete`.** hermes' delete carries the heaviest
// machinery in that file — a fail-closed consolidation guard, `absorbed_into`
// validation, recursive-delete containment, and an archive-vs-remove branch on
// caller — and every piece of it exists to serve hermes' curator, which we do
// not have. An autonomous delete with no curator is risk with no payoff. A skill
// can still be retired by patching it, which leaves a diff instead of a hole.
//
// ── Ownership is a directory, not a database ────────────────────────────────
//
// hermes needs a `.usage.json` sidecar (`tools/skill_usage.py`, ~1100 lines) to
// tell agent-created skills from bundled, hub-installed and hand-written ones,
// because all of them live in one tree. Ours are in three physically separate
// places, so the same question is answered by the path:
//
//   builtinDir                      the app's    — not even in the checkout
//   <ws>/.shockwave/skills/         the user's   — uploaded, read-only to us
//   <ws>/.agents/skills/            the agent's  — the only writable root
//
// That removes the entire class of bug hermes hit in #67140, where the guard's
// own bookkeeping side effect flipped the answer on the second call.
//
// ── Two guards, and the second is not obvious ───────────────────────────────
//
// 1. Writes are confined to the agent's root, symlinks resolved first.
// 2. `create` refuses a name that exists in ANY root — including the ones it
//    cannot write to. This is the non-obvious one and it matters: **pi keeps
//    exactly one skill per name, and the agent's directory WINS.** Verified
//    against pi directly: with the same name in `.agents/skills` and in an
//    explicitly-declared path, pi loads the `.agents` copy and emits a
//    `name "dup" collision` diagnostic that nothing surfaces. So without this
//    check the agent could shadow a skill the user uploaded, silently, just by
//    picking its name. hermes has the same rule for the same reason
//    (`_create_skill` → `_find_skill` across every root).
//
// Names are compared on the FRONTMATTER name, not the folder, because that is
// what pi keys on. `validateFrontmatter` requires the two to match on write, so
// for anything we wrote they are the same string.

import path from 'node:path';
import fs from 'node:fs/promises';

import { fuzzyFindAndReplace, formatNoMatchHint } from './fuzzyMatch.ts';
import {
  MAX_SKILL_FILE_BYTES,
  parseFrontmatter,
  validateContentSize,
  validateFilePath,
  validateFrontmatter,
  validateName,
} from './skillValidate.ts';

export interface SkillRoots {
  /** The agent's own skills — the ONLY directory writes may land in. */
  agentDir: string;
  /** Roots consulted for name collisions but never written to: the workspace's
   *  uploaded skills, and the app's built-ins. */
  protectedDirs: string[];
}

export type ManageAction = 'create' | 'edit' | 'patch' | 'write_file' | 'remove_file';

export interface ManageArgs {
  action: ManageAction;
  name: string;
  content?: string;
  old_string?: string;
  new_string?: string;
  replace_all?: boolean;
  file_path?: string;
  file_content?: string;
}

export type ManageResult =
  | { success: true; message: string }
  | { success: false; error: string; preview?: string };

/** True when `abs` is inside `root` once both have their symlinks resolved. */
async function containedIn(abs: string, root: string): Promise<boolean> {
  const real = async (p: string) => {
    try { return await fs.realpath(p); } catch { return path.resolve(p); }
  };
  // Resolve the deepest existing ancestor: the target itself may not exist yet.
  let probe = abs;
  for (;;) {
    try { await fs.access(probe); break; } catch { /* keep walking up */ }
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  const realProbe = await real(probe);
  const tail = path.relative(probe, abs);
  const resolved = path.resolve(realProbe, tail);
  const realRoot = await real(root);
  const rel = path.relative(realRoot, resolved);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** The frontmatter name of the skill in `dir`, or null when there is no SKILL.md. */
async function skillNameAt(dir: string): Promise<string | null> {
  try {
    const text = await fs.readFile(path.join(dir, 'SKILL.md'), 'utf8');
    return parseFrontmatter(text).name || path.basename(dir);
  } catch {
    return null;
  }
}

/** Find a skill by name across every root. Frontmatter name is the identity. */
async function findSkill(
  name: string, roots: SkillRoots,
): Promise<{ dir: string; root: string; writable: boolean } | null> {
  const all = [
    { root: roots.agentDir, writable: true },
    ...roots.protectedDirs.map((root) => ({ root, writable: false })),
  ];
  for (const { root, writable } of all) {
    let entries: string[];
    try { entries = await fs.readdir(root); } catch { continue; } // root doesn't exist yet
    for (const entry of entries) {
      if (entry.startsWith('.')) continue;
      const dir = path.join(root, entry);
      try { if (!(await fs.stat(dir)).isDirectory()) continue; } catch { continue; }
      if ((await skillNameAt(dir)) === name) return { dir, root, writable };
    }
  }
  return null;
}

const ok = (message: string): ManageResult => ({ success: true, message });
const err = (error: string, preview?: string): ManageResult => ({ success: false, error, preview });

/** Locate an existing skill for mutation, refusing anything outside the agent's root. */
async function resolveForWrite(name: string, roots: SkillRoots): Promise<{ dir: string } | ManageResult> {
  const found = await findSkill(name, roots);
  if (!found) {
    return err(`Skill '${name}' not found.`);
  }
  if (!found.writable) {
    return err(
      `Skill '${name}' is not yours to edit — it lives in ${found.root}, which holds `
      + `skills the user provided. Say so in your reply instead of changing it.`,
    );
  }
  return { dir: found.dir };
}

async function writeFileAtomic(abs: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp`;
  await fs.writeFile(tmp, content, 'utf8');
  await fs.rename(tmp, abs);
}

async function exists(abs: string): Promise<boolean> {
  try { await fs.access(abs); return true; } catch { return false; }
}

/**
 * Run one skill-management action.
 *
 * `hasRead` is the read-before-write gate. Supplied only for review runs, where
 * nobody is watching; a normal chat passes nothing and the gate does not apply.
 * hermes splits it the same way, on `is_background_review()`. The point is that
 * an unattended agent must not rewrite content it only inferred from a
 * transcript — it has to have actually loaded the file this run.
 */
export async function manageSkill(
  roots: SkillRoots,
  args: ManageArgs,
  hasRead?: (absPath: string) => boolean,
): Promise<ManageResult> {
  const { action, name } = args;

  const nameErr = validateName(name);
  if (nameErr) return err(nameErr);

  /** Refuse a write to a path that isn't inside the agent's own root. */
  const guardContainment = async (abs: string): Promise<ManageResult | null> => {
    if (await containedIn(abs, roots.agentDir)) return null;
    return err(`Refusing to write outside your own skills directory (${roots.agentDir}).`);
  };

  /** Refuse a mutation of a file this run has not loaded. */
  const guardRead = (abs: string, label: string): ManageResult | null => {
    if (!hasRead || hasRead(abs)) return null;
    return err(
      `Refusing to ${action} '${name}': you have not read ${label} in this run. `
      + `Read the file first, then retry the edit using the content you just read.`,
    );
  };

  switch (action) {
    case 'create': {
      const content = args.content;
      if (!content) return err("'content' (the full SKILL.md) is required for 'create'.");

      const fmErr = validateFrontmatter(content, name);
      if (fmErr) return err(fmErr);
      const sizeErr = validateContentSize(content);
      if (sizeErr) return err(sizeErr);

      // Across EVERY root, not just the writable one — see the header.
      const dup = await findSkill(name, roots);
      if (dup) {
        return err(
          `A skill named '${name}' already exists at ${dup.dir}.`
          + (dup.writable
            ? " Use action 'patch' to change it."
            : ' It belongs to the user. Choose a different name —'
              + ' creating yours would silently take precedence over theirs.'),
        );
      }

      const abs = path.join(roots.agentDir, name, 'SKILL.md');
      const contained = await guardContainment(abs);
      if (contained) return contained;

      await writeFileAtomic(abs, content);
      return ok(`Skill '${name}' created.`);
    }

    case 'edit': {
      const content = args.content;
      if (!content) return err("'content' (the full updated SKILL.md) is required for 'edit'.");

      const fmErr = validateFrontmatter(content, name);
      if (fmErr) return err(fmErr);
      const sizeErr = validateContentSize(content);
      if (sizeErr) return err(sizeErr);

      const target = await resolveForWrite(name, roots);
      if ('success' in target) return target;

      const abs = path.join(target.dir, 'SKILL.md');
      const contained = await guardContainment(abs);
      if (contained) return contained;
      const readGuard = guardRead(abs, 'SKILL.md');
      if (readGuard) return readGuard;

      await writeFileAtomic(abs, content);
      return ok(`Skill '${name}' updated.`);
    }

    case 'patch': {
      const oldString = args.old_string;
      const newString = args.new_string;
      if (!oldString) return err("'old_string' is required for 'patch'.");
      if (newString === undefined || newString === null) {
        return err("'new_string' is required for 'patch' (use an empty string to delete text).");
      }

      const target = await resolveForWrite(name, roots);
      if ('success' in target) return target;

      const patchingSkillMd = !args.file_path;
      let abs = path.join(target.dir, 'SKILL.md');
      if (args.file_path) {
        const pErr = validateFilePath(args.file_path);
        if (pErr) return err(pErr);
        abs = path.join(target.dir, args.file_path);
      }

      const contained = await guardContainment(abs);
      if (contained) return contained;

      let current: string;
      try {
        current = await fs.readFile(abs, 'utf8');
      } catch {
        return err(`File not found: ${args.file_path ?? 'SKILL.md'} in skill '${name}'.`);
      }

      const readGuard = guardRead(abs, args.file_path ?? 'SKILL.md');
      if (readGuard) return readGuard;

      const result = fuzzyFindAndReplace(current, oldString, newString, args.replace_all ?? false);
      if (result.error) {
        const hint = formatNoMatchHint(result.error, result.count, oldString, current);
        return err(result.error + hint, current.slice(0, 500));
      }

      if (patchingSkillMd) {
        const fmErr = validateFrontmatter(result.content, name);
        if (fmErr) return err(`Patch would break SKILL.md: ${fmErr}`);
      }
      const sizeErr = validateContentSize(result.content, args.file_path ?? 'SKILL.md');
      if (sizeErr) return err(sizeErr);

      await writeFileAtomic(abs, result.content);
      return ok(
        `Patched ${args.file_path ?? 'SKILL.md'} in '${name}' `
        + `(${result.count} replacement${result.count === 1 ? '' : 's'}, ${result.strategy}).`,
      );
    }

    case 'write_file': {
      const pErr = validateFilePath(args.file_path ?? '');
      if (pErr) return err(pErr);
      const fileContent = args.file_content;
      if (fileContent === undefined || fileContent === null) {
        return err("'file_content' is required for 'write_file'.");
      }
      const bytes = Buffer.byteLength(fileContent, 'utf8');
      if (bytes > MAX_SKILL_FILE_BYTES) {
        return err(
          `File content is ${bytes.toLocaleString()} bytes `
          + `(limit: ${MAX_SKILL_FILE_BYTES.toLocaleString()} bytes / 1 MiB). `
          + `Consider splitting into smaller files.`,
        );
      }
      const sizeErr = validateContentSize(fileContent, args.file_path);
      if (sizeErr) return err(sizeErr);

      const target = await resolveForWrite(name, roots);
      if ('success' in target) return target;

      const abs = path.join(target.dir, args.file_path as string);
      const contained = await guardContainment(abs);
      if (contained) return contained;

      // Only when it already exists: creating a NEW support file has nothing to
      // have read first.
      if (await exists(abs)) {
        const readGuard = guardRead(abs, args.file_path as string);
        if (readGuard) return readGuard;
      }

      await writeFileAtomic(abs, fileContent);
      return ok(`Wrote ${args.file_path} to skill '${name}'.`);
    }

    case 'remove_file': {
      const pErr = validateFilePath(args.file_path ?? '');
      if (pErr) return err(pErr);

      const target = await resolveForWrite(name, roots);
      if ('success' in target) return target;

      const abs = path.join(target.dir, args.file_path as string);
      const contained = await guardContainment(abs);
      if (contained) return contained;

      if (!(await exists(abs))) {
        return err(`File not found: ${args.file_path} in skill '${name}'.`);
      }
      const readGuard = guardRead(abs, args.file_path as string);
      if (readGuard) return readGuard;

      await fs.rm(abs);
      // Tidy an emptied subdirectory, never the skill folder itself.
      const parent = path.dirname(abs);
      if (parent !== target.dir) {
        try { if (!(await fs.readdir(parent)).length) await fs.rmdir(parent); } catch { /* fine */ }
      }
      return ok(`Removed ${args.file_path} from skill '${name}'.`);
    }

    default:
      return err(`Unknown action '${action}'. Use: create, edit, patch, write_file, remove_file.`);
  }
}
