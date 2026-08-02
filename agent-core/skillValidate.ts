// What a skill has to look like before we write it — names, frontmatter, sizes,
// and where a supporting file may live.
//
// Ported from hermes-agent `tools/manage_skillr_tool.py` (its `_validate_*`
// helpers). Two deliberate departures, both because pi is the loader here and
// hermes' own loader is not:
//
//   1. THE NAME RULE IS PI'S, NOT HERMES'. hermes accepts `^[a-z0-9][a-z0-9._-]*$`
//      — dots and underscores included. pi's spec check (`validateName` in
//      pi-coding-agent/dist/core/skills.js) is stricter: lowercase letters,
//      digits and hyphens only, no leading or trailing hyphen, no consecutive
//      hyphens. Writing a name hermes would accept and pi warns about would
//      produce a skill that loads with a complaint nobody sees, so we enforce
//      the stricter of the two.
//
//   2. HERMES' 60-CHARACTER DESCRIPTION LIMIT IS NOT PORTED. It exists because
//      hermes truncates descriptions to 57 chars + "..." when it renders its
//      skill index, so a longer one silently loses the trigger that decides
//      whether the skill fires. pi does not truncate — `formatSkillsForPrompt`
//      emits `skill.description` whole — so the limit would impose a constraint
//      that does not exist here, and would contradict our own authoring guidance,
//      which tells the agent to list trigger phrases. Only pi's own 1024 ceiling
//      applies.
//
// The frontmatter parser lives here rather than in `skillLibrary.ts` so there is
// exactly ONE of it: this module is under test, and a second copy of a parser is
// how the two drift. `skillLibrary.ts` imports it from here.

/** pi's spec limits (`MAX_NAME_LENGTH` / `MAX_DESCRIPTION_LENGTH`). Same numbers
 *  hermes uses, which is why they need no reconciling. */
export const MAX_NAME_LENGTH = 64;
export const MAX_DESCRIPTION_LENGTH = 1024;

/** hermes' write ceilings: ~36k tokens of SKILL.md, 1 MiB per supporting file. */
export const MAX_SKILL_CONTENT_CHARS = 100_000;
export const MAX_SKILL_FILE_BYTES = 1_048_576;

/** Subdirectories a supporting file may live in. */
export const ALLOWED_SUBDIRS = new Set(['references', 'templates', 'scripts', 'assets']);

/** pi's name rule, which is stricter than hermes'. See the header. */
const VALID_NAME_RE = /^[a-z0-9-]+$/;

export interface Frontmatter {
  name?: string;
  description?: string;
  [key: string]: string | undefined;
}

/**
 * Pull `name`, `description` and friends out of `--- … ---` YAML frontmatter.
 * Handles inline values and block scalars (`description: |` / `: >` with the
 * text on following indented lines), which are common in SKILL.md files.
 *
 * A leading UTF-8 BOM is stripped first — Windows editors add one, and hermes
 * had to widen BOM tolerance across all its frontmatter parsers for exactly this
 * (`780e09807`).
 */
export function parseFrontmatter(text: string): Frontmatter {
  const stripped = text.replace(/^﻿/, '');
  const m = stripped.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!m) return {};
  const lines = m[1].split('\n');
  const out: Frontmatter = {};
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    let val = kv[2].trim();
    if (/^[|>][+-]?$/.test(val)) {
      // Block scalar: gather the following more-indented lines. `>` folds onto
      // one line (spaces); `|` keeps newlines.
      const fold = val[0] === '>';
      const collected: string[] = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        if (lines[j].trim() === '') { collected.push(''); continue; }
        if (/^\s/.test(lines[j])) collected.push(lines[j].replace(/^\s+/, ''));
        else break;
      }
      i = j - 1;
      val = collected.join(fold ? ' ' : '\n').trim();
    } else if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

/** Validate a skill name. Returns an error message, or null when valid. */
export function validateName(name: string): string | null {
  if (!name) return 'Skill name is required.';
  if (name.length > MAX_NAME_LENGTH) return `Skill name exceeds ${MAX_NAME_LENGTH} characters.`;
  if (!VALID_NAME_RE.test(name)) {
    return `Invalid skill name '${name}'. Use lowercase letters, numbers, and hyphens only.`;
  }
  if (name.startsWith('-') || name.endsWith('-')) {
    return `Invalid skill name '${name}'. It must not start or end with a hyphen.`;
  }
  if (name.includes('--')) {
    return `Invalid skill name '${name}'. It must not contain consecutive hyphens.`;
  }
  return null;
}

/**
 * Validate a SKILL.md body: frontmatter present and closed, `name` and
 * `description` set, description within pi's ceiling, and something after the
 * frontmatter.
 *
 * `expectName` (the folder the skill will live in) must match the frontmatter
 * `name` when given. That is not cosmetic: **pi keys a skill by its frontmatter
 * name and only falls back to the folder**, so a mismatch means the collision
 * check — which compares names — is looking at the wrong identifier, and a skill
 * could shadow another under a name nobody wrote down.
 */
export function validateFrontmatter(content: string, expectName?: string): string | null {
  if (!content.trim()) return 'Content cannot be empty.';

  // Tolerate a leading UTF-8 BOM (Windows editors) before the fence.
  const text = content.replace(/^﻿/, '');

  if (!text.startsWith('---')) {
    return 'SKILL.md must start with YAML frontmatter (---). See existing skills for format.';
  }
  if (!/\n---\s*\n/.test(text.slice(3))) {
    return "SKILL.md frontmatter is not closed. Ensure you have a closing '---' line.";
  }

  const fm = parseFrontmatter(text);
  if (fm.name === undefined) return "Frontmatter must include 'name' field.";
  if (fm.description === undefined) return "Frontmatter must include 'description' field.";

  const desc = String(fm.description);
  if (desc.length > MAX_DESCRIPTION_LENGTH) {
    return `Description exceeds ${MAX_DESCRIPTION_LENGTH} characters.`;
  }
  if (!desc.trim()) return "Frontmatter 'description' cannot be empty.";

  if (expectName !== undefined && fm.name !== expectName) {
    return `Frontmatter name '${fm.name}' must match the skill name '${expectName}'.`;
  }

  const close = text.slice(3).match(/\n---\s*\n/);
  const body = close ? text.slice(3 + (close.index ?? 0) + close[0].length).trim() : '';
  if (!body) {
    return 'SKILL.md must have content after the frontmatter (instructions, procedures, etc.).';
  }

  return null;
}

/** Check that content doesn't exceed the character limit for agent writes. */
export function validateContentSize(content: string, label = 'SKILL.md'): string | null {
  if (content.length > MAX_SKILL_CONTENT_CHARS) {
    return `${label} content is ${content.length.toLocaleString()} characters `
      + `(limit: ${MAX_SKILL_CONTENT_CHARS.toLocaleString()}). `
      + `Consider splitting into a smaller SKILL.md with supporting files `
      + `in references/ or templates/.`;
  }
  return null;
}

/**
 * Validate a supporting-file path for write_file / remove_file.
 *
 * Must sit under an allowed subdirectory and must not escape the skill folder.
 * The traversal check runs FIRST, before the SKILL.md exception below, so that
 * exception can never be reached by a traversal-laden path.
 */
export function validateFilePath(filePath: string): string | null {
  if (!filePath) return 'file_path is required.';

  const parts = filePath.split('/').filter((p) => p !== '' && p !== '.');

  // Prevent path traversal, and reject anything absolute or Windows-drive-shaped
  // before it can be joined onto the skill directory.
  if (parts.includes('..') || filePath.startsWith('/') || /^[A-Za-z]:/.test(filePath)) {
    return "Path traversal ('..') is not allowed.";
  }
  if (filePath.includes('\\')) {
    return 'Use forward slashes in file_path.';
  }

  // SKILL.md is the canonical skill file and lives at the skill root, not under
  // an allowed subdirectory. Accept its two natural spellings — 'SKILL.md' and
  // '<skill-name>/SKILL.md' — so callers can target the main file. The traversal
  // guard above still applies, so this can't escape.
  if (parts.length > 0 && parts[parts.length - 1] === 'SKILL.md' && parts.length <= 2) {
    return null;
  }

  if (!parts.length || !ALLOWED_SUBDIRS.has(parts[0])) {
    const allowed = [...ALLOWED_SUBDIRS].sort().join(', ');
    return `File must be under one of: ${allowed}. Got: '${filePath}'`;
  }

  // Must name a file, not just the directory.
  if (parts.length < 2) {
    return `Provide a file path, not just a directory. Example: '${parts[0]}/myfile.md'`;
  }

  return null;
}
