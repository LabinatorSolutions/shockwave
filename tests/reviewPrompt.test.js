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
  SKILL_REVIEW_PROMPT, buildReviewPrompt,
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
  assert.ok(SKILL_REVIEW_PROMPT.includes('manage_skill action=write_file'));
});

// ── The message the run actually receives ────────────────────────────────────
//
// The conversation is NOT in this message any more. A review run clones the
// source chat and resumes its pi session, so the conversation is above this as
// real messages — every tool call with its arguments, the reasoning, the images.
//
// The version this replaced flattened the conversation into text and pasted it
// in here, and that rendering dropped the tool ARGUMENTS: it emitted
// `ASSISTANT [called bash]` followed by what the command printed, so the run read
// an output with no idea what produced it. Which is most of what a skill is made
// of ("the command failed like this, and here is what fixed it").

test('the conversation is not pasted into the message', () => {
  const p = buildReviewPrompt({ workspacePath: '/tmp/run-checkout' });
  assert.ok(!p.includes('<conversation>'), 'the conversation is resumed, not quoted');
  assert.ok(!p.includes('Here is the conversation to review:'));
});

test('it names THIS run\'s working directory', () => {
  // The cloned system prompt names the SOURCE chat's directory, which does not
  // exist in this checkout. The prompt is frozen and cannot be corrected, so the
  // right path has to arrive in the one part that was never frozen — this one.
  const p = buildReviewPrompt({ workspacePath: '/tmp/run-checkout' });
  assert.ok(p.includes('/tmp/run-checkout'));
  assert.ok(p.includes('use that path, not any directory named earlier'));
});

test('it says nobody is present', () => {
  // Same reason: the inherited prompt was assembled for a chat with a user in it.
  const p = buildReviewPrompt({ workspacePath: '/tmp/x' });
  assert.ok(p.includes('nobody is present'));
});

test('the instruction comes last, after the context it applies to', () => {
  const p = buildReviewPrompt({ workspacePath: '/tmp/x' });
  assert.ok(p.endsWith(SKILL_REVIEW_PROMPT), 'the instruction reads last, so it is what the model acts on');
});
