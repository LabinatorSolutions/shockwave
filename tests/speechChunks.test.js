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
  // Not a strict step at every rung — a break only lands where the text allows,
  // so two neighbours can tie. What must hold is the shape: small at the front,
  // much larger by the end.
  assert.ok(pieces[0].length <= pieces[1].length, 'the first piece should not be the largest');
  assert.ok(pieces[pieces.length - 1].length > pieces[0].length * 2, 'pieces should grow');
  // Measured: synthesis costs ~1s per 46 characters, so this bounds the wait
  // before the first sound to a couple of seconds. It is not smaller because it
  // is also the buffer every later piece is made inside — see the ladder test.
  assert.ok(pieces[0].length <= seconds(7), `first piece too long: ${pieces[0].length} chars`);
});

test('breaks land at the end of a sentence, never mid-word', () => {
  // The FIRST piece is allowed a clause break — see the next test — so it is
  // exempt. Everywhere else a whole sentence is worth the wait.
  for (const piece of splitForSpeech(sentences(40), null).slice(1)) {
    assert.match(piece, /[.!?]$/, `piece does not end a sentence: ${JSON.stringify(piece.slice(-40))}`);
  }
});

test('the first piece may break at a clause, because that wait is the only uncovered one', () => {
  // Synthesis costs about a second per 46 characters, so reaching for the next
  // sentence end is paid in silence before anything is heard at all. Here the
  // opening clause ends at a colon and the next sentence end is far past it.
  const opening = 'Here is the plan for this evening:';
  const pieces = splitForSpeech(`${opening} ${sentences(30)}`, null);
  assert.ok(pieces[0].endsWith(':'), `expected a clause break, got ${JSON.stringify(pieces[0])}`);
  // And the floor still applies to it: a clause ending after a handful of
  // characters is skipped, because an opener that grabs the first comma it sees
  // starves every piece sized from how long it plays.
  const tiny = splitForSpeech(`So: ${sentences(30)}`, null);
  assert.ok(!tiny[0].endsWith(':'), `took a runt clause break: ${JSON.stringify(tiny[0])}`);
});

test('no piece is shorter than about two seconds of speech', () => {
  // A clip much below this is barely longer than the sound announcing it.
  for (const piece of splitForSpeech(`Hi. ${sentences(30)}`, null)) {
    assert.ok(piece.length >= 20, `runt piece: ${JSON.stringify(piece)}`);
  }
});

test('every piece can be made while the ones before it are still playing', () => {
  // THE property the ladder exists for. Delivery is sequential, so each piece is
  // synthesised only after the previous one has gone out — and it has to be ready
  // before the audio already sent runs out, or the listener hits silence.
  //
  // Measured constants, kept in step with the module: ~650ms + 21.8ms per
  // character to make, 200ms to upload, ~17 characters a second to play.
  const make = (c) => 650 + 21.8 * c + 200;
  const play = (c) => (c / CHARS_PER_SECOND) * 1000;

  for (const script of [sentences(20), sentences(60), sentences(200)]) {
    const pieces = splitForSpeech(script, 2000);
    let slack = play(pieces[0].length);   // nothing is playing while the first is made
    let prev = pieces[0].length;
    for (const piece of pieces.slice(1)) {
      const cost = make(piece.length);
      // Delivery keeps TWO in flight, so this piece began while the previous one
      // was still being made — that overlap is real time and part of the window.
      const window = slack + make(prev);
      assert.ok(cost <= window, `piece needs ${Math.round(cost)}ms, window is ${Math.round(window)}ms`);
      slack += play(piece.length) - cost;
      prev = piece.length;
    }
  }
});

test('the ladder grows — a long answer is a handful of pieces, not a column of them', () => {
  // Buffered audio accumulates, so each piece can be much larger than the last.
  // Sizing off the previous piece alone instead makes it crawl.
  const script = sentences(200);
  const pieces = splitForSpeech(script, 2000);
  // Sized off the previous piece alone this needed roughly twice as many. The
  // ceiling here is the vendor's input limit, not the ladder: once a piece is
  // 2000 characters it cannot grow further, so a very long answer is however many
  // 2000s it takes.
  assert.ok(pieces.length <= Math.ceil(script.length / 2000) + 6, `too many pieces: ${pieces.length}`);
  assert.ok(pieces[5].length > pieces[1].length * 4, 'the ladder should climb quickly');
});

test('a sentence longer than the budget overshoots — but only so far', () => {
  // Running long beats cutting a sentence in two. Running UNBOUNDED does not:
  // text with no punctuation for hundreds of characters is exactly how a
  // "five second" piece once came out over a minute long, so the reach is capped
  // at twice the budget and falls back to a word boundary past that.
  const long = `${'word '.repeat(200).trim()}. ${sentences(10)}`;
  const pieces = splitForSpeech(long, null);
  assert.ok(pieces[0].length <= seconds(3) * 2 + 1, `overshot too far: ${pieces[0].length} chars`);
  assert.equal(pieces.join(' ').replace(/\s+/g, ' '), long.replace(/\s+/g, ' '));
});

test('a sentence that fits inside the reach is kept whole', () => {
  const long = `${'word '.repeat(9).trim()}. ${sentences(10)}`;
  assert.ok(splitForSpeech(long, null)[0].endsWith('.'), 'the sentence should have been kept whole');
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
