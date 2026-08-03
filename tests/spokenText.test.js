// The read-aloud rules (agent-core/spokenText.ts) — the pass that turns the
// agent's reply into a script a speech engine can say.
//
// Why this is tested: the whole reason this is find-and-replace instead of a
// model is the promise that it cannot drop a fact. A promise like that is worth
// exactly as much as the test that pins it, so the facts-survive cases below are
// the point of this file and the prettiness cases are the supporting cast.
//
// The one deliberate removal is a fenced code block, which is unreadable aloud
// and always delivered in the text that accompanies the audio.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  prepareSpokenText, stripMarkdownForSpeech, normalizeSymbols,
  smoothWhitespace, flattenNewlines, stripNonSpokenBlocks,
  DEFAULT_SPOKEN_LIMIT,
} from '../agent-core/spokenText.ts';

// ── nothing that matters may disappear ───────────────────────────────────────

test('every number survives the pass', () => {
  const text = 'Coverage 85%, cost $1,200/month, 3 of 4 tests, build 1.0.51, -7 °C.';
  const spoken = prepareSpokenText(text);
  for (const n of ['85', '1,200', '3', '4', '1.0.51', '7']) {
    assert.ok(spoken.includes(n), `lost ${n} from: ${spoken}`);
  }
});

test('a bare URL keeps every identifying character', () => {
  // hermes deletes bare URLs. We drop only the scheme — the rest is the fact.
  const spoken = prepareSpokenText('See https://example.com/a/b?c=1 for details.');
  assert.ok(spoken.includes('example.com/a/b?c=1'), spoken);
  assert.ok(!spoken.includes('https'), spoken);
});

test('link text is kept when the URL is not', () => {
  const spoken = prepareSpokenText('Read [the changelog](https://example.com/x).');
  assert.ok(spoken.includes('the changelog'), spoken);
  assert.ok(!spoken.includes('example.com'), spoken);
});

test('inline code keeps its text, fenced code does not', () => {
  const spoken = prepareSpokenText('Fixed in `renameOps.ts`.\n\n```js\nconst secret = 1;\n```');
  assert.ok(spoken.includes('renameOps.ts'), spoken);
  assert.ok(!spoken.includes('const secret'), spoken);
});

// ── symbols become words ─────────────────────────────────────────────────────

test('money, percent and rates read as words', () => {
  assert.match(normalizeSymbols('$1,200'), /1,200 dollars/);
  assert.match(normalizeSymbols('€50'), /50 euros/);
  assert.match(normalizeSymbols('£9.99'), /9\.99 pounds/);
  assert.match(normalizeSymbols('85%'), /85 percent/);
  assert.match(normalizeSymbols('5/month'), /5 per month/);
});

test('a trailing comma is not swallowed into an amount', () => {
  // The integer part must END in a digit, or "A$50, then" reads as "50, dollars".
  assert.match(normalizeSymbols('A$50, then more'), /50 Australian dollars, then more/);
});

test('slashes that are not rates are left alone', () => {
  for (const s of ['and/or', 'N/A', 'TCP/IP', '2026/06']) {
    assert.equal(normalizeSymbols(s), s, s);
  }
});

test('temperatures and ranges', () => {
  assert.match(normalizeSymbols('22 °C'), /22 degrees Celsius/);
  assert.match(normalizeSymbols('72 °F'), /72 degrees Fahrenheit/);
  assert.match(normalizeSymbols('11-17 °C'), /11 to 17 degrees Celsius/);
});

test('tilde and arrows read as words', () => {
  assert.match(normalizeSymbols('~85'), /about 85/);
  assert.match(normalizeSymbols('a → b'), /a to b/);
  assert.match(normalizeSymbols('R&D'), /R and D/);
});

test('emoji are dropped rather than read as labels', () => {
  assert.equal(normalizeSymbols('done 🎉').trim(), 'done');
});

// ── layout becomes speech ────────────────────────────────────────────────────

test('a heading folds into the sentence after it', () => {
  const spoken = prepareSpokenText('## Build status\nTests pass.');
  assert.equal(spoken, 'Build status, Tests pass.');
});

test('a heading with nothing after it stands alone', () => {
  assert.equal(prepareSpokenText('## Build status'), 'Build status.');
});

test('list bullets and rules are removed, their text kept', () => {
  const spoken = prepareSpokenText('- first\n- second\n\n---\n\n1. third');
  for (const w of ['first', 'second', 'third']) assert.ok(spoken.includes(w), spoken);
  assert.ok(!spoken.includes('---'), spoken);
});

test('table bars become pauses', () => {
  assert.match(stripMarkdownForSpeech('| A | B |'), /;/);
});

test('a table divider row leaves no dashes behind', () => {
  const spoken = prepareSpokenText('| Provider | Cost |\n| --- | ---: |\n| Deepgram | $0.02 |');
  assert.ok(!spoken.includes('---'), spoken);
  for (const w of ['Provider', 'Cost', 'Deepgram', '0.02 dollars']) {
    assert.ok(spoken.includes(w), `lost ${w} from: ${spoken}`);
  }
});

test('a list item is not mistaken for a table divider', () => {
  assert.ok(prepareSpokenText('- first item').includes('first item'));
});

test('a single line is not given a full stop it did not have', () => {
  assert.equal(smoothWhitespace('just this'), 'just this');
});

test('newlines flatten without running sentences together', () => {
  assert.equal(flattenNewlines('One.\nTwo.'), 'One. Two.');
});

// ── blocks that must never be spoken ─────────────────────────────────────────

test('reasoning blocks are stripped, terminated or not', () => {
  assert.ok(!stripNonSpokenBlocks('<think>hmm</think>Answer.').includes('hmm'));
  assert.ok(!stripNonSpokenBlocks('Answer.<think>cut off mid').includes('cut off'));
});

// ── the limit ────────────────────────────────────────────────────────────────

test('a long script is cut, not summarized', () => {
  const spoken = prepareSpokenText('word '.repeat(2000));
  assert.ok(spoken.length <= DEFAULT_SPOKEN_LIMIT, String(spoken.length));
});

test('the limit can be lifted', () => {
  const spoken = prepareSpokenText('word '.repeat(2000), null);
  assert.ok(spoken.length > DEFAULT_SPOKEN_LIMIT, String(spoken.length));
});

// ── nothing in, nothing out ──────────────────────────────────────────────────

test('empty and whitespace input are safe', () => {
  for (const v of ['', '   ', '\n\n']) assert.equal(prepareSpokenText(v), '');
});
