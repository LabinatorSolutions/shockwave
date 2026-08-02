// The fuzzy patch engine (agent-core/fuzzyMatch.ts) — how a model's remembered
// `old_string` still finds the right bytes in a file that drifted from it.
//
// Why this is tested: the chain is deliberately forgiving on the MATCH side, so
// every guard on the WRITE side is what stops that forgiveness from corrupting
// the file. A strategy that matched loosely and then wrote `new_string`
// verbatim is worse than one that didn't match at all — the patch silently
// succeeds and the damage surfaces later, in a skill nobody re-reads.
//
// Four cases below (marked FIX) are bugs hermes found in production and fixed
// AFTER knack's port was taken. They are pinned by name because the obvious way
// to build this file is to copy knack's TypeScript, and that copy reintroduces
// every one of them.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fuzzyFindAndReplace, findClosestLines, formatNoMatchHint } from '../agent-core/fuzzyMatch.ts';

// ── Preconditions ────────────────────────────────────────────────────────────

test('empty old_string is refused', () => {
  const r = fuzzyFindAndReplace('abc', '', 'x');
  assert.equal(r.error, 'old_string cannot be empty');
  assert.equal(r.content, 'abc');
  assert.equal(r.count, 0);
});

test('identical old/new is refused', () => {
  const r = fuzzyFindAndReplace('abc', 'b', 'b');
  assert.equal(r.error, 'old_string and new_string are identical');
});

test('no match returns the original content untouched', () => {
  const r = fuzzyFindAndReplace('abc', 'zzz', 'x');
  assert.equal(r.error, 'Could not find a match for old_string in the file');
  assert.equal(r.content, 'abc');
  assert.equal(r.strategy, null);
});

// ── Strategy order ───────────────────────────────────────────────────────────

test('exact match wins and reports strategy "exact"', () => {
  const r = fuzzyFindAndReplace('hello world', 'world', 'there');
  assert.equal(r.content, 'hello there');
  assert.equal(r.strategy, 'exact');
  assert.equal(r.count, 1);
});

test('multiple matches without replaceAll is an ambiguity error', () => {
  const r = fuzzyFindAndReplace('a\na\n', 'a', 'b');
  assert.match(r.error, /^Found 2 matches for old_string\./);
  assert.equal(r.content, 'a\na\n'); // unchanged
});

test('replaceAll takes every occurrence', () => {
  const r = fuzzyFindAndReplace('a\na\n', 'a', 'b', true);
  assert.equal(r.content, 'b\nb\n');
  assert.equal(r.count, 2);
});

test('line_trimmed matches through per-line whitespace drift', () => {
  const content = 'x\n   foo\ny';
  // Model sent its own leading/trailing padding, so `exact` cannot match; the
  // per-line trim on both sides can. The span replaced is the whole line.
  const r = fuzzyFindAndReplace(content, '  foo  ', 'bar');
  assert.equal(r.strategy, 'line_trimmed');
  // The replacement is anchored to the FILE's 3-space indent, not the model's
  // 2-space one — a non-exact match always runs through reindentReplacement.
  assert.equal(r.content, 'x\n   bar\ny');
});

test('escape_normalized matches a literal \\n the model sent', () => {
  const r = fuzzyFindAndReplace('a\nb', 'a\\nb', 'c');
  assert.equal(r.strategy, 'escape_normalized');
  assert.equal(r.content, 'c');
});

// ── FIX d57a4c197 (#56211): self-overlapping patterns ────────────────────────
//
// strategyExact advanced its scan cursor by pos+1 instead of pos+pattern.length,
// so "aa" in "aaaa" matched at overlapping offsets. applyReplacements works in
// reverse order, so the second replacement operated on already-modified content
// using stale offsets — corrupting the file and reporting the wrong count.
// knack's port still has `start = pos + 1`.

test('FIX: self-overlapping pattern produces non-overlapping spans', () => {
  const r = fuzzyFindAndReplace('aaaa', 'aa', 'b', true);
  assert.equal(r.count, 2, 'should find 2 non-overlapping matches, not 3 overlapping');
  assert.equal(r.content, 'bb', 'String.replaceAll() semantics');
});

test('FIX: overlapping count does not falsely trip the ambiguity guard', () => {
  // With the pos+1 bug this finds 2 matches in a 3-char string and errors out
  // even though there is exactly one place the pattern legitimately sits.
  const r = fuzzyFindAndReplace('aab', 'aa', 'z');
  assert.equal(r.error, null);
  assert.equal(r.content, 'zb');
});

// ── FIX c4d191329: Unicode minus + the Zs space family ───────────────────────
//
// knack's UNICODE_MAP has 8 entries and stops at NBSP. Without the rest, a file
// using typographic spacing never matches an ASCII-space old_string via the
// precise strategies and falls through to context_aware, which can pick the
// wrong region entirely.

test('FIX: narrow no-break space normalizes to a plain space', () => {
  const content = 'prix : 10';           // U+202F narrow NBSP
  const r = fuzzyFindAndReplace(content, 'prix : 10', 'prix : 20');
  assert.equal(r.strategy, 'unicode_normalized');
  assert.match(r.content, /20/);
});

test('FIX: ideographic space normalizes to a plain space', () => {
  const r = fuzzyFindAndReplace('a　b', 'a b', 'a c');
  assert.equal(r.strategy, 'unicode_normalized');
  assert.match(r.content, /c/);
});

test('FIX: typographic minus normalizes to ASCII hyphen', () => {
  const r = fuzzyFindAndReplace('x − y', 'x - y', 'x + y');
  assert.equal(r.strategy, 'unicode_normalized');
  assert.match(r.content, /\+/);
});

// ── FIX 65a6a3609: preserve the file's Unicode on replacement ─────────────────
//
// When unicode_normalized matches, the file holds real Unicode and the model's
// strings are ASCII. Writing new_string verbatim flattens the file's typography
// everywhere the model did NOT intend a change. knack has no such function.

test("FIX: unchanged spans keep the file's em-dash after a unicode match", () => {
  const content = 'alpha — beta';           // real em-dash
  const r = fuzzyFindAndReplace(content, 'alpha -- beta', 'alpha -- gamma');
  assert.equal(r.strategy, 'unicode_normalized');
  assert.ok(r.content.includes('—'), 'em-dash must survive; the edit was to "beta"');
  assert.ok(r.content.includes('gamma'), 'the intended edit must land');
  assert.ok(!r.content.includes('--'), 'must not flatten the em-dash to two hyphens');
});

test('FIX: smart quotes survive an edit elsewhere in the same region', () => {
  const content = '“hello” there';     // smart double quotes
  const r = fuzzyFindAndReplace(content, '"hello" there', '"hello" world');
  assert.equal(r.strategy, 'unicode_normalized');
  assert.ok(r.content.includes('“') && r.content.includes('”'), 'quotes preserved');
  assert.ok(r.content.includes('world'));
});

// ── FIX f23d077b5 (#52491): boundary space after whitespace_normalized ────────
//
// The trailing-whitespace expansion must only run when the normalized match
// ITSELF ended with whitespace. When it ends on a non-space character, the next
// whitespace in the original is a word boundary and eating it merges two words.
// knack expands unconditionally.

test('FIX: a match ending on a word does not swallow the following space', () => {
  const content = 'foo    bar baz';
  // 'foo bar' normalizes to match 'foo    bar'; the space before 'baz' is a
  // boundary, not part of the match.
  const r = fuzzyFindAndReplace(content, 'foo bar', 'qux');
  assert.equal(r.strategy, 'whitespace_normalized');
  assert.equal(r.content, 'qux baz', 'the space before "baz" must survive');
});

// ── Write-side guards ────────────────────────────────────────────────────────

test('escape-drift is refused rather than written into the file', () => {
  const content = "  it's fine";
  // Model sent a backslash-escaped apostrophe in both strings; the file has none.
  const r = fuzzyFindAndReplace(content, "it\\'s fine", "it\\'s broken");
  assert.match(r.error, /^Escape-drift detected:/);
  assert.equal(r.content, content, 'file must be untouched');
});

test('escape-drift is allowed when the file genuinely contains the sequence', () => {
  const content = "  sep = 'a\\'b'   ";
  const r = fuzzyFindAndReplace(content, "sep = 'a\\'b'", "sep = 'a\\'c'");
  assert.equal(r.error, null);
  assert.match(r.content, /a\\'c/);
});

test('\\t is unescaped only when the matched region holds a real tab', () => {
  const withTab = fuzzyFindAndReplace('\tfoo', '\tfoo', '\\tbar');
  assert.ok(withTab.content.includes('\tbar'), 'real tab in region → unescape');

  // Region has a literal backslash-t, not a tab, so new_string is left alone.
  const literal = fuzzyFindAndReplace('sep = "\\t" end', 'sep = "\\t" end', 'sep = "\\t" done');
  assert.ok(literal.content.includes('"\\t"'), 'literal \\t in region → leave alone');
});

test('replacement is re-indented to the file after a non-exact match', () => {
  const content = '    if (x) {\n        go();\n    }';
  // Model sent 2-space indent; the file is 4-space.
  const r = fuzzyFindAndReplace(content, '  if (x) {\n      go();\n  }', '  if (y) {\n      go();\n  }');
  assert.notEqual(r.strategy, 'exact');
  assert.ok(r.content.startsWith('    if (y) {'), "file indent preserved, not the model's");
});

// ── did-you-mean hints ───────────────────────────────────────────────────────

test('findClosestLines surfaces the near-miss with line numbers', () => {
  const content = 'alpha\nbeta gamma\ndelta';
  const hint = findClosestLines('beta gama', content);
  assert.match(hint, /beta gamma/);
  assert.match(hint, /\s+2\| /, 'numbered, right-aligned to width 4');
});

test('formatNoMatchHint fires only for genuine no-match errors', () => {
  const content = 'alpha\nbeta gamma\ndelta';
  assert.equal(
    formatNoMatchHint('Found 2 matches for old_string.', 0, 'beta gama', content), '',
    'ambiguity is not a no-match — a "did you mean" would mislead',
  );
  assert.equal(
    formatNoMatchHint('Escape-drift detected: ...', 0, 'beta gama', content), '',
    'escape-drift is not a no-match',
  );
  assert.equal(formatNoMatchHint('Could not find a match', 1, 'beta gama', content), '');
  assert.match(
    formatNoMatchHint('Could not find a match', 0, 'beta gama', content),
    /^\n\nDid you mean one of these sections\?\n/,
  );
});

// ── block_anchor thresholds ──────────────────────────────────────────────────

test('block_anchor accepts a similar middle when the anchors are unique', () => {
  const content = 'start\nthe middle line here\nend';
  const r = fuzzyFindAndReplace(content, 'start\nthe middle line hera\nend', 'replaced');
  assert.equal(r.strategy, 'block_anchor');
  assert.equal(r.content, 'replaced');
});

test('block_anchor rejects an unrelated middle below threshold', () => {
  const content = 'start\nqqqqqqqqqqqqqqqqqqqqqqqq\nend';
  const r = fuzzyFindAndReplace(content, 'start\nzzz zzz zzz different\nend', 'replaced');
  assert.notEqual(r.strategy, 'block_anchor');
});
