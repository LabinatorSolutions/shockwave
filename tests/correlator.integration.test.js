// Integration test — correlator + real @parcel/watcher + real fs ops.
// Run via `npm test`.
//
// The harness drives the SAME `createWatcherDispatch` mapping main.ts uses, so
// this test verifies the real parcel→correlator behavior (deletes-before-creates
// batch ordering, atomic-save-as-create-of-known-path, folder-rename via
// directory expansion).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import watcher from '@parcel/watcher';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createRenameCorrelator } from '../src/main/renameCorrelator.ts';
import { createWatcherDispatch } from '../src/main/watcherDispatch.ts';

// Injected dispatch deps. main.ts supplies pathResolver.ts's versions; these are
// equivalent (pathResolver is .ts and can't be imported under the node runner).
const isMdFile = (p) => /\.md$/i.test(p);

async function walkMarkdownPaths(dir) {
  const out = [];
  async function rec(d) {
    let entries;
    try { entries = await fs.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue;
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) await rec(full);
      else if (isMdFile(ent.name)) out.push(full);
    }
  }
  await rec(dir);
  return out;
}

// Hash helper used by both the seeder and the watcher path.
async function hashFile(p) {
  try {
    const buf = await fs.readFile(p);
    return crypto.createHash('sha1').update(buf).digest('hex');
  } catch {
    return null;
  }
}

// Build a harness with a fresh tmp dir + parcel watcher + correlator + the
// shared dispatch. Returns control handles for the test.
async function setupHarness() {
  // realpath: on macOS os.tmpdir() is /var/... (a symlink to /private/var/...)
  // and @parcel/watcher reports realpath-resolved paths, so resolve up front to
  // keep the paths the test computes identical to the ones parcel emits.
  const ROOT = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sw-int-')));
  const emitted = [];
  const corr = createRenameCorrelator({
    emit: (e) => emitted.push(e),
    graceMs: 400,
  });

  const isIgnored = (p) => {
    const rel = path.relative(ROOT, p);
    if (!rel || rel.startsWith('..')) return false;
    return rel.split(path.sep).some((seg) => seg.startsWith('.'));
  };

  const dispatch = createWatcherDispatch({
    correlator: corr,
    isMdFile,
    isDrawingFile: (p) => /\.excalidraw$/i.test(p),
    isReloadableText: (p) => /\.(txt|text|json|jsonc|ya?ml|toml|ini|cfg|conf|xml|html?|css|js|mjs|cjs|ts|tsx|jsx|py|sh|sql|csv|tsv|log)$/i.test(p),
    statPath: (p) => fs.stat(p, { bigint: true }).catch(() => null),
    hashFile,
    walkMarkdown: walkMarkdownPaths,
    isIgnored,
    // pending/tree sinks aren't asserted here — the tests observe correlator emits.
    getPending: () => undefined,
    setPending: () => {},
    markTreeOnly: () => {},
  });

  const sub = await watcher.subscribe(ROOT, (err, events) => {
    if (err) return;
    dispatch.handleBatch(events);
  }, { ignore: ['**/.*', '**/.*/**'] });

  // Wait until the correlator has been quiet for `quiet` ms. The window has to
  // clear the correlator's grace (400ms here) plus however long parcel takes to
  // deliver, because an unlink that is really a delete emits nothing until the
  // grace expires — return early and a delete looks like it never happened.
  // Polled rather than slept in whole windows: the old version spent two full
  // 700ms sleeps per call doing nothing, which was ~100s of the suite's runtime.
  async function settle(quiet = 700) {
    const POLL = 25;
    let count = emitted.length;
    let lastChange = Date.now();
    while (Date.now() - lastChange < quiet) {
      await new Promise((r) => setTimeout(r, POLL));
      if (emitted.length !== count) {
        count = emitted.length;
        lastChange = Date.now();
      }
    }
  }

  /**
   * Wait for `n` events, THEN for quiet — for a test that knows how many it expects.
   *
   * `settle()` alone conflates two different things: what was emitted, and how
   * fast. It returns after 700ms with no new event, which is a guess that the
   * watcher is finished — and under load it is wrong. That is exactly how the
   * batch test failed, roughly one run in ten:
   *
   *     types: {"rename":10,"add":4,"unlink":5}   — expected add: 5
   *
   * Every rename paired and every delete fired; one create event simply arrived
   * after the window closed. The correlator was right and the harness stopped
   * listening. Waiting for the count first removes the clock from the passing
   * path — a slow watcher now costs seconds, not a red test.
   *
   * It still catches BOTH failure modes. Too few: the count never arrives and it
   * fails on the timeout, having genuinely waited. Too many: the quiet period
   * after the count runs anyway, so an extra event lands before the assertion.
   */
  async function settleFor(n, timeoutMs = 10_000) {
    const POLL = 25;
    const deadline = Date.now() + timeoutMs;
    while (emitted.length < n && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL));
    }
    await settle();
  }

  async function teardown() {
    await sub.unsubscribe();
    await fs.rm(ROOT, { recursive: true, force: true });
  }

  // Seed the correlator's identity map for a file as if main.js had just
  // written/observed it. The watcher will also fire 'add' for it; we wait
  // for that and clear the emitted log before the test action.
  async function seed(name, content) {
    const p = path.join(ROOT, name);
    await fs.writeFile(p, content);
    await settle();
    emitted.length = 0;
    return p;
  }

  return { ROOT, corr, emitted, settle, settleFor, teardown, seed };
}

test('integration: single rename emits exactly one rename event', async () => {
  const h = await setupHarness();
  try {
    const a = await h.seed('a.md', 'hello a\n');
    const b = path.join(h.ROOT, 'b.md');
    await fs.rename(a, b);
    await h.settleFor(1);
    assert.deepEqual(h.emitted, [{ type: 'rename', oldPath: a, newPath: b }]);
  } finally {
    await h.teardown();
  }
});

test('integration: batch rename of 10 files -> 10 renames, 0 unlinks, 0 adds', async () => {
  const h = await setupHarness();
  try {
    const olds = [];
    for (let i = 0; i < 10; i++) {
      olds.push(await h.seed(`b-${i}.md`, `content ${i}\n`));
    }
    const news = olds.map((p) => p.replace(/b-(\d+)\.md$/, 'b-$1-renamed.md'));
    await Promise.all(olds.map((from, i) => fs.rename(from, news[i])));
    await h.settleFor(10);

    const counts = h.emitted.reduce((a, e) => ((a[e.type] = (a[e.type] || 0) + 1), a), {});
    assert.deepEqual(counts, { rename: 10 }, `counts: ${JSON.stringify(counts)}`);

    // Each old paired to its expected new
    const renames = new Map();
    for (const e of h.emitted) renames.set(e.oldPath, e.newPath);
    for (let i = 0; i < 10; i++) {
      assert.equal(renames.get(olds[i]), news[i]);
    }
  } finally {
    await h.teardown();
  }
});

test('integration: real delete -> unlink event after grace', async () => {
  const h = await setupHarness();
  try {
    const p = await h.seed('del.md', 'going away\n');
    await fs.unlink(p);
    await h.settleFor(1);
    assert.deepEqual(h.emitted, [{ type: 'unlink', path: p }]);
  } finally {
    await h.teardown();
  }
});

test('integration: new file -> add event (no false rename)', async () => {
  const h = await setupHarness();
  try {
    const p = path.join(h.ROOT, 'brand-new.md');
    await fs.writeFile(p, 'fresh\n');
    await h.settleFor(1);
    assert.deepEqual(h.emitted, [{ type: 'add', path: p }]);
  } finally {
    await h.teardown();
  }
});

test('integration: rename + simultaneous delete + simultaneous new add', async () => {
  const h = await setupHarness();
  try {
    const renSrc = await h.seed('R.md', 'rename me\n');
    const delPath = await h.seed('D.md', 'delete me\n');
    const newPath = path.join(h.ROOT, 'N.md');
    const renDst = path.join(h.ROOT, 'R2.md');

    await Promise.all([
      fs.rename(renSrc, renDst),
      fs.unlink(delPath),
      fs.writeFile(newPath, 'new file\n'),
    ]);
    await h.settleFor(3);

    const types = h.emitted.reduce((a, e) => ((a[e.type] = (a[e.type] || 0) + 1), a), {});
    assert.deepEqual(types, { rename: 1, unlink: 1, add: 1 }, `types: ${JSON.stringify(types)} emitted: ${JSON.stringify(h.emitted)}`);

    const rename = h.emitted.find((e) => e.type === 'rename');
    const unlink = h.emitted.find((e) => e.type === 'unlink');
    const add = h.emitted.find((e) => e.type === 'add');
    assert.equal(rename.oldPath, renSrc);
    assert.equal(rename.newPath, renDst);
    assert.equal(unlink.path, delPath);
    assert.equal(add.path, newPath);
  } finally {
    await h.teardown();
  }
});

test('integration: atomic save -> NOT classified as rename (no unlink/add seen)', async () => {
  const h = await setupHarness();
  try {
    const target = await h.seed('note.md', 'v1\n');
    const tmp = path.join(h.ROOT, 'note.md.tmp');
    await fs.writeFile(tmp, 'v2\n');
    await fs.rename(tmp, target);
    await h.settle();
    // parcel reports an atomic save as create-of-the-existing-file (+ delete of
    // the temp), which the dispatch routes to onPathSeen — not the correlator's
    // emit path. So h.emitted should not contain anything.
    assert.deepEqual(h.emitted, []);
  } finally {
    await h.teardown();
  }
});

test('integration: rename of identical-content files: both pair correctly', async () => {
  const h = await setupHarness();
  try {
    // Identical content, different files. macOS APFS will assign different inos.
    const content = 'exactly the same\n';
    const a = await h.seed('iden-a.md', content);
    const b = await h.seed('iden-b.md', content);
    const aRen = path.join(h.ROOT, 'iden-a-r.md');
    const bRen = path.join(h.ROOT, 'iden-b-r.md');

    await Promise.all([fs.rename(a, aRen), fs.rename(b, bRen)]);
    await h.settleFor(2);

    const counts = h.emitted.reduce((a, e) => ((a[e.type] = (a[e.type] || 0) + 1), a), {});
    assert.deepEqual(counts, { rename: 2 }, `counts: ${JSON.stringify(counts)}`);

    const map = new Map(h.emitted.map((e) => [e.oldPath, e.newPath]));
    assert.equal(map.get(a), aRen);
    assert.equal(map.get(b), bRen);
  } finally {
    await h.teardown();
  }
});

test('integration: file moves between subfolders', async () => {
  const h = await setupHarness();
  try {
    await fs.mkdir(path.join(h.ROOT, 'src'));
    await fs.mkdir(path.join(h.ROOT, 'dest'));
    const a = path.join(h.ROOT, 'src', 'moved.md');
    await fs.writeFile(a, 'will move\n');
    await h.settle();
    h.emitted.length = 0;

    const b = path.join(h.ROOT, 'dest', 'moved.md');
    await fs.rename(a, b);
    await h.settleFor(1);

    // Filter to file events (folder events would show up as separate types only
    // when we add/remove the folders, not when we rename inside them).
    const fileEvents = h.emitted.filter((e) => e.type === 'rename' || e.type === 'add' || e.type === 'unlink');
    assert.deepEqual(fileEvents, [{ type: 'rename', oldPath: a, newPath: b }]);
  } finally {
    await h.teardown();
  }
});

test('integration: folder rename -> per-file renames inside', async () => {
  const h = await setupHarness();
  try {
    const folder = path.join(h.ROOT, 'old-folder');
    await fs.mkdir(folder);
    const f1 = path.join(folder, 'one.md');
    const f2 = path.join(folder, 'two.md');
    await fs.writeFile(f1, 'one\n');
    await fs.writeFile(f2, 'two\n');
    await h.settle();
    h.emitted.length = 0;

    const newFolder = path.join(h.ROOT, 'new-folder');
    await fs.rename(folder, newFolder);
    await h.settle();

    const renames = h.emitted.filter((e) => e.type === 'rename');
    const expectedNew1 = path.join(newFolder, 'one.md');
    const expectedNew2 = path.join(newFolder, 'two.md');
    const map = new Map(renames.map((e) => [e.oldPath, e.newPath]));
    assert.equal(map.get(f1), expectedNew1);
    assert.equal(map.get(f2), expectedNew2);

    // No stray unlinks or adds for the files inside (the folder itself isn't
    // tracked by this correlator).
    const stray = h.emitted.filter((e) =>
      (e.type === 'unlink' && (e.path === f1 || e.path === f2))
      || (e.type === 'add' && (e.path === expectedNew1 || e.path === expectedNew2))
    );
    assert.deepEqual(stray, [], `stray events: ${JSON.stringify(stray)}`);
  } finally {
    await h.teardown();
  }
});

// The mixed-batch case (10 renames + 5 deletes + 5 adds at once) is NOT here.
// It lives in `correlator.unit.test.js`, driven directly with no watcher.
//
// It was here, and it flaked at roughly one run in ten — always the same way:
// every rename paired, every delete fired, and one create event arrived after
// the harness had stopped listening. The correlator was correct on every run
// including the failures; what was unreliable was fsevents' delivery timing.
//
// A test that goes red when nothing is broken trains you to ignore red. Since
// the thing it was proving is pairing logic, and pairing logic needs no real
// filesystem, it belongs where the events can just be handed over.
//
// What stays in this file is what genuinely needs a real watcher: that our
// dispatch reads parcel's event SHAPES correctly — atomic save arriving as a
// create of a known path, folder rename arriving as delete+create of a
// directory, deletes ordered before creates within a batch. Those are small and
// have nothing to race.
