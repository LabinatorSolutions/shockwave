// The warm-checkout queue's claim (`claimWarmCheckout` in api/src/git.ts).
//
// The queue's whole safety story is that a folder's LOCATION is its state and
// every move is a rename: `setup/` is unfinished, `ready/` is usable, and a
// rename into the chat's own folder is what claims it. None of that is enforced
// by a type — it is enforced by which directory a thing is in and by rename
// being atomic — so this is where it gets checked.
//
// Runs the REAL function, bundled the way the server bundles it (esbuild, the
// api's own node_modules), rather than a mirror. The git operations either side
// of it are covered by checkoutReuse.test.js and by prepareCheckout's own clone
// path; what is only testable here is the bookkeeping.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.join(here, '..', 'api');

let claimWarmCheckout;
let base; // AGENT_DATA_DIR for this run

before(() => {
  // AGENT_DATA_DIR is read when the module is first evaluated, so it has to be
  // set before the import — hence the dynamic import below rather than a static
  // one at the top of the file.
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'shockwave-pool-'));
  process.env.AGENT_DATA_DIR = base;

  // Built into api/dist, not the temp dir: the bundle leaves its dependencies
  // external (as the server's does), so it has to sit where api/node_modules
  // resolves from.
  const bundle = path.join(apiDir, 'dist', 'checkoutPool.testbundle.mjs');
  execFileSync('npx', [
    'esbuild', 'src/git.ts',
    '--bundle', '--platform=node', '--format=esm', '--target=node22',
    '--packages=external', `--outfile=${bundle}`,
  ], { cwd: apiDir, stdio: 'pipe' });

  return import(pathToFileURL(bundle).href).then((m) => { claimWarmCheckout = m.claimWarmCheckout; });
});

after(() => {
  fs.rmSync(path.join(apiDir, 'dist', 'checkoutPool.testbundle.mjs'), { force: true });
  fs.rmSync(base, { recursive: true, force: true });
});

const TARGET = { owner: 'acme', repo: 'notes', branch: 'main' };

/** The real claim, with this fixture's target. */
const claim = (dest) => claimWarmCheckout(TARGET.owner, TARGET.repo, TARGET.branch, dest);
const readyDir = () => path.join(base, 'pool', 'ready');
const setupDir = () => path.join(base, 'pool', 'setup');
const workDir = (chatId) => path.join(base, 'work', chatId);

/** A folder sitting in `ready/`, named the way the tick names one. */
function plantReady({ owner, repo, branch } = TARGET, marker = 'slot') {
  const name = `${owner}__${repo}__${branch}__${crypto.randomUUID()}`;
  const dir = path.join(readyDir(), name);
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'WHICH'), marker);
  return { name, dir };
}

test('a waiting checkout is claimed into the chat folder', async () => {
  const slot = plantReady(TARGET, 'the-one');
  const dest = workDir('chat-a');

  assert.equal(await claim(dest), true);

  assert.equal(fs.readFileSync(path.join(dest, 'WHICH'), 'utf8'), 'the-one');
  assert.ok(!fs.existsSync(slot.dir), 'the slot must leave ready/ — a claimed folder is no longer available');
});

test('an empty queue refuses rather than inventing something', async () => {
  // The caller's fallback is a normal clone, so "false" has to mean exactly
  // "there was nothing", never "something went wrong and here is a broken dir".
  assert.equal(await claim(workDir('chat-b')), false);
  assert.ok(!fs.existsSync(workDir('chat-b')));
});

test('a checkout of a different repo is never handed out', async () => {
  plantReady({ owner: 'acme', repo: 'other', branch: 'main' }, 'wrong-repo');
  plantReady({ owner: 'acme', repo: 'notes', branch: 'dev' }, 'wrong-branch');

  assert.equal(await claim(workDir('chat-c')), false,
    'repo and branch are both part of a slot\'s identity');
  assert.ok(!fs.existsSync(workDir('chat-c')));
});

test('an unfinished clone in setup/ is invisible to a claim', async () => {
  // This is the property the whole layout exists for: a half-cloned folder must
  // be unreachable, not merely undesirable. Being in ready/ IS being ready.
  const name = `${TARGET.owner}__${TARGET.repo}__${TARGET.branch}__${crypto.randomUUID()}`;
  fs.mkdirSync(path.join(setupDir(), name), { recursive: true });

  assert.equal(await claim(workDir('chat-d')), false);
});

test('two chats claiming at once get different folders, never the same one', async () => {
  // The rename is what makes this safe with no lock: one wins, the other gets
  // ENOENT and moves on. If this ever fails, two agents are sharing a checkout.
  plantReady(TARGET, 'first');
  plantReady(TARGET, 'second');

  const [a, b] = await Promise.all([
    claim(workDir('race-a')),
    claim(workDir('race-b')),
  ]);

  assert.deepEqual([a, b], [true, true], 'two slots were available, so both should be served');
  const which = [
    fs.readFileSync(path.join(workDir('race-a'), 'WHICH'), 'utf8'),
    fs.readFileSync(path.join(workDir('race-b'), 'WHICH'), 'utf8'),
  ];
  assert.notEqual(which[0], which[1], 'the same slot was handed to both chats');
  // Both matching slots left the queue. Counted by prefix, not by total: the
  // wrong-repo slots planted earlier are still sitting there on purpose.
  const stillOurs = fs.readdirSync(readyDir())
    .filter((n) => n.startsWith(`${TARGET.owner}__${TARGET.repo}__${TARGET.branch}__`));
  assert.deepEqual(stillOurs, []);
});

test('more chats than slots: the loser is told no, not given a duplicate', async () => {
  plantReady(TARGET, 'only');

  const results = await Promise.all([
    claim(workDir('greedy-a')),
    claim(workDir('greedy-b')),
    claim(workDir('greedy-c')),
  ]);

  assert.equal(results.filter(Boolean).length, 1, 'one slot can only serve one chat');
});
