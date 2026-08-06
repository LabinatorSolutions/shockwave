// Markdown → Telegram's `entities` format (api/src/telegram/markdownEntities.ts).
//
// Why this is tested: for the life of the Telegram bot the agent's replies went
// out as raw text, so every `**bold**` it wrote arrived with the asterisks
// showing. The fix could have gone three ways — MarkdownV2, HTML, or entities —
// and the first two encode the formatting INTO the string, which means an
// escaping bug is a 400 from Telegram and a message the user never sees.
// Entities keep the text untouched and describe the spans alongside it, so the
// worst failure available is "not bold".
//
// What that buys only holds if the offsets are right. An offset that is off by
// one bolds the wrong word; an offset past the end is rejected outright. They
// are counted in UTF-16 code units, which is what a JS string index already is
// — so the emoji case below is the one that would silently rot if anyone
// "fixed" this to iterate code points.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toTelegram, clampEntities, truncateFormatted, splitFormatted,
} from '../api/src/telegram/markdownEntities.ts';

/** What a span actually covers — the whole point of an offset/length pair. */
const covered = (r, e) => r.text.slice(e.offset, e.offset + e.length);
const only = (r, type) => r.entities.filter((e) => e.type === type);

// ── the markers come out of the text ─────────────────────────────────────────

test('bold markers are removed and the span covers the words', () => {
  const r = toTelegram('Hello **big world** here');
  assert.equal(r.text, 'Hello big world here');
  assert.equal(r.entities.length, 1);
  assert.equal(r.entities[0].type, 'bold');
  assert.equal(covered(r, r.entities[0]), 'big world');
});

test('italic, code and links each survive with the right span', () => {
  const r = toTelegram('an *emphasis*, some `code()`, a [label](https://x.test)');
  assert.equal(r.text, 'an emphasis, some code(), a label');
  assert.equal(covered(r, only(r, 'italic')[0]), 'emphasis');
  assert.equal(covered(r, only(r, 'code')[0]), 'code()');
  const link = only(r, 'text_link')[0];
  assert.equal(covered(r, link), 'label');
  assert.equal(link.url, 'https://x.test');
});

test('nesting produces two spans over the same region, not one flattened one', () => {
  // Telegram allows bold and italic to overlap, so the recursion should emit
  // both rather than picking a winner.
  const r = toTelegram('**bold with *inner* words**');
  assert.equal(r.text, 'bold with inner words');
  assert.equal(covered(r, only(r, 'bold')[0]), 'bold with inner words');
  assert.equal(covered(r, only(r, 'italic')[0]), 'inner');
});

// ── the things Telegram has no syntax for ────────────────────────────────────

test('headings become bold lines and bullets become •', () => {
  const r = toTelegram('# Title\n\n- one\n- two');
  assert.equal(r.text, 'Title\n\n• one\n• two');
  assert.equal(covered(r, only(r, 'bold')[0]), 'Title');
});

test('a fenced block keeps its contents verbatim and marks the language', () => {
  const r = toTelegram('```ts\nconst a = **not bold**;\n```');
  // Nothing inside a code block is markdown, so the asterisks stay.
  assert.equal(r.text, 'const a = **not bold**;');
  const pre = only(r, 'pre')[0];
  assert.equal(pre.language, 'ts');
  assert.equal(covered(r, pre), 'const a = **not bold**;');
});

// ── the cases that make entities worth choosing ──────────────────────────────

test('prose full of MarkdownV2 special characters passes through untouched', () => {
  // Every one of `. - ! ( ) =` would need escaping under MarkdownV2, and a
  // single miss there is a rejected message. Here they are just characters.
  const prose = 'Ready! Costs $5.00 (approx.) — see item #3 [note] = done.';
  const r = toTelegram(prose);
  assert.equal(r.text, prose);
  assert.deepEqual(r.entities, []);
});

test('an unclosed marker mid-stream renders as itself and never throws', () => {
  // This is what the streaming path sends every ~1.3s: a half-typed construct.
  // hermes cannot format this at all (invalid MarkdownV2 → 400 per frame), so
  // it ships raw text until the turn ends. Here it degrades to plain and the
  // formatting appears as soon as the marker closes.
  const r = toTelegram('here comes **half a bo');
  assert.equal(r.text, 'here comes **half a bo');
  assert.deepEqual(r.entities, []);
});

test('offsets count emoji the way Telegram counts them', () => {
  // Telegram measures in UTF-16 code units and so does a JS string index, so an
  // astral emoji is 2 — matching by accident is exactly what must not regress.
  const r = toTelegram('🎉 **party**');
  assert.equal(r.entities[0].offset, 3, 'emoji is 2 units, then the space');
  assert.equal(covered(r, r.entities[0]), 'party');
});

// ── chunking ─────────────────────────────────────────────────────────────────

test('a span straddling a chunk boundary becomes one span per chunk', () => {
  // The string-based route has to close a code fence at the cut and reopen it
  // on the next chunk. Here the span is simply divided, and both halves render.
  const f = { text: 'abcdefghij', entities: [{ type: 'bold', offset: 2, length: 6 }] };
  const left = clampEntities(f.entities, 0, 5);
  const right = clampEntities(f.entities, 5, 10);
  assert.deepEqual(left, [{ type: 'bold', offset: 2, length: 3 }]);
  assert.deepEqual(right, [{ type: 'bold', offset: 0, length: 3 }]);
});

test('spans falling entirely outside a window are dropped, not zero-lengthed', () => {
  // Telegram rejects a zero-length entity, so an empty span must not survive.
  const e = [{ type: 'bold', offset: 0, length: 4 }];
  assert.deepEqual(clampEntities(e, 10, 20), []);
});

test('splitting keeps every chunk under the limit and rebases its spans', () => {
  const body = Array.from({ length: 60 }, (_, i) => `line ${i} **word${i}** tail`).join('\n\n');
  const f = toTelegram(body);
  const chunks = splitFormatted(f, 300);
  assert.ok(chunks.length > 1, 'the fixture must actually split');
  for (const c of chunks) {
    assert.ok(c.text.length <= 300, `chunk of ${c.text.length} exceeds the limit`);
    for (const e of c.entities) {
      assert.ok(e.offset >= 0 && e.offset + e.length <= c.text.length,
        'a span must stay inside the chunk it was rebased into');
      assert.ok(e.length > 0, 'no zero-length spans');
    }
  }
});

test('splitting preserves what each span covers', () => {
  const f = toTelegram(Array.from({ length: 40 }, (_, i) => `para ${i} with **mark${i}** in it`).join('\n\n'));
  const chunks = splitFormatted(f, 250);
  const marked = chunks.flatMap((c) => c.entities.filter((e) => e.type === 'bold').map((e) => covered(c, e)));
  // Every bold word should still be bold, and still be the word it started as —
  // an off-by-one in the rebase shows up here as `mark1` reading `*mark1`.
  assert.equal(marked.length, 40);
  marked.forEach((m, i) => assert.equal(m, `mark${i}`));
});

test('a short message is returned as one chunk with no marker', () => {
  const f = toTelegram('just this');
  assert.deepEqual(splitFormatted(f, 4096), [f]);
});

// ── truncation (the streaming path) ──────────────────────────────────────────

test('truncating drops the spans past the cut and trims the one across it', () => {
  const f = { text: 'abcdefghij', entities: [{ type: 'bold', offset: 6, length: 4 }] };
  const t = truncateFormatted(f, 8);
  assert.equal(t.text, 'abcdefgh');
  assert.deepEqual(t.entities, [{ type: 'bold', offset: 6, length: 2 }]);
});

// ── never lose the message ───────────────────────────────────────────────────

test('empty input is handled and nothing throws on odd markup', () => {
  assert.deepEqual(toTelegram(''), { text: '', entities: [] });
  for (const odd of ['***', '[unclosed](', '```\nno end', '> ', '|a|b|\n|-|-|', '#'.repeat(80)]) {
    const r = toTelegram(odd);
    assert.equal(typeof r.text, 'string');
    assert.ok(Array.isArray(r.entities));
    for (const e of r.entities) {
      assert.ok(e.offset + e.length <= r.text.length, `span escapes the text for ${JSON.stringify(odd)}`);
    }
  }
});
