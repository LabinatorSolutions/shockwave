// The TTL sweep is the one piece of the app whose whole job is DELETING the
// user's files, and it runs unattended — at boot on the desktop, hourly on the
// companion — so nothing about it is observable until something is already gone.
// It also runs in two processes against one rule, which is why the rule is a
// shared module (`agent-core/scratchSweep.ts`) and why it's pinned here rather
// than in either host.
//
// Real directories in a temp dir, with mtimes backdated via `fs.utimes`. The
// claim is about what the filesystem reports and what gets removed, so a stubbed
// fs would only test the stub.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sweepScratchDirs, resolveTtlDays, DEFAULT_SCRATCH_TTL_DAYS } from '../agent-core/scratchSweep.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

/** A base dir holding one directory per named chat, each aged `days` old. */
function base(chats) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shockwave-sweep-'));
  for (const [chatId, days] of Object.entries(chats)) {
    const dir = path.join(root, chatId);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'work.txt'), 'something the agent made\n');
    const when = new Date(Date.now() - days * DAY_MS);
    fs.utimesSync(dir, when, when);
  }
  return root;
}

const listed = (dir) => fs.readdirSync(dir).sort();

test('deletes dirs older than the TTL and keeps fresh ones', async () => {
  const root = base({ old: 10, fresh: 1 });
  const [removed] = await sweepScratchDirs([root], { ttlDays: 7, keep: new Set() });
  assert.equal(removed, 1);
  assert.deepEqual(listed(root), ['fresh']);
});

// The feature: pinning a chat means its working files outlive the TTL. Age is
// not consulted at all for these, so a chat pinned and then left for a year is
// still intact.
test('never deletes a pinned chat, however old', async () => {
  const root = base({ pinned: 400, unpinned: 400 });
  const [removed] = await sweepScratchDirs([root], { ttlDays: 7, keep: new Set(['pinned']) });
  assert.equal(removed, 1);
  assert.deepEqual(listed(root), ['pinned']);
});

// Unpinning has to actually release the dir — otherwise "pinned" would be a
// one-way door and the disk would only ever grow.
test('an unpinned chat ages out on the next sweep', async () => {
  const root = base({ chat: 10 });
  const [kept] = await sweepScratchDirs([root], { ttlDays: 7, keep: new Set(['chat']) });
  assert.equal(kept, 0);
  const [removed] = await sweepScratchDirs([root], { ttlDays: 7, keep: new Set() });
  assert.equal(removed, 1);
  assert.deepEqual(listed(root), []);
});

// The companion passes three bases in one call (checkouts, pi scratch, scratch
// pads) and logs them separately, so the counts must come back per base and in
// the order given — not summed.
test('reports removals per base, in order', async () => {
  const a = base({ one: 10, two: 10 });
  const b = base({ three: 10 });
  const c = base({ fresh: 1 });
  assert.deepEqual(await sweepScratchDirs([a, b, c], { ttlDays: 7, keep: new Set() }), [2, 1, 0]);
});

// A base only exists once something has written to it: a fresh install sweeps
// before the agent has ever run. Throwing there would take out the boot path.
test('a base that does not exist yet is not an error', async () => {
  const missing = path.join(os.tmpdir(), 'shockwave-sweep-nope-does-not-exist');
  assert.deepEqual(await sweepScratchDirs([missing], { ttlDays: 7, keep: new Set() }), [0]);
});

// The setting is optional and lives on the companion, which stores no defaults —
// so unset arrives as `undefined` and both hosts hand it straight through. Junk
// and 0 must land on the default rather than on "delete everything now".
test('an unset or nonsense TTL falls back to the default', () => {
  assert.equal(resolveTtlDays(undefined), DEFAULT_SCRATCH_TTL_DAYS);
  assert.equal(resolveTtlDays(null), DEFAULT_SCRATCH_TTL_DAYS);
  assert.equal(resolveTtlDays(0), DEFAULT_SCRATCH_TTL_DAYS);
  assert.equal(resolveTtlDays(-3), DEFAULT_SCRATCH_TTL_DAYS);
  assert.equal(resolveTtlDays('banana'), DEFAULT_SCRATCH_TTL_DAYS);
  assert.equal(resolveTtlDays('14'), 14);
  assert.equal(resolveTtlDays(2), 2);
});

test('an unset TTL keeps a dir the default would keep', async () => {
  const root = base({ recent: DEFAULT_SCRATCH_TTL_DAYS - 1, ancient: DEFAULT_SCRATCH_TTL_DAYS + 1 });
  const [removed] = await sweepScratchDirs([root], { ttlDays: undefined, keep: new Set() });
  assert.equal(removed, 1);
  assert.deepEqual(listed(root), ['recent']);
});

// A chat delete removes its scratch dir directly, so a sweep can find the entry
// gone between readdir and stat. That race is normal, not a fault.
test('an entry that vanishes mid-sweep is not an error', async () => {
  const root = base({ gone: 10, old: 10 });
  await fsp.rm(path.join(root, 'gone'), { recursive: true, force: true });
  const [removed] = await sweepScratchDirs([root], { ttlDays: 7, keep: new Set() });
  assert.equal(removed, 1);
  assert.deepEqual(listed(root), []);
});
