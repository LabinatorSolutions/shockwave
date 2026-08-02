// The `manage_skill` pi tool, and the `read` override that makes its
// read-before-write guard possible.
//
// Both are built by ONE factory because they share state: the set of files this
// run has actually loaded. `manage_skill` refuses to rewrite a file that isn't
// in it, and the `read` override is what puts things there.
//
// ── Why a `read` override rather than a `skill_view` tool ───────────────────
//
// hermes hangs its read-before-write mark on `skill_view`, a tool that exists
// because hermes' own harness has no native skill loading. pi does: it scans the
// skill directories at boot and puts each skill's name, description and
// LOCATION in the prompt, telling the model to use the `read` tool. So there is
// no place of ours in the path when a skill gets loaded — unless we put one
// there.
//
// pi's tool registry builds built-ins first and then does
// `toolRegistry.set(tool.name, tool)` for every custom tool, so **a custom tool
// named `read` replaces the built-in**. pi also exports the built-in's factory,
// so the override delegates to the real implementation and only watches what
// goes past. Verified against pi before this was written: the registry ends up
// holding one `read`, it is ours, and it returns real file contents.
//
// This is stronger than hermes', which only marks reads that went through
// `skill_view` — a read via its own file tools doesn't count. Ours marks any
// read of the file.
//
// ONE subtlety, found by testing rather than reading: pi's read tool THROWS on a
// missing file rather than returning an error result. The recording therefore
// sits after the await with no catch — a failed read records nothing and the
// throw propagates exactly as it would have without the wrapper.

import path from 'node:path';
import fs from 'node:fs';

import { createReadToolDefinition } from '@earendil-works/pi-coding-agent';

import { manageSkill, type SkillRoots } from './manageSkill.ts';

/** Resolve a path the way both sides of the read-before-write comparison must:
 *  absolute, and through symlinks when they exist. */
function canonical(cwd: string, p: string): string[] {
  const abs = path.isAbsolute(p) ? p : path.resolve(cwd, p);
  const out = [abs];
  try {
    const real = fs.realpathSync(abs);
    if (real !== abs) out.push(real);
  } catch { /* doesn't exist — the absolute form is all we have */ }
  return out;
}

const MANAGE_SKILL_DESCRIPTION =
  'Create or update a skill — your reusable, saved procedures for recurring task '
  + 'types. This validates the file before writing it, so use it rather than '
  + 'writing SKILL.md by hand.\n\n'
  + "Actions: create (a new skill — the full SKILL.md), patch (targeted "
  + 'find-and-replace, PREFERRED for fixes), edit (full SKILL.md rewrite — major '
  + 'overhauls only), write_file (add a supporting file under references/, '
  + 'templates/, scripts/ or assets/), remove_file.\n\n'
  + 'A SKILL.md needs YAML frontmatter with `name` (matching the skill folder) and '
  + 'a specific `description` covering what it does AND when to use it, then a '
  + 'markdown body: trigger conditions, numbered steps with exact commands, '
  + 'pitfalls, and verification steps.\n\n'
  + 'Create when a complex task succeeded, you overcame a tricky error, or you '
  + 'discovered a reusable workflow worth keeping. Patch a skill the moment you '
  + 'find it outdated or wrong — do not wait to be asked.\n\n'
  + 'You can only write your own skills. Skills the user provided, and the ones '
  + 'built into the app, are read-only to you — including a NEW skill whose name '
  + 'matches one of theirs, because yours would take precedence over it. '
  + 'A skill you create or change is loaded from the NEXT session on, not this one.';

export interface SkillToolOptions {
  /** The workspace root a relative read path resolves against. */
  cwd: string;
  /** Where skills live: the agent's writable root plus the read-only ones. */
  roots: SkillRoots;
  /** Review runs only. Adds the `read` override and turns on the
   *  read-before-write guard — the split hermes makes on `is_background_review()`. */
  trackReads?: boolean;
}

/**
 * Build the skill tools for one session.
 *
 * Returns `manage_skill` always, plus a `read` override when `trackReads` is on.
 * Both are filtered against pi's allowlist by the caller, exactly like every
 * other custom tool.
 */
export function makeSkillTools(opts: SkillToolOptions): any[] {
  const { cwd, roots, trackReads = false } = opts;

  // What this run has loaded. Per-session by construction — it lives in this
  // closure, not in a module-level variable, so two concurrent runs on the
  // companion cannot see each other's reads.
  const readPaths = new Set<string>();
  const hasRead = (abs: string): boolean => canonical(cwd, abs).some((p) => readPaths.has(p));

  const manageSkillTool: any = {
    name: 'manage_skill',
    label: 'Manage Skill',
    description: MANAGE_SKILL_DESCRIPTION,
    promptSnippet: 'Create or update one of your skills (validated).',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'patch', 'edit', 'write_file', 'remove_file'],
          description: 'The action to perform.',
        },
        name: {
          type: 'string',
          description: 'Skill name — lowercase letters, digits and hyphens only, and it must match the skill folder.',
        },
        content: {
          type: 'string',
          description: "Full SKILL.md text (frontmatter + body). Required for 'create' and 'edit'.",
        },
        old_string: {
          type: 'string',
          description: "For 'patch': the text to find. Include enough surrounding context to be unique.",
        },
        new_string: {
          type: 'string',
          description: "For 'patch': the replacement text. An empty string deletes the matched text.",
        },
        replace_all: {
          type: 'boolean',
          description: "For 'patch': replace every occurrence instead of requiring a unique match.",
        },
        file_path: {
          type: 'string',
          description:
            "Supporting-file path under references/, templates/, scripts/ or assets/. "
            + "Required for 'write_file' and 'remove_file'; optional for 'patch', which defaults to SKILL.md.",
        },
        file_content: {
          type: 'string',
          description: "The file's contents. Required for 'write_file'.",
        },
      },
      required: ['action', 'name'],
      additionalProperties: false,
    },
    async execute(_id: string, params: any) {
      const result = await manageSkill(
        roots,
        params,
        trackReads ? hasRead : undefined,
      );
      if (result.success) {
        return { content: [{ type: 'text', text: result.message }], details: { action: params?.action, name: params?.name } };
      }
      const text = result.preview
        ? `${result.error}\n\nCurrent contents (first 500 chars):\n${result.preview}`
        : result.error;
      return { content: [{ type: 'text', text }], isError: true };
    },
  };

  if (!trackReads) return [manageSkillTool];

  // Delegate to pi's own read tool and note what came back. Everything about
  // `read` stays exactly as pi defines it — same schema, same description, same
  // truncation — because this IS pi's tool with one line added after it.
  const base = createReadToolDefinition(cwd);
  const readTool: any = {
    ...base,
    async execute(...args: any[]) {
      const result = await (base as any).execute(...args);
      // Only after a successful call: a throw (pi's behaviour for a missing
      // file) skips this and propagates, and an error result records nothing.
      if (!result?.isError) {
        const p = args[1]?.path;
        if (typeof p === 'string' && p) for (const c of canonical(cwd, p)) readPaths.add(c);
      }
      return result;
    },
  };

  return [readTool, manageSkillTool];
}
