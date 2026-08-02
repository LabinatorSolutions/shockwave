// The memory store (agent-core/memoryStore.ts).
//
// Why this is tested: everything about memory that can go quietly wrong lives
// here. The prompt and the trigger only decide that a write is attempted; this
// file decides whether the write is correct, and its failure modes are silent
// ones — an entry that vanishes because two chats saved at the same moment, a
// file rewritten from a view that wasn't the real one, a budget that counts
// differently from the number shown to the agent.
//
// Two of these tests exist because the naive version was measured failing:
// concurrent adds lose an entry outright, and an unreadable file read as empty
// wipes everything in it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  MemoryStore, parseEntries, serializeEntries, charCount, renderBlock, clampLimit,
  ENTRY_DELIMITER, DEFAULT_MEMORY_CHAR_LIMIT, DEFAULT_USER_CHAR_LIMIT,
} from '../agent-core/memoryStore.ts';

async function workspace() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'sw-memory-'));
}
const readFile = (ws, name = 'MEMORY.md') => fs.readFile(path.join(ws, name), 'utf8').catch(() => null);

// ── Format ───────────────────────────────────────────────────────────────────

test('entries are separated by a § alone on its own line, and nothing else', () => {
  assert.deepEqual(parseEntries('one\n§\ntwo'), ['one', 'two']);
  // A § inside a line is CONTENT. hermes splits on the delimiter and not the
  // character for exactly this reason — an entry may legitimately quote one.
  assert.deepEqual(parseEntries('cost is 5 § per unit'), ['cost is 5 § per unit']);
  assert.deepEqual(parseEntries(''), []);
  assert.deepEqual(parseEntries('   \n  '), []);
});

test('multiline entries round-trip', () => {
  const entries = ['line one\nline two', 'second'];
  assert.deepEqual(parseEntries(serializeEntries(entries)), entries);
});

test('the budget counts the serialized form, delimiters included', () => {
  // 2 + 3 + 2. The agent is shown this number and the tool enforces it, so a
  // count that ignored delimiters would let it plan a write that then failed.
  assert.equal(charCount(['ab', 'cd']), 7);
  assert.equal(charCount([]), 0);
  assert.equal(ENTRY_DELIMITER, '\n§\n');
});

test('the prompt block carries the usage line, and is empty when nothing is saved', () => {
  assert.equal(renderBlock('memory', [], 2200), '');
  const block = renderBlock('user', ['a'.repeat(100)], 1000);
  assert.match(block, /USER PROFILE \(who the user is\) \[10% — 100\/1,000 chars\]/);
  assert.ok(block.includes('═'.repeat(46)));
});

test('a limit that could not work falls back rather than bricking every write', () => {
  assert.equal(clampLimit(undefined, 2200), 2200);
  assert.equal(clampLimit(0, 2200), 2200);
  assert.equal(clampLimit(-5, 2200), 2200);
  assert.equal(clampLimit('abc', 2200), 2200);
  assert.equal(clampLimit(500, 2200), 500);
  assert.equal(clampLimit(10 ** 9, 2200), 100_000);
});

// ── Writing ──────────────────────────────────────────────────────────────────

test('the first write creates the file — a workspace with no memory yet is normal', async () => {
  const ws = await workspace();
  assert.equal(await readFile(ws), null);
  const r = await new MemoryStore(ws).add('memory', 'The build runs on Fridays');
  assert.equal(r.success, true);
  // Trailing newline: these files live in a git repo whose diffs the user reads.
  assert.equal(await readFile(ws), 'The build runs on Fridays\n');
});

test('the two targets are two files', async () => {
  const ws = await workspace();
  const store = new MemoryStore(ws);
  await store.add('memory', 'about the workspace');
  await store.add('user', 'about the user');
  assert.equal(await readFile(ws, 'MEMORY.md'), 'about the workspace\n');
  assert.equal(await readFile(ws, 'USER.md'), 'about the user\n');
});

test('a duplicate succeeds without adding — the fact IS saved, so stop', async () => {
  const ws = await workspace();
  const store = new MemoryStore(ws);
  await store.add('memory', 'one');
  const r = await store.add('memory', 'one');
  assert.equal(r.success, true);
  assert.equal(r.message, 'Entry already exists (no duplicate added).');
  assert.equal(await readFile(ws), 'one\n');
});

test('an overflowing add is refused, shows the entries, and writes nothing', async () => {
  const ws = await workspace();
  const store = new MemoryStore(ws, { memory: 50 });
  await store.add('memory', 'a'.repeat(40));
  const r = await store.add('memory', 'b'.repeat(40));
  assert.equal(r.success, false);
  // The entries have to come back or the model has nothing to consolidate FROM.
  assert.deepEqual(r.current_entries, ['a'.repeat(40)]);
  assert.match(r.error, /Consolidate now/);
  assert.match(r.error, /all in this turn/);
  assert.equal(await readFile(ws), `${'a'.repeat(40)}\n`);
});

test('replace and remove match on a unique substring', async () => {
  const ws = await workspace();
  const store = new MemoryStore(ws);
  await store.add('memory', 'User prefers dark mode in all editors');
  await store.add('memory', 'Deploys run on Friday');

  const r = await store.replace('memory', 'dark mode', 'User prefers light mode');
  assert.equal(r.success, true);
  assert.deepEqual(parseEntries(await readFile(ws)), ['User prefers light mode', 'Deploys run on Friday']);

  assert.equal((await store.remove('memory', 'Friday')).success, true);
  assert.deepEqual(parseEntries(await readFile(ws)), ['User prefers light mode']);
});

test('an ambiguous substring is refused with previews, not guessed', async () => {
  const ws = await workspace();
  const store = new MemoryStore(ws);
  await store.add('memory', 'deploy runs on Friday');
  await store.add('memory', 'deploy needs the VPN');
  const r = await store.remove('memory', 'deploy');
  assert.equal(r.success, false);
  assert.match(r.error, /Multiple entries matched 'deploy'\. Be more specific\./);
  assert.equal(r.matches.length, 2);
  assert.equal(parseEntries(await readFile(ws)).length, 2);
});

test('a substring that matches nothing returns the inventory to retry from', async () => {
  const ws = await workspace();
  const store = new MemoryStore(ws);
  await store.add('memory', 'one');
  const r = await store.replace('memory', 'nope', 'two');
  assert.equal(r.success, false);
  assert.deepEqual(r.current_entries, ['one']);
  assert.match(r.error, /retry with the exact text/);
});

// ── Batch ────────────────────────────────────────────────────────────────────

test('a batch frees room and adds in ONE call, which an add alone could not do', async () => {
  const ws = await workspace();
  const store = new MemoryStore(ws, { memory: 60 });
  await store.add('memory', 'a'.repeat(25));
  await store.add('memory', 'b'.repeat(25));
  // 25+3+25 = 53 of 60. Adding 25 more alone would be 81 — refused.
  assert.equal((await store.add('memory', 'c'.repeat(25))).success, false);
  // The same net change as one batch: drop one, add the other. Only the FINAL
  // size is checked, which is the whole point of the shape.
  const r = await store.applyBatch('memory', [
    { action: 'remove', old_text: 'a'.repeat(25) },
    { action: 'add', content: 'c'.repeat(25) },
  ]);
  assert.equal(r.success, true);
  assert.deepEqual(parseEntries(await readFile(ws)), ['b'.repeat(25), 'c'.repeat(25)]);
});

test('a batch is all-or-nothing — a bad op writes none of the good ones', async () => {
  const ws = await workspace();
  const store = new MemoryStore(ws);
  await store.add('memory', 'original');
  const r = await store.applyBatch('memory', [
    { action: 'add', content: 'fine' },
    { action: 'remove', old_text: 'does not exist' },
  ]);
  assert.equal(r.success, false);
  assert.match(r.error, /No operations were applied \(batch is all-or-nothing\)/);
  assert.deepEqual(parseEntries(await readFile(ws)), ['original']);
});

test('a duplicate inside a batch is skipped rather than failing the batch', async () => {
  const ws = await workspace();
  const store = new MemoryStore(ws);
  await store.add('memory', 'already here');
  const r = await store.applyBatch('memory', [
    { action: 'add', content: 'already here' },
    { action: 'add', content: 'new one' },
  ]);
  assert.equal(r.success, true);
  assert.deepEqual(parseEntries(await readFile(ws)), ['already here', 'new one']);
});

// ── The two measured failure modes ───────────────────────────────────────────

test('concurrent writes both land — the lock is not decorative', async () => {
  // The desktop runs several chats against ONE workspace folder. Without the
  // per-path chain this loses an entry every time: both reads see the same
  // state, and the second write overwrites the first. Measured before the lock
  // existed, which is why it is a test and not a comment.
  const ws = await workspace();
  const store = new MemoryStore(ws);
  await store.add('memory', 'seed');
  await Promise.all([
    store.add('memory', 'from chat one'),
    store.add('memory', 'from chat two'),
  ]);
  const entries = parseEntries(await readFile(ws));
  assert.deepEqual(entries.sort(), ['from chat one', 'from chat two', 'seed']);
});

test('an unreadable file is refused, never treated as empty', async () => {
  // "Exists but could not be read" and "is empty" are different states, and
  // conflating them is catastrophic: the store would rewrite the whole file from
  // an empty view and destroy everything in it. A directory where the file
  // should be is the cheapest way to make a read fail for real.
  const ws = await workspace();
  await fs.mkdir(path.join(ws, 'MEMORY.md'));
  const r = await new MemoryStore(ws).add('memory', 'should not be written');
  assert.equal(r.success, false);
  assert.match(r.error, /would wipe existing memory, so the write is refused/);
  assert.ok((await fs.stat(path.join(ws, 'MEMORY.md'))).isDirectory());
});

test('a symlink at the memory path is refused', async () => {
  // A background run holds no `write` and no `bash`, so this is the one way such
  // a run could be made to write outside the workspace.
  const ws = await workspace();
  const outside = path.join(await workspace(), 'elsewhere.md');
  await fs.writeFile(outside, 'untouched');
  await fs.symlink(outside, path.join(ws, 'MEMORY.md'));
  const r = await new MemoryStore(ws).add('memory', 'escape');
  assert.equal(r.success, false);
  assert.match(r.error, /symlink/);
  assert.equal(await fs.readFile(outside, 'utf8'), 'untouched');
});

// ── Turn budget ──────────────────────────────────────────────────────────────

test('repeated failures stop asking for a retry, so a full store cannot eat the turn', async () => {
  const ws = await workspace();
  const store = new MemoryStore(ws, { memory: 30 });
  await store.add('memory', 'x'.repeat(28));
  let last;
  for (let i = 0; i < 4; i++) last = await store.add('memory', `${'y'.repeat(28)}${i}`);
  assert.equal(last.success, false);
  assert.equal(last.done, true, 'the fourth failure must be terminal');
  assert.match(last.error, /Stop retrying memory calls/);

  // A new turn starts with the budget restored.
  store.resetTurn();
  const after = await store.add('memory', 'z'.repeat(28));
  assert.equal(after.done, undefined);
  assert.match(after.error, /Consolidate now/);
});

test('a successful write clears the failure count — progress is progress', async () => {
  const ws = await workspace();
  const store = new MemoryStore(ws, { memory: 40 });
  const tooBig = (i) => `${'y'.repeat(45)}${i}`;           // over the limit on its own

  await store.add('memory', 'x'.repeat(35));               // fits
  assert.equal((await store.add('memory', tooBig(0))).success, false);   // failure 1

  // A write that lands means the consolidation loop is working, so the budget
  // starts over. Without the reset the two failures below would be numbers 2 and
  // 3, and the third add would already be terminal.
  assert.equal((await store.remove('memory', 'x'.repeat(35))).success, true);

  for (let i = 1; i <= 3; i++) {
    const r = await store.add('memory', tooBig(i));
    assert.equal(r.done, undefined, `failure ${i} after a success must still ask for a retry`);
  }
  assert.equal((await store.add('memory', tooBig(4))).done, true);
});

// ── Prompt rendering ─────────────────────────────────────────────────────────

test('both blocks render, in hermes\' order, and only when they have content', async () => {
  const ws = await workspace();
  const store = new MemoryStore(ws);
  assert.equal(await store.renderForPrompt(), '');
  await store.add('user', 'Prefers short answers');
  const userOnly = await store.renderForPrompt();
  assert.ok(userOnly.includes('USER PROFILE'));
  assert.ok(!userOnly.includes('MEMORY (your personal notes)'));
  await store.add('memory', 'Tests live in tests/');
  const both = await store.renderForPrompt();
  assert.ok(both.indexOf('MEMORY (your personal notes)') < both.indexOf('USER PROFILE'));
});

test('the trailing newline is not charged to the budget', () => {
  // The file gets one so its diffs read cleanly; the number shown to the agent
  // and the number enforced are both over the entries alone. If these ever
  // disagreed, the agent would plan a write that then failed by one character.
  assert.equal(charCount(['ab', 'cd']), 7);
});

test('the defaults are hermes\' figures', () => {
  assert.equal(DEFAULT_MEMORY_CHAR_LIMIT, 2200);
  assert.equal(DEFAULT_USER_CHAR_LIMIT, 1375);
  const store = new MemoryStore('/nowhere');
  assert.equal(store.limits.memory, 2200);
  assert.equal(store.limits.user, 1375);
});
