// Inbound attachments (agent-core/attachmentPolicy.ts) — what a file the user
// sent IS, and what the agent gets told about it.
//
// It covers BOTH hosts: the companion takes files over Telegram and the desktop
// takes them through the chat composer, and since they run one policy module a
// case proved here is proved for both.
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
import { mkdtemp, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import {
  describeAttachment, looksLikeImage, sniffImageMime, safeName, classify,
  composeMessage, imageNote, documentNote, writeAttachment,
  MAX_INBOUND_BYTES, MAX_TEXT_INLINE_BYTES,
} from '../agent-core/attachmentPolicy.ts';

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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

// ── writeAttachment: the write both hosts share ──────────────────────────────
//
// The desktop composer and the Telegram webhook call this same function with
// different directories (`chatScratchDir` / `chatFilesDir`). Before it existed the
// desktop had no way to put a file anywhere, so anything that wasn't an image or
// a known text extension was answered with "unsupported format" — while the
// system prompt told the agent that files the user sends it arrive in its scratch
// pad. These pin the shape that made that sentence true.

test('a tarball is saved and pointed at, not refused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'shockwave-att-'));
  const stored = await writeAttachment(dir, Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00]), {
    filename: 'backup.tar.gz',
    mimeType: 'application/gzip',
  });

  assert.equal(stored.kind, 'document');
  assert.equal(stored.displayName, 'backup.tar.gz');
  assert.equal(stored.inlineText, undefined, 'gzip bytes must never be pasted into the prompt');
  assert.equal(dirname(stored.path), dir);
  assert.ok(existsSync(stored.path), 'the note names a path, so the path has to exist');

  // And what the agent is told about it is a path plus an instruction to open it.
  assert.match(composeMessage([stored], 'unpack this', false), new RegExp(escapeRe(stored.path)));
});

test('a text file is BOTH saved and inlined', async () => {
  // The two halves answer different needs: the contents so it can read without a
  // tool call, the path so it can move, edit or commit the file.
  const dir = await mkdtemp(join(tmpdir(), 'shockwave-att-'));
  const stored = await writeAttachment(dir, Buffer.from('line one\nline two\n'), {
    filename: 'notes.txt',
    mimeType: 'text/plain',
  });

  assert.equal(stored.inlineText, 'line one\nline two\n');
  assert.equal(await readFile(stored.path, 'utf8'), 'line one\nline two\n');

  const msg = composeMessage([stored], 'what does this say?', false);
  assert.match(msg, /Its content has been included below/);
  assert.match(msg, new RegExp(escapeRe(stored.path)));
});

test('a text file over the inline cap is saved and pointed at instead', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'shockwave-att-'));
  const big = Buffer.from('x'.repeat(MAX_TEXT_INLINE_BYTES + 1));
  const stored = await writeAttachment(dir, big, { filename: 'huge.log', mimeType: 'text/plain' });

  assert.equal(stored.inlineText, undefined, 'a megabyte of log must not become the prompt');
  assert.equal((await readFile(stored.path)).length, big.length);
});

test('an image is saved too, so the agent gets a handle as well as the pixels', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'shockwave-att-'));
  const stored = await writeAttachment(dir, png(), { filename: 'shot.png', mimeType: 'image/png' });

  assert.equal(stored.kind, 'image');
  assert.ok(existsSync(stored.path));
  // Vision on: the pixels went too, and the note is just the handle.
  assert.equal(composeMessage([stored], '', true), `[Image attached at: ${stored.path}]`);
  // Vision off: it must not be left to claim it looked at something it never got.
  assert.match(composeMessage([stored], '', false), /cannot view images/);
});

test('two files with the same name both survive', async () => {
  // The stored name carries a random segment, so attaching the same file twice
  // (or two `report.pdf`s from different folders) can't have one overwrite the other.
  const dir = await mkdtemp(join(tmpdir(), 'shockwave-att-'));
  const a = await writeAttachment(dir, Buffer.from('one'), { filename: 'report.pdf' });
  const b = await writeAttachment(dir, Buffer.from('two'), { filename: 'report.pdf' });

  assert.notEqual(a.path, b.path);
  assert.equal(await readFile(a.path, 'utf8'), 'one');
  assert.equal(await readFile(b.path, 'utf8'), 'two');
  assert.equal(a.displayName, 'report.pdf', 'the user still sees their own name');
});

test('a crafted filename cannot escape the directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'shockwave-att-'));
  const stored = await writeAttachment(dir, Buffer.from('x'), { filename: '../../etc/passwd' });
  assert.equal(dirname(stored.path), dir);
});

test('bytes claiming to be an image and clearly not are the ONE refusal', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'shockwave-att-'));
  const html = Buffer.from('<!doctype html><title>404</title>');
  assert.equal(await writeAttachment(dir, html, { filename: 'photo.jpg', mimeType: 'image/jpeg' }), null);
  // Same bytes, not claiming to be an image: accepted, like everything else.
  assert.ok(await writeAttachment(dir, html, { filename: 'page.html', mimeType: 'text/html' }));
});
