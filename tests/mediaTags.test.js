// The file-delivery parser (agent-core/mediaTags.js) — what decides that a path
// the agent typed becomes a file in the user's Telegram.
//
// Why this is tested: every rule here exists because getting it wrong sends the
// wrong file, or sends one nobody asked for. A path inside a code fence is being
// SHOWN, not sent — matching it means answering "how do I link an image?" by
// mailing the user that image. A path inside a JSON string is stored tool output
// holding an earlier reply, so matching it re-sends the same file on every turn
// afterwards. And the two passes are chained rather than run independently
// because that chaining IS the deduplication: a path claimed by a MEDIA: tag is
// cut from the text before the bare-path scan can claim it a second time.
//
// The containment check is the other half. Delivery reads from two folders and
// nowhere else, so there is no list of forbidden paths to keep current — but that
// only holds if symlinks are resolved BEFORE the check, since the agent can write
// a link inside a folder it is allowed to use.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import {
  extractMedia, extractLocalFiles, validateDeliveryPath, filterDeliveryPaths,
  deliveryKind, maskProtectedSpans, maskJsonStringMedia,
} from '../agent-core/mediaTags.js';

// realpath: on macOS the temp dir is under a symlinked /var, and the validator
// resolves before comparing, so the expected values must be resolved too.
async function tmpWorkspace() {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mediatags-')));
  const file = path.join(dir, 'report.pdf');
  await fs.writeFile(file, 'pretend pdf');
  return { dir, file };
}

test('a tagged path is delivered and removed from the reply', () => {
  const r = extractMedia('All done MEDIA:/tmp/report.pdf');
  assert.deepEqual(r.media, [{ path: '/tmp/report.pdf', isVoice: false }]);
  assert.equal(r.cleaned, 'All done');
});

test('quoted paths survive spaces in the filename', () => {
  assert.equal(extractMedia('MEDIA:"/tmp/my report.pdf"').media[0].path, '/tmp/my report.pdf');
  assert.equal(extractMedia('MEDIA:`/tmp/my report.pdf`').media[0].path, '/tmp/my report.pdf');
});

test('a tag with an unknown extension is left alone, not swallowed', () => {
  // Deliberate: it stays in the text so the bare-path pass can still consider it,
  // rather than being deleted from the reply and never delivered.
  const r = extractMedia('MEDIA:/tmp/thing.xyz');
  assert.equal(r.media.length, 0);
  assert.match(r.cleaned, /MEDIA:\/tmp\/thing\.xyz/);
});

test('a path being shown in a code fence is not sent, and stays visible', () => {
  const reply = 'Write it like this:\n```\nMEDIA:/tmp/example.png\n```\nThat is the syntax.';
  const r = extractMedia(reply);
  assert.equal(r.media.length, 0);
  assert.match(r.cleaned, /MEDIA:\/tmp\/example\.png/);
});

test('inline code and blockquotes are protected too', () => {
  assert.equal(extractMedia('use `MEDIA:/tmp/a.png` for that').media.length, 0);
  assert.equal(extractMedia('> MEDIA:/tmp/a.png').media.length, 0);
});

test('a backtick-quoted path after MEDIA: is a path, not inline code', () => {
  // The masker skips this one case on purpose; without the exception, the quoted
  // form would be masked as inline code and never extracted.
  assert.equal(extractMedia('MEDIA:`/tmp/a.png`').media.length, 1);
});

test('a MEDIA: inside stored JSON output is not re-delivered', () => {
  const toolResult = '{"result": "MEDIA:/tmp/from-last-turn.png"}';
  assert.equal(extractMedia(toolResult).media.length, 0);
});

test('masking keeps offsets so the cut lands on the right characters', () => {
  const s = 'a `code` b';
  assert.equal(maskProtectedSpans(s).length, s.length);
  const j = '{"k": "MEDIA:/a/b.png"}';
  assert.equal(maskJsonStringMedia(j).length, j.length);
});

test('a bare path is delivered only when the file is really there', async () => {
  const { dir, file } = await tmpWorkspace();
  const missing = path.join(dir, 'never-written.pdf');
  const r = await extractLocalFiles(`I saved ${file} but not ${missing}`);
  assert.deepEqual(r.paths, [file]);
  assert.doesNotMatch(r.cleaned, /report\.pdf/);
  await fs.rm(dir, { recursive: true, force: true });
});

test('the same file named twice is delivered once', async () => {
  const { dir, file } = await tmpWorkspace();
  const r = await extractLocalFiles(`${file} and again ${file}`);
  assert.deepEqual(r.paths, [file]);
  await fs.rm(dir, { recursive: true, force: true });
});

test('chaining the passes is what stops a double send', async () => {
  const { dir, file } = await tmpWorkspace();
  const tagged = extractMedia(`Done MEDIA:${file}`);
  const bare = await extractLocalFiles(tagged.cleaned);
  assert.equal(tagged.media.length, 1);
  assert.equal(bare.paths.length, 0, 'the tagged path must be gone before the bare scan runs');
  await fs.rm(dir, { recursive: true, force: true });
});

test('urls and relative paths are not files to send', async () => {
  assert.equal((await extractLocalFiles('see https://example.com/pic.png')).paths.length, 0);
  assert.equal((await extractLocalFiles('see ./pic.png')).paths.length, 0);
});

test('missing paths are reported so a promised file that never arrives is traceable', async () => {
  const seen = [];
  await extractLocalFiles('it is at /nope/absent.pdf', (raw) => seen.push(raw));
  assert.deepEqual(seen, ['/nope/absent.pdf']);
});

test('only files inside an allowed folder can be sent', async () => {
  const { dir, file } = await tmpWorkspace();
  assert.equal(await validateDeliveryPath(file, [dir]), file);
  assert.equal(await validateDeliveryPath(file, ['/somewhere/else']), null);
  assert.equal(await validateDeliveryPath('/etc/hosts', [dir]), null);
  assert.equal(await validateDeliveryPath(dir, [dir]), null, 'a directory is not a file');
  assert.equal(await validateDeliveryPath('relative.pdf', [dir]), null);
  assert.equal(await validateDeliveryPath('', [dir]), null);
  await fs.rm(dir, { recursive: true, force: true });
});

test('a symlink cannot walk out of an allowed folder', async () => {
  // The agent can write inside the folders it is allowed to use, so a link
  // planted there is the obvious way out if the check ran on the path as typed.
  const { dir } = await tmpWorkspace();
  const escape = path.join(dir, 'innocent.pdf');
  await fs.symlink('/etc/hosts', escape);
  assert.equal(await validateDeliveryPath(escape, [dir]), null);
  await fs.rm(dir, { recursive: true, force: true });
});

test('a sibling folder sharing a name prefix is still outside', async () => {
  const { dir, file } = await tmpWorkspace();
  assert.equal(await validateDeliveryPath(file, [dir + '-other']), null);
  await fs.rm(dir, { recursive: true, force: true });
});

test('filtering keeps the voice flag with its path', async () => {
  const { dir, file } = await tmpWorkspace();
  const kept = await filterDeliveryPaths(
    [{ path: file, isVoice: true }, { path: '/etc/hosts', isVoice: false }], [dir],
  );
  assert.deepEqual(kept, [{ path: file, isVoice: true }]);
  await fs.rm(dir, { recursive: true, force: true });
});

test('each file type goes out the way Telegram expects', () => {
  assert.equal(deliveryKind('/a/b.png'), 'photo');
  assert.equal(deliveryKind('/a/b.mp4'), 'video');
  assert.equal(deliveryKind('/a/b.mp3'), 'audio');
  assert.equal(deliveryKind('/a/b.pdf'), 'document');
  // Telegram only accepts Opus/OGG as a voice bubble, and an ordinary .ogg
  // attachment shouldn't become one just because of its format.
  assert.equal(deliveryKind('/a/b.ogg'), 'document');
  assert.equal(deliveryKind('/a/b.ogg', { isVoice: true }), 'voice');
  // sendPhoto recompresses; [[as_document]] is how a caller keeps the original.
  assert.equal(deliveryKind('/a/b.png', { forceDocument: true }), 'document');
});
