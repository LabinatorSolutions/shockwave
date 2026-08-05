// Splitting a script into the pieces it gets spoken in
// (`agent-core/speechChunks.ts`).
//
// Two promises are worth pinning, and they pull against each other. **Nothing is
// lost**: every character of the script comes back, because the tail of a long
// answer silently never being spoken is the bug this replaced. And **pieces are
// whole**: a clip that stops mid-word is worse than one that runs a little long,
// so a break lands on a sentence even when that means overshooting the budget.
//
// Everything here is an estimate — how long a piece takes to say isn't knowable
// until it's made — so the tests check shape and boundaries, never exact lengths.

import { test } from 'node:test';
import assert from 'node:assert';
import { splitForSpeech, CHARS_PER_SECOND } from '../agent-core/speechChunks.ts';

const seconds = (n) => n * CHARS_PER_SECOND;

/** `count` sentences of roughly `len` characters each. */
function sentences(count, len = 60) {
  return Array.from({ length: count }, (_, i) => `${`Sentence ${i + 1} `.padEnd(len - 1, 'x')}.`).join(' ');
}

test('nothing is lost — every word comes back, in order', () => {
  const script = sentences(40);
  const pieces = splitForSpeech(script, null);
  assert.ok(pieces.length > 1, 'a long script should be split');
  assert.equal(pieces.join(' ').replace(/\s+/g, ' '), script.replace(/\s+/g, ' '));
});

test('a short script is spoken in one go', () => {
  const script = 'Done — the tests pass and it is pushed.';
  assert.deepEqual(splitForSpeech(script, null), [script]);
});

test('an empty script says nothing rather than sending silence', () => {
  assert.deepEqual(splitForSpeech('', null), []);
  assert.deepEqual(splitForSpeech('   \n  ', null), []);
});

test('the first piece is the short one, and the pieces grow', () => {
  // The first wait is the only one nobody can cover, so it is small; by the time
  // the third is being made there is audio playing to cover it.
  const pieces = splitForSpeech(sentences(40), null);
  assert.ok(pieces.length >= 3, `expected several pieces, got ${pieces.length}`);
  assert.ok(pieces[0].length < pieces[1].length, 'the first piece should be the shortest');
  assert.ok(pieces[1].length < pieces[2].length, 'pieces should grow');
  assert.ok(pieces[0].length <= seconds(12), `first piece too long: ${pieces[0].length} chars`);
});

test('breaks land at the end of a sentence, never mid-word', () => {
  for (const piece of splitForSpeech(sentences(40), null)) {
    assert.match(piece, /[.!?]$/, `piece does not end a sentence: ${JSON.stringify(piece.slice(-40))}`);
  }
});

test('one very long sentence is not chopped in half — it overshoots to the end', () => {
  // Nothing to break on inside the first budget. Running long beats cutting a
  // sentence in two, so the whole sentence travels as one piece.
  const long = `${'word '.repeat(120).trim()}. ${sentences(10)}`;
  const pieces = splitForSpeech(long, null);
  assert.ok(pieces[0].endsWith('.'), 'the long sentence should have been kept whole');
  assert.ok(pieces[0].length > seconds(5), 'it should have overshot the first budget');
});

test('a very short opening sentence does not become its own voice note', () => {
  // "Hi." inside a five-second budget would otherwise ship a one-word clip.
  const pieces = splitForSpeech(`Hi. ${sentences(30)}`, null);
  assert.ok(pieces[0].length > seconds(3), `first piece is a runt: ${JSON.stringify(pieces[0])}`);
});

test('a runt tail is folded into the piece before it', () => {
  const pieces = splitForSpeech(sentences(40), null);
  const last = pieces[pieces.length - 1];
  assert.ok(last.length >= seconds(5), `trailing runt: ${last.length} chars`);
});

test("the vendor's input limit is never exceeded — this is what stopped truncating long answers", () => {
  // Deepgram's ceiling. Over it the request is rejected outright, and the old
  // behaviour was to cut the script and silently lose the rest of the answer.
  const cap = 2000;
  const pieces = splitForSpeech(sentences(200), cap);
  for (const piece of pieces) assert.ok(piece.length <= cap, `piece over the limit: ${piece.length}`);
  assert.equal(pieces.join(' ').replace(/\s+/g, ' '), sentences(200).replace(/\s+/g, ' '));
});

test('a short script over the limit is still split', () => {
  // Under the split threshold by duration, over it for the vendor — the cap wins,
  // because the alternative is a request that fails outright.
  const script = sentences(6, 40);
  const pieces = splitForSpeech(script, 60);
  assert.ok(pieces.length > 1);
  for (const piece of pieces) assert.ok(piece.length <= 60, `piece over the limit: ${piece.length}`);
});

test('text with no sentence endings at all still comes back whole', () => {
  const script = 'word '.repeat(400).trim();
  const pieces = splitForSpeech(script, null);
  assert.equal(pieces.join(' ').replace(/\s+/g, ' '), script);
});

test('newlines are usable break points when there is no punctuation', () => {
  const script = Array.from({ length: 60 }, (_, i) => `line ${i} of a list with some words on it`).join('\n');
  const pieces = splitForSpeech(script, null);
  assert.ok(pieces.length > 1);
  assert.equal(pieces.join('\n').replace(/\s+/g, ' '), script.replace(/\s+/g, ' '));
});
