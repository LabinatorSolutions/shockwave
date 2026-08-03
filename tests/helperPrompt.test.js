// The helper prompt (agent-core/defaults/helper.ts) — the operating manual every
// session gets on top of its SOUL.
//
// This file used to pin the opposite rule, and the reversal is deliberate.
//
// The old rule was "naming a tool the run does not have is worse than saying
// nothing", because the offered tool set varied by source and a narrow run would
// otherwise read instructions for tools it had never been given. Every run is
// now offered the whole catalog and refused per call (`DENIED` in tools.ts), so
// there is no such thing as a tool the run does not have — a review run holds
// `bash`, it is simply told why it can't use it when it tries, in words it can
// act on.
//
// What replaced that rule is stronger, and it is what this file now pins: **the
// prompt does not vary by tool set at all**. That is the property the whole
// design rests on — a prompt that cannot vary is a prompt that can be written
// once when the chat is created, stored, and read back verbatim for the life of
// the chat, which is what removed the rebuild-on-every-resume.
//
// What DOES still legitimately vary by source is the handful of sections about
// where the turn runs — the unattended override, the companion-only file
// delivery. Those are frozen with the prompt at creation, which is correct: a
// chat created by cron was created by cron forever.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildShockwaveHelper } from '../agent-core/defaults/helper.ts';
import { TOOL_CATALOG } from '../agent-core/defaults/tools.ts';

// Exactly how `assembleSystemPrompt` calls it: the whole catalog, every time.
const helperFor = (source) => buildShockwaveHelper({
  tools: TOOL_CATALOG,
  unattended: source === 'review' || source === 'cron' || source === 'memory',
  source,
});

test('the tool list is identical for every source', () => {
  // The freeze property. If this ever fails, a stored prompt can go stale the
  // moment a chat is continued from another side, and the rebuild has to come
  // back.
  const sections = ['desktop', 'cron', 'telegram', 'review', 'memory']
    .map((src) => helperFor(src).slice(helperFor(src).indexOf('# Available tools')).split('\n#')[0]);
  for (const s2 of sections) assert.equal(s2, sections[0]);
});

test('every run is told about every tool', () => {
  for (const source of ['desktop', 'review', 'memory']) {
    const h = helperFor(source);
    for (const t of TOOL_CATALOG) {
      assert.ok(h.includes(`- \`${t.name}\``), `${source} is missing \`${t.name}\` from the tool list`);
    }
    assert.ok(h.includes('This is the complete set — there are no others.'), source);
  }
});

test('the tool-choice guidance is present everywhere, since every run has both', () => {
  for (const source of ['desktop', 'cron', 'telegram', 'review', 'memory']) {
    const h = helperFor(source);
    assert.ok(h.includes('rather than shelling out through `bash`'), source);
    assert.ok(h.includes('Reach for `bash` to run programs'), source);
  }
});

test('the secret-handling guideline is present everywhere too', () => {
  // It used to be gated on the tool. The tool is offered everywhere now, so the
  // rule about not echoing what it returns has to travel with it.
  for (const source of ['desktop', 'review']) {
    assert.ok(helperFor(source).includes('Do not echo a token returned by `get_agent_secret`'), source);
    assert.ok(helperFor(source).includes('- Be concise in your responses.'), source);
    assert.ok(helperFor(source).includes('- Show file paths clearly when working with files.'), source);
  }
});

test('a review run gets the unattended override — nobody is there to ask', () => {
  assert.ok(helperFor('review').includes('# Unattended run'));
  assert.ok(!helperFor('desktop').includes('# Unattended run'));
});

// ── The memory run ───────────────────────────────────────────────────────────
//
// The same rule, applied to the other background process. Its tool set is
// narrower still — one name — so it is the sharpest test of the gating there is.

test('a memory run is told about every tool too, though it may use only one', () => {
  // The inverse of what this used to assert. It reads the same manual as every
  // other run; the gate is what narrows it, and the gate explains itself. Its
  // effective tool set is pinned in skillTool.test.js, where it belongs — that is
  // a fact about what runs, not about what the prompt says.
  const h = helperFor('memory');
  for (const t of TOOL_CATALOG) {
    assert.ok(h.includes(`- \`${t.name}\``), `the memory run's prompt is missing \`${t.name}\``);
  }
});

test('a memory run gets the unattended override — nobody is there to ask', () => {
  assert.ok(helperFor('memory').includes('# Unattended run'));
});

test('the Memory section is present on every run', () => {
  // A review run cannot WRITE memory — the gate refuses the call — but it is
  // told the same things as everyone else, and it carries the memory BLOCK
  // regardless, because knowing the user makes for better skills.
  for (const source of ['desktop', 'telegram', 'cron', 'memory', 'review']) {
    assert.ok(helperFor(source).includes('# Memory'), `missing the Memory section on ${source}`);
  }
});

test('the section says which files these are, because the user can open them', () => {
  const h = helperFor('desktop');
  assert.ok(h.includes('`MEMORY.md`'));
  assert.ok(h.includes('`USER.md`'));
  // The rule that keeps the budget enforceable: writing them by hand bypasses it.
  assert.ok(h.includes('rather than editing the files directly'));
});

test('the memory block goes in LAST, after every instruction section', () => {
  // Closest to the conversation, which is where hermes puts it. It is frozen
  // with the rest of the prompt now: a chat keeps the memory snapshot it was
  // created with, and a new chat gets the current one — which is also exactly
  // what hermes' fork does.
  const block = '══ pretend block ══';
  const h = buildShockwaveHelper({ tools: TOOL_CATALOG, source: 'desktop', memory: block });
  assert.ok(h.endsWith(block));
  assert.ok(h.indexOf(block) > h.indexOf('# Creating skills'));
});

test('no memory means no block, not an empty heading', () => {
  const h = buildShockwaveHelper({ tools: TOOL_CATALOG, source: 'desktop' });
  assert.ok(!h.endsWith('\n\n'));
});

test('sections that teach a tool are present on every run', () => {
  // These two were the last to be gated — the link-graph section hands over a
  // `grep` pattern to run, the skills section is authoring guidance — and both
  // are unconditional again now that no run is missing a tool. The gating code
  // in helper.ts still works; it is simply always given the full catalog.
  for (const source of ['desktop', 'telegram', 'cron', 'review', 'memory']) {
    assert.ok(helperFor(source).includes('# Using the link graph to research'), source);
    assert.ok(helperFor(source).includes('# Creating skills'), source);
  }
});

test('the gating machinery still works when handed a subset', () => {
  // Nothing calls it that way today, but it is the mechanism that would narrow a
  // prompt again if a run ever needed one, and a broken one would fail silently.
  const only = TOOL_CATALOG.filter((t) => t.name === 'read');
  const h = buildShockwaveHelper({ tools: only, source: 'review', unattended: true });
  assert.ok(!h.includes('# Creating skills'));
  assert.ok(!h.includes('# Using the link graph to research'));
  assert.ok(h.includes('- `read`'));
});
