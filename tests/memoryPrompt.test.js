// The memory instruction and the memory tool's description
// (agent-core/defaults/memoryPrompt.ts, agent-core/memoryTool.ts).
//
// Why this is tested, for the same reason as `reviewPrompt.test.js`: the text IS
// the feature. The trigger and the tool set only decide that a run happens and
// what it may touch; what actually gets written down is decided by these two
// strings, and they are hermes' strings, arrived at over a long tail of fixes.
//
// The failure guarded against is a half-translation — someone edits a line, or
// ports it again from a different source, and the result reads fine while having
// quietly lost the batch instruction or the priority order. So this asserts that
// the load-bearing clauses are present verbatim, and that no hermes-only name
// survived the adaptation.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MEMORY_REVIEW_PROMPT, buildMemoryPrompt } from '../agent-core/defaults/memoryPrompt.ts';
import { MEMORY_TOOL_DESCRIPTION } from '../agent-core/memoryTool.ts';
import { SKILL_REVIEW_PROMPT } from '../agent-core/defaults/reviewPrompt.ts';

// ── The instruction ──────────────────────────────────────────────────────────

test('the memory instruction is hermes\' text, whole and unaltered', () => {
  // This one is quoted in FULL rather than by distinctive clause — unlike the
  // skill prompt, it is four sentences and took zero substitutions, so there is
  // no adaptation for a verbatim copy to fight with. If hermes changes it, this
  // fails and the new text gets read before it is taken.
  assert.equal(MEMORY_REVIEW_PROMPT, `Review the conversation above and consider saving to memory if appropriate.

Focus on:
1. Has the user revealed things about themselves — their persona, desires, preferences, or personal details worth remembering?
2. Has the user expressed expectations about how you should behave, their work style, or ways they want you to operate?

If something stands out, save it using the memory tool. If nothing is worth saving, just say 'Nothing to save.' and stop.`);
});

test('the memory instruction carries NO bias to action, and the skill one does', () => {
  // The asymmetry is the reason these are two processes rather than one pass.
  // A conversation that revealed nothing about the user should record nothing;
  // a session that did real work almost always taught something. Pointing the
  // skills wording at a chat that only talked is how a skill about nothing gets
  // written, and that is exactly what a shared prompt would do.
  assert.ok(SKILL_REVIEW_PROMPT.includes('Be ACTIVE'));
  assert.ok(!MEMORY_REVIEW_PROMPT.includes('Be ACTIVE'));
  assert.ok(SKILL_REVIEW_PROMPT.includes("'Nothing to save.' is a real option but should NOT be the default."));
  assert.ok(!MEMORY_REVIEW_PROMPT.includes('should NOT be the default'));
});

test('the memory instruction never mentions skills, and vice versa', () => {
  for (const word of ['skill', 'SKILL.md', 'manage_skill']) {
    assert.ok(!MEMORY_REVIEW_PROMPT.includes(word), `memory prompt should not mention ${word}`);
  }
  assert.ok(!SKILL_REVIEW_PROMPT.includes('MEMORY.md'));
  assert.ok(!SKILL_REVIEW_PROMPT.includes('USER.md'));
});

test('buildMemoryPrompt wraps the conversation and appends the instruction', () => {
  const out = buildMemoryPrompt([
    { role: 'user', content: 'I hate long answers' },
    { role: 'assistant', content: 'Noted.' },
  ]);
  assert.ok(out.startsWith('Here is the conversation to review:'));
  assert.ok(out.includes('<conversation>\nUSER: I hate long answers'));
  assert.ok(out.includes('ASSISTANT: Noted.'));
  // The instruction reads LAST, so it is what the model acts on.
  assert.ok(out.endsWith(MEMORY_REVIEW_PROMPT));
});

// ── The tool description ─────────────────────────────────────────────────────

test('all five labelled paragraphs survive, in order', () => {
  const labels = ['HOW:', 'WHEN:', 'IF FULL:', 'TARGETS:', 'SKIP:'];
  let cursor = -1;
  for (const label of labels) {
    const at = MEMORY_TOOL_DESCRIPTION.indexOf(label);
    assert.ok(at > cursor, `${label} missing or out of order`);
    cursor = at;
  }
});

test('the batch instruction and its two consequences are intact', () => {
  // These three clauses are why the model consolidates in one call instead of
  // discovering the wall, and why it stops instead of reissuing the same write.
  // hermes observed the correct batch on call one followed by five repeats
  // before the "don't repeat it" clause existed.
  assert.ok(MEMORY_TOOL_DESCRIPTION.includes("make ALL your changes in ONE call via an 'operations' array"));
  assert.ok(MEMORY_TOOL_DESCRIPTION.includes('the char limit is checked only on the FINAL result'));
  assert.ok(MEMORY_TOOL_DESCRIPTION.includes("one batch call finishes the update, so don't repeat it"));
});

test('the priority order and the point of the whole feature survive', () => {
  assert.ok(MEMORY_TOOL_DESCRIPTION.includes(
    'Priority: user preferences & corrections > environment facts > procedures.',
  ));
  assert.ok(MEMORY_TOOL_DESCRIPTION.includes('The best memory stops the user repeating themselves.'));
  // The boundary against the other process, stated from this side.
  assert.ok(MEMORY_TOOL_DESCRIPTION.includes('Reusable procedures belong in a skill, not memory.'));
});

test('the one substitution was made, and nothing hermes-only came with it', () => {
  // hermes says `session_search`; ours is `search_chats`, the same idea and the
  // same reason — task progress belongs in the searchable transcript, not in a
  // budget that is re-read on every turn.
  assert.ok(MEMORY_TOOL_DESCRIPTION.includes('(use search_chats for those)'));
  for (const name of ['session_search', 'hermes', 'Hermes', '~/.hermes', 'skill_view', 'curator']) {
    assert.ok(!MEMORY_TOOL_DESCRIPTION.includes(name), `hermes-only name survived: ${name}`);
    assert.ok(!MEMORY_REVIEW_PROMPT.includes(name), `hermes-only name survived: ${name}`);
  }
});

// ── The tool, called the way pi calls it ─────────────────────────────────────
//
// The store is tested exhaustively in `memoryStore.test.js`; what these cover is
// the layer between it and pi — argument shapes that arrive from a model rather
// than from our own code, and the `isError` flag pi renders on.

test('the tool dispatches both shapes and reports failure as an error result', async () => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { makeMemoryTool } = await import('../agent-core/memoryTool.ts');

  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'sw-memtool-'));
  const { tools } = makeMemoryTool(ws, { memory: 200 });
  const tool = tools[0];
  const call = async (params) => JSON.parse((await tool.execute('id', params)).content[0].text);

  assert.equal((await call({ action: 'add', target: 'memory', content: 'one' })).success, true);
  assert.equal((await call({ operations: [{ action: 'add', content: 'two' }], target: 'memory' })).success, true);
  assert.equal(await fs.readFile(path.join(ws, 'MEMORY.md'), 'utf8'), 'one\n§\ntwo\n');

  // pi shows a failed tool call differently; the store's instruction text is
  // still the body, so the model can act on it.
  const bad = await tool.execute('id', { action: 'remove', target: 'memory', old_text: 'nope' });
  assert.equal(bad.isError, true);
  assert.match(JSON.parse(bad.content[0].text).error, /No entry matched/);
});

test('a null target means the default store, not a validation failure', async () => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { makeMemoryTool } = await import('../agent-core/memoryTool.ts');

  // Strict providers fill an omitted optional field with JSON null rather than
  // leaving it out. hermes handles it, and without this the most common shape of
  // call — a bare add — fails on those providers only.
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'sw-memtool-'));
  const { tools } = makeMemoryTool(ws);
  const r = JSON.parse((await tools[0].execute('id', { action: 'add', target: null, content: 'x' })).content[0].text);
  assert.equal(r.success, true);
  assert.equal(await fs.readFile(path.join(ws, 'MEMORY.md'), 'utf8'), 'x\n');
});

test('a targeted action with no old_text gets the inventory, not a dead end', async () => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { makeMemoryTool } = await import('../agent-core/memoryTool.ts');

  // `old_text` cannot be schema-required without a top-level combinator some
  // providers reject, so a client CAN omit it. Returning "old_text is required"
  // leaves the model nothing to do; returning the entries lets it reissue.
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'sw-memtool-'));
  const { tools } = makeMemoryTool(ws);
  await tools[0].execute('id', { action: 'add', target: 'user', content: 'Prefers terse replies' });
  const r = JSON.parse((await tools[0].execute('id', { action: 'replace', target: 'user', content: 'new' })).content[0].text);
  assert.equal(r.success, false);
  assert.deepEqual(r.current_entries, ['Prefers terse replies']);
  assert.match(r.error, /Reissue the replace with old_text set/);
});
