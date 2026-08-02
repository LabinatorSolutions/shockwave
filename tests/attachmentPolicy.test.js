// Inbound Telegram attachments (api/src/telegram/attachmentPolicy.ts) — what a
// file the user sent IS, and what the agent gets told about it.
//
// Why this is tested: a Telegram photo arrives with no filename and no mime type,
// so the type has to come from the bytes. Getting it wrong is not cosmetic —
// providers check that the declared media type matches the actual bytes and
// reject the whole request, so one wrong guess turns "look at this photo" into a
// failed turn with nothing to show for it. That bug was in this code and this
// file is why it isn't now.
//
// The other half is the notes. They are the only thing that makes a path pointer
// work: the agent has to be told to act on the file rather than ask what to do
// with it, and told plainly when it cannot see an image so it doesn't describe
// one it never got.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  describeAttachment, looksLikeImage, sniffImageMime, safeName, classify,
  composeMessage, imageNote, documentNote, MAX_INBOUND_BYTES,
} from '../api/src/telegram/attachmentPolicy.ts';

const png = (n = 20) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(n)]);
const jpg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(20)]);
const gif = () => Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(20)]);
const webp = () => Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(10)]);

test('image formats are recognised from their bytes', () => {
  assert.equal(sniffImageMime(png()), 'image/png');
  assert.equal(sniffImageMime(jpg()), 'image/jpeg');
  assert.equal(sniffImageMime(gif()), 'image/gif');
  assert.equal(sniffImageMime(webp()), 'image/webp');
  assert.equal(sniffImageMime(Buffer.from('<html>not an image</html>')), null);
});

test('an error page dressed as a photo is refused, not cached', () => {
  // A fetch that returned HTML, or a mislabelled upload. Passing it to a vision
  // model fails the turn, so it never gets that far.
  assert.equal(looksLikeImage(Buffer.from('<html>oops</html>')), false);
  assert.equal(describeAttachment(Buffer.from('<html>oops</html>'), { defaultKind: 'image' }), null);
});

test('a nameless photo still gets the right type and extension', () => {
  // This is the ordinary case: Telegram sends a native photo with no filename and
  // no mime type at all.
  const d = describeAttachment(png(), { defaultKind: 'image', unique: 'abc123' });
  assert.equal(d.kind, 'image');
  assert.equal(d.mimeType, 'image/png');
  assert.match(d.fileName, /\.png$/);
});

test('the bytes overrule a wrong declared type', () => {
  // Senders lie, and a provider rejecting a mismatch costs the whole turn.
  const d = describeAttachment(png(), { filename: 'shot.jpg', mimeType: 'image/jpeg', defaultKind: 'image' });
  assert.equal(d.mimeType, 'image/png');
});

test('a document keeps its own name', () => {
  const d = describeAttachment(Buffer.from('%PDF-1.4'), { filename: 'Q3 report.pdf', mimeType: 'application/pdf', unique: 'ff' });
  assert.equal(d.kind, 'document');
  assert.equal(d.displayName, 'Q3 report.pdf');
  assert.equal(d.mimeType, 'application/pdf');
  assert.equal(d.fileName, 'document_ff_Q3 report.pdf');
});

test('a filename cannot climb out of the staging directory', () => {
  assert.equal(safeName('../../../etc/passwd'), 'passwd');
  assert.equal(safeName('..'), 'file');
  assert.equal(safeName(''), 'file');
  assert.equal(safeName('a/b/c.txt'), 'c.txt');
  assert.doesNotMatch(describeAttachment(Buffer.from('x'), { filename: '../../etc/passwd' }).fileName, /\.\./);
});

test('small text files are inlined, binaries are not', () => {
  assert.equal(describeAttachment(Buffer.from('# hi'), { filename: 'notes.md' }).inlineText, '# hi');
  // A PDF starts with decodable ASCII, which is exactly why the gate is the
  // extension and not "did it decode".
  assert.equal(describeAttachment(Buffer.from('%PDF-1.4 header'), { filename: 'a.pdf' }).inlineText, undefined);
  assert.equal(describeAttachment(Buffer.alloc(200 * 1024), { filename: 'huge.txt' }).inlineText, undefined);
});

test('type is decided by mime, extension, then the caller hint', () => {
  assert.equal(classify('.png', ''), 'image');
  assert.equal(classify('', 'video/mp4'), 'video');
  assert.equal(classify('.mp3', ''), 'audio');
  assert.equal(classify('.zip', ''), 'document');
  assert.equal(classify('', '', 'image'), 'image');
  // A .mp4 sent through the file picker arrives as a document with a real mime,
  // and should still be treated as video.
  assert.equal(classify('.mp4', 'video/mp4'), 'video');
});

test('an image the model can see is a path handle, not a description', () => {
  // The pixels are already attached, so the note only needs to give the agent a
  // string it can pass to a tool — telling it to go read the file would waste a
  // call on something already in front of it.
  const note = imageNote({ displayName: 'a.png', path: '/f/a.png' }, true);
  assert.equal(note, '[Image attached at: /f/a.png]');
});

test('an image the model cannot see says so', () => {
  const note = imageNote({ displayName: 'a.png', path: '/f/a.png' }, false);
  assert.match(note, /cannot view images/);
  assert.match(note, /\/f\/a\.png/);
});

test('the document note tells the agent to act, not to ask', () => {
  // The whole point. Passive wording here made the model reply "what would you
  // like me to do with this?" to a message that already said.
  const note = documentNote({ displayName: 'r.pdf', path: '/f/r.pdf' });
  assert.match(note, /extract the document's text yourself/);
  assert.match(note, /instead of asking the user/);
});

test('the message reads notes first, contents next, the user last', () => {
  const doc = { kind: 'document', displayName: 'a.md', path: '/f/a.md', inlineText: '# hi' };
  const msg = composeMessage([doc], 'summarise this', false);
  assert.ok(msg.indexOf('The user sent a text document') < msg.indexOf('[Content of a.md]'));
  assert.ok(msg.indexOf('[Content of a.md]') < msg.indexOf('summarise this'));
});

test('a message with no attachments is just what the user typed', () => {
  assert.equal(composeMessage([], 'hello', false), 'hello');
});

test('the inbound cap is Telegram\'s, not a number we picked', () => {
  assert.equal(MAX_INBOUND_BYTES, 20 * 1024 * 1024);
});
