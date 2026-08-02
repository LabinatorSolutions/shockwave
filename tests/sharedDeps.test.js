// The two package.json files have to agree about anything they both declare.
//
// Why: `agent-core/` is ONE source tree compiled into TWO artifacts — the
// Electron bundle and the companion's Docker image. Each build resolves its
// dependencies from its own package.json, so the same agent-core source can end
// up running against two different copies of a library. Nothing about that is
// visible at build time; both sides compile clean and ship.
//
// The pi packages are the live case (`@earendil-works/pi-ai`,
// `@earendil-works/pi-coding-agent`), which is why they're pinned exactly rather
// than carets — a caret means the desktop and the companion can float to
// different minors on their own, and then the agent behaves one way in the app
// and another way over Telegram with no diff to explain it.
//
// Written as a RULE, not a list: any package named in both files must match, so
// the next shared dependency is covered the day it's added instead of needing a
// new assertion nobody remembers to write.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => JSON.parse(readFileSync(resolve(here, '..', p), 'utf8'));

const root = read('package.json');
const api = read('api/package.json');

// Runtime and dev deps together: a build tool shared by both processes can skew
// output just as a library can.
const allDeps = (pkg) => ({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) });

const rootDeps = allDeps(root);
const apiDeps = allDeps(api);
const shared = Object.keys(rootDeps).filter((name) => name in apiDeps);

// Packages that are compiled into both artifacts from one source tree, so a
// version skew changes behaviour rather than just the lockfile.
const EXACT_PIN_REQUIRED = ['@earendil-works/pi-ai', '@earendil-works/pi-coding-agent'];

test('the two package.json files actually share dependencies', () => {
  // A guard on the guard: if a refactor moves everything out of one file, the
  // loop below would pass by iterating over nothing and this test would go on
  // reporting green while checking exactly zero packages.
  assert.ok(shared.length > 0, 'expected at least one dependency declared in both package.json files');
});

test('every dependency declared in both files has the same version', () => {
  for (const name of shared) {
    assert.equal(
      apiDeps[name],
      rootDeps[name],
      `${name} is "${rootDeps[name]}" in package.json but "${apiDeps[name]}" in api/package.json — ` +
        'agent-core is built into both, so these must match',
    );
  }
});

test('the pi packages are pinned exactly on both sides', () => {
  // A caret defeats the check above: both files can say "^0.80.5", match here,
  // and still install different versions on two different days.
  for (const name of EXACT_PIN_REQUIRED) {
    for (const [label, deps] of [['package.json', rootDeps], ['api/package.json', apiDeps]]) {
      const range = deps[name];
      assert.ok(range, `${name} is missing from ${label}`);
      assert.match(
        range,
        /^\d+\.\d+\.\d+$/,
        `${name} is "${range}" in ${label} — must be an exact version, not a range`,
      );
    }
  }
});
