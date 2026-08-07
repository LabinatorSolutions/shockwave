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
import { parseLinks } from '../src/renderer/linkIndex.ts';

// Exactly how `assembleSystemPrompt` calls it: the whole catalog, every time.
const helperFor = (source) => buildShockwaveHelper({
  tools: TOOL_CATALOG,
  unattended: source === 'review' || source === 'cron' || source === 'memory',
  source,
});

test('the prompt does not enumerate the tools', () => {
  // The prompt used to carry an "Available tools" section: every catalog entry
  // with a one-line description of our own, closing with "This is the complete
  // set — there are no others."
  //
  // The model already has that. pi sends every tool — its builtins and our
  // `customTools` alike — to the provider as a definition carrying the name, the
  // full description and the parameter schema. The section was a second, thinner
  // copy of facts that already arrive, and being separately maintained it drifted:
  // the `send_message` entry documented an `output` argument (text/voice/both)
  // for months after the tool stopped accepting one, so on every Telegram chat
  // the prompt taught an argument the schema rejected. Nothing failed — the model
  // simply read one thing and could only do another.
  //
  // This pins the removal rather than the section, because the failure mode of
  // reintroducing it is silence: a second copy reads fine on the day it is
  // written and goes wrong later, somewhere nobody is looking.
  for (const source of ['desktop', 'cron', 'telegram', 'review', 'memory']) {
    const h = helperFor(source);
    assert.ok(!h.includes('# Available tools'), `${source} has a tool list again`);
    assert.ok(!h.includes('This is the complete set'), source);
    for (const t of TOOL_CATALOG) {
      // The shape `formatToolList` emitted. Naming a tool in prose is fine and
      // several sections do it; RESTATING what it does, entry by entry, is what
      // must not come back.
      assert.ok(!h.includes(`- \`${t.name}\`:`), `${source} describes \`${t.name}\` in the prompt`);
    }
  }
});

test('the tool-choice guidance survived, since no tool definition carries it', () => {
  // Which tool to prefer when several would do is ours — pi's own `bash` blurb
  // pushes the other way ("Execute bash commands (ls, grep, find, etc.)"). It
  // lives in `# Operating system` now, because what you can shell out to IS a
  // fact about the platform.
  for (const source of ['desktop', 'cron', 'telegram', 'review', 'memory']) {
    const h = helperFor(source);
    assert.ok(h.includes('Use `grep`, `find`, `ls` for searching'), source);
  }
});

test('the platform is stated, and said to be a starting point', () => {
  // The value is read where the CHAT IS CREATED and then frozen, so it can
  // become wrong rather than merely stale — a chat started on a Mac and
  // continued from Telegram runs on Linux still holding "started on macOS".
  // The warning is what stops the agent treating it as a fact about the machine
  // it is on right now.
  for (const [platform, name] of [['darwin', 'macOS'], ['linux', 'Linux'], ['win32', 'Windows']]) {
    const h = buildShockwaveHelper({ tools: TOOL_CATALOG, platform });
    assert.ok(h.includes(`Chat started on **${name}**`), platform);
    assert.ok(h.includes('Could change later'), platform);
  }
});

test('Windows is told bash is absent, and the others are not', () => {
  // The whole reason this section exists. It used to be one clause inside a
  // guideline that printed everywhere — so every Mac, and every Telegram and
  // cron run (which are Linux and can never be Windows), was warned about a
  // platform it was not on.
  const win = buildShockwaveHelper({ tools: TOOL_CATALOG, platform: 'win32' });
  assert.ok(win.includes('no `bash`, no Unix tools'));
  assert.ok(win.includes('Shell commands must be Windows'));

  for (const platform of ['darwin', 'linux']) {
    const h = buildShockwaveHelper({ tools: TOOL_CATALOG, platform });
    assert.ok(h.includes('`bash` and Unix tools available'), platform);
    assert.ok(!h.includes('must be Windows'), platform);
  }
});

test('the secret rule is its own section on every run', () => {
  // It was a bullet in `# Guidelines`, gated on holding `get_agent_secret` — a
  // gate that could never be false, since every run is offered the whole
  // catalog.
  for (const source of ['desktop', 'cron', 'telegram', 'review', 'memory']) {
    const h = helperFor(source);
    assert.ok(h.includes('# Secrets'), source);
    assert.ok(h.includes('Never echo a token from `get_agent_secret`'), source);
  }
});

test('`# Guidelines` is gone, and so are the two preferences it carried', () => {
  // Formatting preferences belong in SOUL, which a workspace can edit. Neither
  // of these is app behaviour.
  const h = helperFor('desktop');
  assert.ok(!h.includes('# Guidelines'));
  assert.ok(!h.includes('Be concise in your responses'));
  assert.ok(!h.includes('Show file paths clearly'));
});

// ── The association rule the prompt states must be the rule the parser runs ──
//
// This is the only section whose content is a factual claim about code
// elsewhere, and it went stale without anyone noticing: it said a bullet never
// counts as indentation and carried a worked example proving it, while
// `collectContext` had grown a second clause making a list item at the link's
// own indent associated. The prompt taught the opposite of the behaviour for as
// long as it took someone to read both.
//
// Nothing structural could catch that — the section is prose, and prose about
// another module's behaviour is exactly what rots. So the claims are executed
// against the real parser instead of being read.

test('every associated example in the prompt really associates', () => {
  for (const [text, label] of [
    ['[[Topic A]]\n    Note 1.', 'indented line'],
    ['[[Topic A]]\n- Note 2.', 'list item directly under the link'],
    ['[[Topic A]]\n1. Note 2b.', 'numbered item directly under the link'],
  ]) {
    const ctx = parseLinks(text)[0]?.contextLines ?? [];
    assert.ok(ctx.length > 0, `the prompt says this associates and it does not: ${label}`);
  }
});

test('every NOT-associated example in the prompt really does not', () => {
  // The blank-line case is the one the old section never mentioned, and it is
  // now the only real gotcha — a list is associated or not depending on whether
  // an empty line sits above it.
  for (const [text, label] of [
    ['[[Topic A]]\nNote 3.', 'plain unindented line'],
    ['[[Topic B]]\n\n- Note 4.', 'list separated by a blank line'],
  ]) {
    const ctx = parseLinks(text)[0]?.contextLines ?? [];
    assert.equal(ctx.length, 0, `the prompt says this does NOT associate and it does: ${label}`);
  }
});

test('the section no longer states the rule it used to get wrong', () => {
  const h = helperFor('desktop');
  assert.ok(!h.includes('still column 0'), 'the retired bullets-never-count rule is back');
  assert.ok(h.includes('list item at the same indent'));
  assert.ok(h.includes('no blank line in between'));
});

test('a review run gets the unattended override — nobody is there to ask', () => {
  assert.ok(helperFor('review').includes('# Unattended run'));
  assert.ok(!helperFor('desktop').includes('# Unattended run'));
});

// ── The memory run ───────────────────────────────────────────────────────────
//
// The same rule, applied to the other background process. Its tool set is
// narrower still — one name — so it is the sharpest test of the gating there is.

test('a memory run reads the same manual as every other run', () => {
  // It holds one usable tool and is told the same things as everyone else; the
  // gate is what narrows it, and the gate explains itself when a call is refused.
  // Its effective tool set is pinned in skillTool.test.js, where it belongs —
  // that is a fact about what runs, not about what the prompt says.
  //
  // Compared byte-for-byte against a desktop run, minus the unattended override,
  // which is the sharpest form of "the prompt does not vary by tool set": the
  // memory run is the narrowest run in the app.
  const memory = helperFor('memory').replace(/# Unattended run\n\n[^#]+\n\n/, '');
  assert.equal(memory, helperFor('desktop'));
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
  assert.ok(h.indexOf(block) > h.indexOf('# Saving what you learn as a skill'));
});

test('no memory means no block, not an empty heading', () => {
  const h = buildShockwaveHelper({ tools: TOOL_CATALOG, source: 'desktop' });
  assert.ok(!h.endsWith('\n\n'));
});

test('single-tool guidance has left this file', () => {
  // Four sections moved into the descriptions of the tools they were about:
  // `# Reaching the user` → send_message, `# Earlier chats` → search_chats,
  // `# Daily notes` → daily_note, `# Creating skills` → manage_skill. That they
  // still SAY those things is pinned in tests/toolGuidance.test.js, where the
  // content now lives; this pins only that the second copy did not survive here.
  //
  // Two copies is the failure this whole file keeps running into — the tool list
  // documented an argument that no longer existed, and `# Creating skills` told
  // the agent to propose and wait while the tool told it to create. Both read
  // fine on the day they were written.
  for (const source of ['desktop', 'telegram', 'cron', 'review', 'memory']) {
    const h = helperFor(source);
    for (const gone of ['# Reaching the user', '# Earlier chats', '# Daily notes', '# Creating skills']) {
      assert.ok(!h.includes(gone), `${gone} is back in the prompt on ${source}`);
    }
  }
});

test('sections that teach a tool are present on every run', () => {
  // These two were the last to be gated — the link-graph section hands over a
  // `grep` pattern to run, the skills section is authoring guidance — and both
  // are unconditional again now that no run is missing a tool. The gating code
  // in helper.ts still works; it is simply always given the full catalog.
  for (const source of ['desktop', 'telegram', 'cron', 'review', 'memory']) {
    assert.ok(helperFor(source).includes('# Finding what links to a file'), source);
    assert.ok(helperFor(source).includes('# Saving what you learn as a skill'), source);
  }
});

// ── Skills: hermes' two-section split ────────────────────────────────────────
//
// hermes states the load directive above its skill index and the save trigger
// beside it, and keeps ALL file-format guidance in `skill_manage`'s description.
// We used to have the inverse — nothing about loading, and a 1,934-char
// `# Creating skills` section teaching frontmatter — so the agent was told at
// length how to write a skill and never told to read one.

test('the agent is told to LOAD its skills, not just that they exist', () => {
  // The gap this closes is one a capable model makes by itself: it reads
  // "code-review skill", decides it already knows how to review code, skips the
  // file, and misses the conventions the skill existed to carry. pi's own
  // sentence ("use the read tool… when the task matches its description") is
  // permissive enough to allow exactly that. The clauses pinned here are the
  // ones that don't.
  for (const source of ['desktop', 'telegram', 'cron', 'review', 'memory']) {
    const h = helperFor(source);
    assert.ok(h.includes('# Skills (mandatory)'), source);
    assert.ok(h.includes('even partially relevant'), source);
    assert.ok(h.includes('Err on the side of loading'), source);
    // The sentence carrying the whole point.
    assert.ok(h.includes('the skill defines how it should be done here'), source);
  }
});

test('the prompt no longer teaches the SKILL.md file format', () => {
  // That is `manage_skill`'s description now, where hermes keeps it: needed only
  // when actually writing a skill, and read at that moment. In the prompt it was
  // frozen at chat creation and charged to every chat that never writes one.
  const h = helperFor('desktop');
  assert.ok(!h.includes('# Creating skills'));
  for (const gone of ['YAML frontmatter', '≤64 chars', '≤1024 chars', '~500 lines', 'consecutive hyphens']) {
    assert.ok(!h.includes(gone), `file-format guidance survived in the prompt: ${gone}`);
  }
});

test('loading is gated on `read`, saving on `manage_skill`', () => {
  // A run that can open a skill should be told to, whether or not it may write
  // one. A review run is exactly that case: it reads and curates.
  const readOnly = buildShockwaveHelper({
    tools: TOOL_CATALOG.filter((t) => t.name === 'read'),
    source: 'review',
  });
  assert.ok(readOnly.includes('# Skills (mandatory)'));
  assert.ok(!readOnly.includes('# Saving what you learn as a skill'));
});

test('the gating machinery still works when handed a subset', () => {
  // Nothing calls it that way today, but it is the mechanism that would narrow a
  // prompt again if a run ever needed one, and a broken one would fail silently.
  const only = TOOL_CATALOG.filter((t) => t.name === 'read');
  const h = buildShockwaveHelper({ tools: only, source: 'review', unattended: true });
  assert.ok(!h.includes('# Saving what you learn as a skill'));
  // NOTE — the backlink guidance is no longer gated. It was its own section
  // conditional on `grep`; it is now a `##` subsection of `# Wiki-links`, which
  // is unconditional. So a run without `grep` is handed a grep pattern.
  //
  // Inert today (every run gets the whole catalog) and accepted deliberately:
  // finding what links to a file is part of what wiki-links ARE, and splitting
  // one subject across four headings to preserve a gate nothing exercises was
  // the worse trade. If a narrow run is ever reintroduced, this is the line that
  // has to be reconsidered — which is why it is written down here rather than
  // discovered later.
  assert.ok(h.includes('# Wiki-links'));
  // `# Operating system` and `# Secrets` are ungated — they describe the machine
  // and a rule about a tool's output, neither of which depends on the run's set.
  // Their landing is what proves the subset was narrowed rather than emptied.
  assert.ok(h.includes('# Operating system'));
  assert.ok(h.includes('# Secrets'));
});
