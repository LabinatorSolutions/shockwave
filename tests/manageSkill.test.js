// Writing skills (agent-core/manageSkill.ts + skillValidate.ts) — the one
// validated way a SKILL.md gets written, and the guards that make it safe to
// hand to an agent with nobody watching.
//
// Why this is tested: two of the rules protect the USER's files, and both fail
// silently if they regress.
//
//   * Containment keeps writes inside the agent's own directory. Break it and
//     the agent edits skills the user uploaded.
//   * The create-collision check refuses a name that exists in any root — even
//     one we can't write to. Break it and the agent shadows a user's skill
//     without touching it: pi keeps ONE skill per name and the agent's
//     directory wins, logging a collision diagnostic nothing surfaces. Verified
//     against pi directly before this was written.
//
// The read-before-write gate is the third: an unattended agent must not rewrite
// content it only inferred from a conversation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { manageSkill } from '../agent-core/manageSkill.ts';
import {
  validateName, validateFrontmatter, validateFilePath, parseFrontmatter,
} from '../agent-core/skillValidate.ts';

const SKILL = (name, body = 'Body.') =>
  `---\nname: ${name}\ndescription: Use when testing ${name}. A probe skill.\n---\n\n# ${name}\n\n${body}\n`;

/** A workspace with the three roots, plus helpers. */
async function makeRoots() {
  // realpath: macOS puts temp dirs under a symlinked /var, and containment
  // resolves before comparing, so the roots must be resolved too.
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'manageskill-')));
  const agentDir = path.join(base, '.agents', 'skills');
  const uploaded = path.join(base, '.shockwave', 'skills');
  const builtin = path.join(base, 'builtins');
  await fs.mkdir(agentDir, { recursive: true });
  await fs.mkdir(uploaded, { recursive: true });
  await fs.mkdir(builtin, { recursive: true });
  return {
    base,
    roots: { agentDir, protectedDirs: [uploaded, builtin] },
    async seed(root, name, body) {
      await fs.mkdir(path.join(root, name), { recursive: true });
      await fs.writeFile(path.join(root, name, 'SKILL.md'), SKILL(name, body));
    },
    uploaded,
    builtin,
    agentDir,
    read: (p) => fs.readFile(path.join(base, p), 'utf8'),
  };
}

// ── create ───────────────────────────────────────────────────────────────────

test('create writes into the agent directory', async () => {
  const t = await makeRoots();
  const r = await manageSkill(t.roots, { action: 'create', name: 'pdf-tools', content: SKILL('pdf-tools') });
  assert.equal(r.success, true);
  const written = await fs.readFile(path.join(t.agentDir, 'pdf-tools', 'SKILL.md'), 'utf8');
  assert.match(written, /# pdf-tools/);
});

test('create refuses a name that already exists in the agent directory', async () => {
  const t = await makeRoots();
  await t.seed(t.agentDir, 'pdf-tools');
  const r = await manageSkill(t.roots, { action: 'create', name: 'pdf-tools', content: SKILL('pdf-tools') });
  assert.equal(r.success, false);
  assert.match(r.error, /already exists/);
  assert.match(r.error, /action 'patch'/, 'should point at the action that would work');
});

test("GUARD: create refuses a name the USER already uses, so it can't shadow theirs", async () => {
  const t = await makeRoots();
  await t.seed(t.uploaded, 'pdf-tools', 'The user wrote this.');
  const r = await manageSkill(t.roots, { action: 'create', name: 'pdf-tools', content: SKILL('pdf-tools') });
  assert.equal(r.success, false);
  assert.match(r.error, /belongs to the user/);
  // and nothing was written
  await assert.rejects(() => fs.access(path.join(t.agentDir, 'pdf-tools')));
  // the user's file is untouched
  assert.match(await fs.readFile(path.join(t.uploaded, 'pdf-tools', 'SKILL.md'), 'utf8'), /The user wrote this/);
});

test('GUARD: create refuses a name a built-in already uses', async () => {
  const t = await makeRoots();
  await t.seed(t.builtin, 'firecrawl');
  const r = await manageSkill(t.roots, { action: 'create', name: 'firecrawl', content: SKILL('firecrawl') });
  assert.equal(r.success, false);
  assert.match(r.error, /already exists/);
});

test('create collision is decided on the FRONTMATTER name, not the folder', async () => {
  const t = await makeRoots();
  // Folder says "whatever", frontmatter says "pdf-tools" — pi keys on the latter.
  await fs.mkdir(path.join(t.uploaded, 'whatever'), { recursive: true });
  await fs.writeFile(path.join(t.uploaded, 'whatever', 'SKILL.md'), SKILL('pdf-tools'));
  const r = await manageSkill(t.roots, { action: 'create', name: 'pdf-tools', content: SKILL('pdf-tools') });
  assert.equal(r.success, false, 'folder name differs but the loaded name collides');
});

test('create rejects a frontmatter name that disagrees with the skill name', async () => {
  const t = await makeRoots();
  const r = await manageSkill(t.roots, { action: 'create', name: 'alpha', content: SKILL('beta') });
  assert.equal(r.success, false);
  assert.match(r.error, /must match/);
});

// ── edit / patch confinement ─────────────────────────────────────────────────

test("GUARD: edit refuses a skill in the user's uploaded directory", async () => {
  const t = await makeRoots();
  await t.seed(t.uploaded, 'notes', 'Original.');
  const r = await manageSkill(t.roots, { action: 'edit', name: 'notes', content: SKILL('notes', 'Rewritten.') });
  assert.equal(r.success, false);
  assert.match(r.error, /not yours to edit/);
  assert.match(await fs.readFile(path.join(t.uploaded, 'notes', 'SKILL.md'), 'utf8'), /Original\./);
});

test('GUARD: patch refuses a built-in skill', async () => {
  const t = await makeRoots();
  await t.seed(t.builtin, 'firecrawl', 'Vendor text.');
  const r = await manageSkill(t.roots, {
    action: 'patch', name: 'firecrawl', old_string: 'Vendor text.', new_string: 'Mine now.',
  });
  assert.equal(r.success, false);
  assert.match(r.error, /not yours to edit/);
});

test('patch edits the agent\'s own skill through the fuzzy matcher', async () => {
  const t = await makeRoots();
  await t.seed(t.agentDir, 'pdf-tools', 'Step one.');
  const r = await manageSkill(t.roots, {
    action: 'patch', name: 'pdf-tools', old_string: 'Step one.', new_string: 'Step one, revised.',
  });
  assert.equal(r.success, true);
  assert.match(r.message, /1 replacement, exact/);
  assert.match(await fs.readFile(path.join(t.agentDir, 'pdf-tools', 'SKILL.md'), 'utf8'), /Step one, revised\./);
});

test('a patch that would break the frontmatter is refused', async () => {
  const t = await makeRoots();
  await t.seed(t.agentDir, 'pdf-tools');
  const r = await manageSkill(t.roots, {
    action: 'patch', name: 'pdf-tools', old_string: 'name: pdf-tools', new_string: 'nome: pdf-tools',
  });
  assert.equal(r.success, false);
  assert.match(r.error, /Patch would break SKILL\.md/);
});

test('a failed patch returns the did-you-mean hint and a preview', async () => {
  const t = await makeRoots();
  await t.seed(t.agentDir, 'pdf-tools', 'Run the extractor.');
  // Similar enough to earn a hint, far enough off that no strategy matches —
  // a one-character typo genuinely IS found, which is the point of the chain.
  const r = await manageSkill(t.roots, {
    action: 'patch', name: 'pdf-tools', old_string: 'Run the completely different instruction text', new_string: 'x',
  });
  assert.equal(r.success, false);
  assert.match(r.error, /Could not find a match/);
  assert.match(r.error, /Did you mean one of these sections\?/);
  assert.ok(r.preview, 'a preview of the file helps the model self-correct');
});

// ── read-before-write ────────────────────────────────────────────────────────

test('GUARD: patch is refused when the run has not read the file', async () => {
  const t = await makeRoots();
  await t.seed(t.agentDir, 'pdf-tools', 'Step one.');
  const never = () => false;
  const r = await manageSkill(
    t.roots,
    { action: 'patch', name: 'pdf-tools', old_string: 'Step one.', new_string: 'Changed.' },
    never,
  );
  assert.equal(r.success, false);
  assert.match(r.error, /have not read SKILL\.md in this run/);
  assert.match(await fs.readFile(path.join(t.agentDir, 'pdf-tools', 'SKILL.md'), 'utf8'), /Step one\./);
});

test('the same patch succeeds once the file has been read', async () => {
  const t = await makeRoots();
  await t.seed(t.agentDir, 'pdf-tools', 'Step one.');
  const seen = new Set([path.join(t.agentDir, 'pdf-tools', 'SKILL.md')]);
  const r = await manageSkill(
    t.roots,
    { action: 'patch', name: 'pdf-tools', old_string: 'Step one.', new_string: 'Changed.' },
    (p) => seen.has(p),
  );
  assert.equal(r.success, true);
});

test('the gate does not apply when no reader is supplied (an ordinary chat)', async () => {
  const t = await makeRoots();
  await t.seed(t.agentDir, 'pdf-tools', 'Step one.');
  const r = await manageSkill(t.roots, {
    action: 'patch', name: 'pdf-tools', old_string: 'Step one.', new_string: 'Changed.',
  });
  assert.equal(r.success, true, 'a user is present; hermes splits the gate the same way');
});

test('creating a NEW support file needs no prior read; overwriting one does', async () => {
  const t = await makeRoots();
  await t.seed(t.agentDir, 'pdf-tools');
  const never = () => false;

  const fresh = await manageSkill(
    t.roots,
    { action: 'write_file', name: 'pdf-tools', file_path: 'references/api.md', file_content: 'notes' },
    never,
  );
  assert.equal(fresh.success, true, 'nothing existed to have read');

  const over = await manageSkill(
    t.roots,
    { action: 'write_file', name: 'pdf-tools', file_path: 'references/api.md', file_content: 'replaced' },
    never,
  );
  assert.equal(over.success, false);
  assert.match(over.error, /have not read references\/api\.md/);
});

// ── support files ────────────────────────────────────────────────────────────

test('write_file and remove_file round-trip, and tidy the emptied folder', async () => {
  const t = await makeRoots();
  await t.seed(t.agentDir, 'pdf-tools');
  const w = await manageSkill(t.roots, {
    action: 'write_file', name: 'pdf-tools', file_path: 'scripts/check.sh', file_content: '#!/bin/sh\n',
  });
  assert.equal(w.success, true);

  const r = await manageSkill(t.roots, {
    action: 'remove_file', name: 'pdf-tools', file_path: 'scripts/check.sh',
  });
  assert.equal(r.success, true);
  await assert.rejects(
    () => fs.access(path.join(t.agentDir, 'pdf-tools', 'scripts')),
    'the emptied subdirectory is cleaned up',
  );
  // but the skill itself survives
  await fs.access(path.join(t.agentDir, 'pdf-tools', 'SKILL.md'));
});

test('GUARD: a traversing file_path is refused before anything is touched', async () => {
  const t = await makeRoots();
  await t.seed(t.agentDir, 'pdf-tools');
  for (const bad of ['../../escape.md', 'references/../../escape.md', '/etc/passwd']) {
    const r = await manageSkill(t.roots, {
      action: 'write_file', name: 'pdf-tools', file_path: bad, file_content: 'x',
    });
    assert.equal(r.success, false, `${bad} must be refused`);
  }
  await assert.rejects(() => fs.access(path.join(t.base, 'escape.md')));
});

test('GUARD: a symlink out of the agent directory does not get written through', async () => {
  const t = await makeRoots();
  await t.seed(t.agentDir, 'pdf-tools');
  const outside = path.join(t.base, 'outside');
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(outside, 'target.md'), 'original');
  // references/ is a symlink pointing outside the agent's root
  await fs.symlink(outside, path.join(t.agentDir, 'pdf-tools', 'references'));

  const r = await manageSkill(t.roots, {
    action: 'write_file', name: 'pdf-tools', file_path: 'references/target.md', file_content: 'hijacked',
  });
  assert.equal(r.success, false);
  assert.match(r.error, /outside your own skills directory/);
  assert.equal(await fs.readFile(path.join(outside, 'target.md'), 'utf8'), 'original');
});

// ── unknown skills and actions ───────────────────────────────────────────────

test('editing a skill that does not exist says so', async () => {
  const t = await makeRoots();
  const r = await manageSkill(t.roots, { action: 'edit', name: 'nope', content: SKILL('nope') });
  assert.equal(r.success, false);
  assert.match(r.error, /not found/);
});

test('there is no delete action', async () => {
  const t = await makeRoots();
  await t.seed(t.agentDir, 'pdf-tools');
  const r = await manageSkill(t.roots, { action: 'delete', name: 'pdf-tools' });
  assert.equal(r.success, false);
  assert.match(r.error, /Unknown action/);
  await fs.access(path.join(t.agentDir, 'pdf-tools', 'SKILL.md'));
});

// ── validators ───────────────────────────────────────────────────────────────

test("validateName follows pi's rule, which is stricter than hermes'", () => {
  assert.equal(validateName('pdf-tools'), null);
  assert.equal(validateName('a1'), null);
  // hermes would accept these two; pi warns on them, so we refuse.
  assert.match(validateName('pdf_tools'), /lowercase letters, numbers, and hyphens/);
  assert.match(validateName('pdf.tools'), /lowercase letters, numbers, and hyphens/);
  assert.match(validateName('-lead'), /start or end with a hyphen/);
  assert.match(validateName('trail-'), /start or end with a hyphen/);
  assert.match(validateName('double--hyphen'), /consecutive hyphens/);
  assert.match(validateName('X'), /lowercase/);
  assert.match(validateName('a'.repeat(65)), /exceeds 64/);
  assert.match(validateName(''), /required/);
});

test('validateFrontmatter catches every structural failure', () => {
  assert.match(validateFrontmatter(''), /cannot be empty/);
  assert.match(validateFrontmatter('# no frontmatter'), /must start with YAML frontmatter/);
  assert.match(validateFrontmatter('---\nname: a\n'), /not closed/);
  assert.match(validateFrontmatter('---\ndescription: d\n---\n\nbody'), /must include 'name'/);
  assert.match(validateFrontmatter('---\nname: a\n---\n\nbody'), /must include 'description'/);
  assert.match(validateFrontmatter('---\nname: a\ndescription: d\n---\n\n'), /must have content after/);
  assert.equal(validateFrontmatter(SKILL('a')), null);
});

test('a description over pi\'s 1024 ceiling is refused, but a long one is fine', () => {
  const long = `---\nname: a\ndescription: ${'x'.repeat(300)}\n---\n\nbody\n`;
  assert.equal(validateFrontmatter(long), null, "hermes' 60-char limit is NOT ported — pi does not truncate");
  const tooLong = `---\nname: a\ndescription: ${'x'.repeat(1100)}\n---\n\nbody\n`;
  assert.match(validateFrontmatter(tooLong), /exceeds 1024/);
});

test('a UTF-8 BOM before the fence is tolerated', () => {
  assert.equal(validateFrontmatter('﻿' + SKILL('a')), null);
});

test('parseFrontmatter reads block scalars', () => {
  const fm = parseFrontmatter('---\nname: a\ndescription: |\n  line one\n  line two\n---\n\nbody\n');
  assert.equal(fm.name, 'a');
  assert.equal(fm.description, 'line one\nline two');
});

test('validateFilePath allows the four subdirectories and SKILL.md only', () => {
  assert.equal(validateFilePath('references/a.md'), null);
  assert.equal(validateFilePath('templates/a.yaml'), null);
  assert.equal(validateFilePath('scripts/a.sh'), null);
  assert.equal(validateFilePath('assets/a.png'), null);
  assert.equal(validateFilePath('SKILL.md'), null);
  assert.match(validateFilePath('src/a.md'), /must be under one of/);
  assert.match(validateFilePath('references'), /not just a directory/);
  assert.match(validateFilePath(''), /required/);
  assert.match(validateFilePath('../x'), /traversal/);
});
