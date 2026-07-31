// The one piece of logic between "the user sent a picture" and "the picture is
// stored". Everything else in that path is plumbing (an HTTP POST that already
// existed, an insert, a protocol handler); this is the filter that decides
// whether an image survives the trip from pi's message into a `ChatRow`.
//
// It is worth pinning because its failure mode is silence. `content` is
// deliberately text-only, so if this returns nothing, no row is written, no
// request fails, and nothing logs — chat images just quietly stop appearing,
// which is precisely the bug this feature was built to fix.

import test from 'node:test';
import assert from 'node:assert/strict';
import { imagesOf } from '../agent-core/messageImages.js';

const img = (over = {}) => ({ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png', ...over });
const txt = (text = 'hi') => ({ type: 'text', text });

test('keeps an image part alongside text', () => {
  assert.deepEqual(imagesOf([txt('what is this?'), img()]), [
    { mimeType: 'image/png', data: 'aGVsbG8=' },
  ]);
});

test('keeps every image, in order — an album must not collapse to one', () => {
  const out = imagesOf([img({ data: 'AAA=' }), txt(), img({ data: 'BBB=' })]);
  assert.deepEqual(out.map((i) => i.data), ['AAA=', 'BBB=']);
});

test('undefined — not [] — when the message is plain text', () => {
  // Every message in every turn carries this field; an empty array on all of
  // them is pure noise in each request body and each stored row.
  assert.equal(imagesOf([txt()]), undefined);
  assert.equal(imagesOf([]), undefined);
});

test('a string content (pi allows it) yields no images rather than throwing', () => {
  assert.equal(imagesOf('just text'), undefined);
  assert.equal(imagesOf(null), undefined);
  assert.equal(imagesOf(undefined), undefined);
});

test('drops an image part with no bytes', () => {
  // A zero-length attachment renders as a permanently broken image. Better for
  // the message to not claim it had one.
  assert.equal(imagesOf([img({ data: '' })]), undefined);
  assert.equal(imagesOf([img({ data: undefined })]), undefined);
  assert.equal(imagesOf([img({ data: 123 })]), undefined);
});

test('falls back to a generic mime type rather than dropping the image', () => {
  // The bytes are what matter; a missing type is the server's problem to guess,
  // not a reason to lose the picture.
  assert.deepEqual(imagesOf([img({ mimeType: undefined })]), [
    { mimeType: 'application/octet-stream', data: 'aGVsbG8=' },
  ]);
});

test('ignores non-image parts that are not text either', () => {
  const out = imagesOf([{ type: 'thinking', thinking: 'hm' }, { type: 'toolCall', id: '1' }, img()]);
  assert.equal(out.length, 1);
});

test('tolerates junk entries in the content array', () => {
  assert.deepEqual(imagesOf([null, undefined, 'nope', 42, img()]), [
    { mimeType: 'image/png', data: 'aGVsbG8=' },
  ]);
});
