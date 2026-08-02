// The review prompt (agent-core/defaults/reviewPrompt.ts).
//
// Why this is tested: the prompt IS the feature. Everything else — the trigger,
// the tools, the guards — only decides that a run happens and what it may touch.
// What it actually writes down is decided by this text, and it is hermes' text,
// arrived at over a long tail of fixes.
//
// The failure this guards against is a half-translation: someone edits a line,
// or ports it again from a different source, and the result reads fine while
// having quietly lost the bias to action or one of the do-NOT-capture rules.
// So this asserts two things — that the load-bearing clauses are present
// verbatim, and that no hermes-only name survived the adaptation.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SKILL_REVIEW_PROMPT, renderConversation, buildReviewPrompt,
} from '../agent-core/defaults/reviewPrompt.ts';

// ── Load-bearing clauses, verbatim ───────────────────────────────────────────

test('the bias to action survives', () => {
  // The distinctive phrase, not the paragraph around it. Rewording the prose is
  // how this prompt legitimately improves; a verbatim copy fails on every such
  // edit, so the habit becomes pasting the new text in — which pins nothing.
  assert.ok(SKILL_REVIEW_PROMPT.includes('Be ACTIVE'));
  assert.ok(SKILL_REVIEW_PROMPT.includes(
    "'Nothing to save.' is a real option but should NOT be the default.",
  ));
});

test('the four-step preference order is intact and in order', () => {
  const steps = [
    '1. UPDATE A SKILL YOU READ THIS RUN.',
    '2. UPDATE AN EXISTING UMBRELLA.',
    '3. ADD A SUPPORT FILE under an existing umbrella.',
    '4. CREATE A NEW CLASS-LEVEL UMBRELLA SKILL',
  ];
  let cursor = -1;
  for (const step of steps) {
    const at = SKILL_REVIEW_PROMPT.indexOf(step);
    assert.ok(at > cursor, `${step} missing or out of order`);
    cursor = at;
  }
});

test('all four signals are listed', () => {
  for (const signal of [
    'User corrected your style, tone, format, legibility, or verbosity.',
    'User corrected your workflow, approach, or sequence of steps.',
    'Non-trivial technique, fix, workaround, debugging path, or tool-usage pattern emerged',
    'turned out to be wrong, missing a step, or outdated. Patch it NOW.',
  ]) {
    assert.ok(SKILL_REVIEW_PROMPT.includes(signal), `missing signal: ${signal}`);
  }
});

test('all five do-NOT-capture rules are present', () => {
  // The fifth ("Unresolved failures") postdates knack's port of this prompt —
  // its absence is the tell that someone re-ported from the wrong source.
  for (const rule of [
    'Environment-dependent failures:',
    'Negative claims about tools or features',
    'Session-specific transient errors that resolved before the conversation ended.',
    'One-off task narratives.',
    'Unresolved failures:',
  ]) {
    assert.ok(SKILL_REVIEW_PROMPT.includes(rule), `missing do-NOT-capture rule: ${rule}`);
  }
  assert.ok(SKILL_REVIEW_PROMPT.includes(
    'never dressed up as best practice.',
    'the unresolved-failures rule keeps its conclusion',
  ));
});

test('the three support-file kinds keep their directories', () => {
  for (const kind of ['`references/<topic>.md`', '`templates/<name>.<ext>`', '`scripts/<name>.<ext>`']) {
    assert.ok(SKILL_REVIEW_PROMPT.includes(kind), `missing support-file kind: ${kind}`);
  }
});

test('the setup-state rule keeps its "capture the FIX" framing', () => {
  assert.ok(SKILL_REVIEW_PROMPT.includes(
    "capture the FIX (install command, config step, env var to set) under an existing setup or troubleshooting skill",
  ));
});

// ── No half-translation ──────────────────────────────────────────────────────

test('no hermes-only name survived the adaptation', () => {
  // Each of these names something that does not exist in this app. Any of them
  // appearing means the prompt tells the agent to use a tool it does not have,
  // or to defer to a system that was never built.
  for (const stale of [
    'skill_view',
    'skills_list',
    'curator',
    'execute_code',
    'hermes',
    'Hermes',
    'hub-installed',
    'external_dirs',
    'PINNED',
    '/skill-name',
  ]) {
    assert.ok(
      !SKILL_REVIEW_PROMPT.includes(stale),
      `"${stale}" is a hermes-only name and must not appear`,
    );
  }
});

test('the memory sentence is gone — there is no memory store here', () => {
  assert.ok(!SKILL_REVIEW_PROMPT.includes('Memory captures'));
  assert.ok(!SKILL_REVIEW_PROMPT.includes('not just in memory'));
});

test('the two protected roots are named, and ownership is a directory', () => {
  assert.ok(SKILL_REVIEW_PROMPT.includes('`.shockwave/skills/`'), 'the user\'s uploaded skills');
  assert.ok(SKILL_REVIEW_PROMPT.includes('Built-in skills shipped with the app'));
  assert.ok(
    SKILL_REVIEW_PROMPT.includes('but only if it lives in `.agents/skills/`'),
    'the writable root is stated as the ownership rule',
  );
});

test('the only tool it is told to call is one it actually has', () => {
  assert.ok(SKILL_REVIEW_PROMPT.includes('skill_manage action=write_file'));
});

// ── Rendering the conversation ───────────────────────────────────────────────

test('renderConversation labels each role and keeps tool output', () => {
  const out = renderConversation([
    { role: 'user', content: 'stop being so verbose' },
    { role: 'assistant', content: 'Understood.', toolCalls: JSON.stringify([{ name: 'read' }, { name: 'grep' }]) },
    { role: 'tool', toolName: 'read', content: 'file contents here' },
  ]);
  assert.match(out, /^USER: stop being so verbose$/m);
  assert.match(out, /^ASSISTANT \[called read, grep\]$/m);
  assert.match(out, /^ASSISTANT: Understood\.$/m);
  assert.match(out, /^TOOL read: file contents here$/m);
});

test('unparseable tool_calls does not lose the assistant text', () => {
  const out = renderConversation([{ role: 'assistant', content: 'Still here.', toolCalls: '{not json' }]);
  assert.match(out, /ASSISTANT: Still here\./);
});

test('empty and whitespace-only messages are dropped', () => {
  const out = renderConversation([
    { role: 'user', content: '   ' },
    { role: 'assistant', content: null },
    { role: 'user', content: 'real' },
  ]);
  assert.equal(out, 'USER: real');
});

test('buildReviewPrompt wraps the conversation and appends the instruction', () => {
  const p = buildReviewPrompt([{ role: 'user', content: 'hello' }]);
  assert.match(p, /^Here is the conversation to review:/);
  assert.match(p, /<conversation>\nUSER: hello\n<\/conversation>/);
  assert.ok(p.endsWith(SKILL_REVIEW_PROMPT), 'the instruction comes last, after what it refers to');
});
