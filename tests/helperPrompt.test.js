// The helper prompt (agent-core/defaults/helper.ts) — the operating manual every
// session gets on top of its SOUL.
//
// Why this is tested: the prompt is assembled from a tool list that now varies by
// source, and **naming a tool the run does not have is worse than saying
// nothing**. The file already applies that rule to `send_message` (the "Reaching
// the user" section is gated on it) — but two other places named tools
// unconditionally, and the review run is the first source narrow
// enough to expose them:
//
//   * the tool section closed with "Reach for `bash` to run programs, git, and
//     anything the other tools don't cover"
//   * the guidelines opened with a rule about `get_agent_secret`
//
// Both appeared in a run that had neither tool, immediately after the line "This
// is the complete set — there are no others." Anyone reading that prompt would
// conclude the run had bash. It is also how a reviewer of this feature concluded
// exactly that.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildShockwaveHelper } from '../agent-core/defaults/helper.ts';
import { toolsForSource } from '../agent-core/defaults/tools.ts';

const helperFor = (source) => buildShockwaveHelper({
  tools: toolsForSource(source),
  unattended: source === 'review' || source === 'cron' || source === 'memory',
  source,
});

test('a review run is never told about a tool it does not have', () => {
  const h = helperFor('review');
  for (const absent of ['bash', 'write', 'edit', 'get_agent_secret', 'send_message', 'daily_note', 'open_file']) {
    assert.ok(!h.includes(`\`${absent}\``), `the prompt names \`${absent}\`, which a review run does not have`);
  }
});

test('a review run IS told about the tools it does have', () => {
  const h = helperFor('review');
  for (const present of ['read', 'grep', 'find', 'ls', 'manage_skill']) {
    assert.ok(h.includes(`- \`${present}\``), `missing \`${present}\` from the tool list`);
  }
  assert.ok(h.includes('This is the complete set — there are no others.'));
});

test('the bash-vs-search advice survives where bash exists', () => {
  // The advice is about choosing BETWEEN tools, so it belongs wherever both are
  // present — removing it everywhere would be the opposite mistake.
  for (const source of ['desktop', 'cron', 'telegram']) {
    const h = helperFor(source);
    assert.ok(
      h.includes('rather than shelling out through `bash`'),
      `${source} should still get the search-tools-over-bash advice`,
    );
    assert.ok(h.includes('Reach for `bash` to run programs'), `${source} keeps the bash guidance`);
  }
});

test('the secret-handling guideline appears only where the secret tool does', () => {
  assert.ok(helperFor('desktop').includes('Do not echo a token returned by `get_agent_secret`'));
  assert.ok(!helperFor('review').includes('Do not echo a token returned by'));
  // The guidelines that apply to every run are always there.
  for (const source of ['desktop', 'review']) {
    assert.ok(helperFor(source).includes('- Be concise in your responses.'), source);
    assert.ok(helperFor(source).includes('- Show file paths clearly when working with files.'), source);
  }
});

test('the Telegram section is still gated on send_message, as it always was', () => {
  assert.ok(helperFor('desktop').includes('# Reaching the user'));
  assert.ok(!helperFor('review').includes('# Reaching the user'));
});

test('a review run gets the unattended override — nobody is there to ask', () => {
  assert.ok(helperFor('review').includes('# Unattended run'));
  assert.ok(!helperFor('desktop').includes('# Unattended run'));
});

// ── The memory run ───────────────────────────────────────────────────────────
//
// The same rule, applied to the other background process. Its tool set is
// narrower still — one name — so it is the sharpest test of the gating there is.

test('a memory run holds exactly one tool, and the prompt says so', () => {
  const h = helperFor('memory');
  assert.ok(h.includes('- `memory`'));
  for (const absent of [
    'read', 'bash', 'write', 'edit', 'grep', 'find', 'ls',
    'manage_skill', 'get_agent_secret', 'send_message', 'daily_note', 'open_file', 'search_chats',
  ]) {
    assert.ok(!h.includes(`\`${absent}\``), `the prompt names \`${absent}\`, which a memory run does not have`);
  }
});

test('a memory run gets the unattended override — nobody is there to ask', () => {
  assert.ok(helperFor('memory').includes('# Unattended run'));
});

test('the Memory section is gated on holding the tool', () => {
  // Present wherever the agent can write memory...
  for (const source of ['desktop', 'telegram', 'cron', 'memory']) {
    assert.ok(helperFor(source).includes('# Memory'), `missing the Memory section on ${source}`);
  }
  // ...and absent on the review run, which carries the memory BLOCK (facts about
  // the user, useful when writing skills) but cannot write to it. Telling it how
  // to save would be naming a tool it does not have.
  assert.ok(!helperFor('review').includes('# Memory'));
});

test('the section says which files these are, because the user can open them', () => {
  const h = helperFor('desktop');
  assert.ok(h.includes('`MEMORY.md`'));
  assert.ok(h.includes('`USER.md`'));
  // The rule that keeps the budget enforceable: writing them by hand bypasses it.
  assert.ok(h.includes('rather than editing the files directly'));
});

test('the memory block goes in LAST, after every instruction section', () => {
  // Closest to the conversation, which is where hermes puts it. It also has to
  // sit after HELPER_MARK so `rebuildSystemPrompt` regenerates it on resume —
  // that is what makes a fact saved in one chat known to the next.
  const block = '══ pretend block ══';
  const h = buildShockwaveHelper({ tools: toolsForSource('desktop'), source: 'desktop', memory: block });
  assert.ok(h.endsWith(block));
  assert.ok(h.indexOf(block) > h.indexOf('# Creating skills'));
});

test('no memory means no block, not an empty heading', () => {
  const h = buildShockwaveHelper({ tools: toolsForSource('desktop'), source: 'desktop' });
  assert.ok(!h.endsWith('\n\n'));
});

test('sections that teach a tool are gone wherever that tool is', () => {
  // Generalised from two real cases found while adding the memory run: the
  // link-graph section hands over a `grep` pattern to run, and the skill section
  // is authoring guidance. Both used to be unconditional, so the narrowest run
  // in the app was told to use tools it had never been given.
  assert.ok(!helperFor('memory').includes('# Using the link graph to research'));
  assert.ok(!helperFor('memory').includes('# Creating skills'));
  for (const source of ['desktop', 'telegram', 'cron', 'review']) {
    assert.ok(helperFor(source).includes('# Using the link graph to research'), source);
    assert.ok(helperFor(source).includes('# Creating skills'), source);
  }
});
