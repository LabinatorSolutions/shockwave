// A background run may never examine another background run.
//
// A review run makes tool calls and holds a conversation like any other chat.
// Left eligible it crosses its own threshold, reviews itself, and the review of
// that review does the same — one unattended model run every tick, each landing
// a commit, until somebody notices. Memory is the same shape, and the two
// cross-contaminate: a memory run's messages must not make it due for review
// either. So ONE list covers BOTH sweeps.
//
// Why this needs a test rather than a comment: the rule lives in SQL, and
// `api/src/store.ts` is not importable here (it pulls in drizzle + pg, and this
// suite runs with no install). The two due-queries are also deliberate
// near-copies of each other — `chatsDueForMemory` says so in its own docstring —
// so the exclusion is exactly the kind of line that survives in one and is lost
// from the other during an edit, with nothing failing until a server has been
// reviewing its own reviews for a week.
//
// Read as source for that reason. What is asserted is the RULE — every sweep
// query filters on the shared fragment, and the fragment is built from the
// shared list — never the specific SQL text, so a rewritten query still passes
// as long as it keeps the guard.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { CHAT_SOURCES } from '../src/renderer/constants.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const storeSrc = readFileSync(join(root, 'api', 'src', 'store.ts'), 'utf8');

/** The body of a top-level `export async function <name>(` … up to the next one. */
function functionBody(src, name) {
  const start = src.indexOf(`export async function ${name}(`);
  assert.notEqual(start, -1, `${name} is gone from store.ts — this test needs updating with it`);
  const next = src.indexOf('\nexport ', start + 1);
  return src.slice(start, next === -1 ? src.length : next);
}

/** The sources a background run produces, as declared in store.ts. */
function backgroundSources() {
  const m = storeSrc.match(/export const BACKGROUND_SOURCES = \[([^\]]*)\]/);
  assert.ok(m, 'BACKGROUND_SOURCES is gone from store.ts — the one declaration of what a background chat is');
  return [...m[1].matchAll(/'([a-z]+)'/g)].map((x) => x[1]);
}

test('BACKGROUND_SOURCES names every kind of chat a background run creates', () => {
  // `backgroundRun.ts` is where the kinds are defined, one `source:` per kind.
  const runSrc = readFileSync(join(root, 'api', 'src', 'backgroundRun.ts'), 'utf8');
  const kinds = [...runSrc.matchAll(/^\s+source: '([a-z]+)',$/gm)].map((m) => m[1]);
  assert.ok(kinds.length >= 2, 'expected the background kinds to declare their `source` literals');

  const listed = backgroundSources();
  for (const kind of kinds) {
    assert.ok(
      listed.includes(kind),
      `background kind '${kind}' is missing from BACKGROUND_SOURCES — its runs will come due and examine themselves`,
    );
  }
});

test('every background source is a known chat source', () => {
  // Guards the other direction: a typo'd literal here would exclude nothing and
  // look exactly like a working guard.
  for (const source of backgroundSources()) {
    assert.ok(CHAT_SOURCES.includes(source), `'${source}' is not a chat source the app knows about`);
  }
});

test('both sweep queries exclude background chats', () => {
  for (const fn of ['chatsDueForReview', 'chatsDueForMemory']) {
    const body = functionBody(storeSrc, fn);
    assert.match(
      body,
      /\$\{notBackgroundChat\}/,
      `${fn} does not filter on notBackgroundChat — background runs will pick their own chats`,
    );
  }
});

test('the SQL predicate is built from BACKGROUND_SOURCES, not a second copy of the list', () => {
  const fragment = storeSrc.match(/const notBackgroundChat = sql`[\s\S]*?`;/);
  assert.ok(fragment, 'notBackgroundChat is gone — the shared predicate both sweeps filter on');
  assert.match(
    fragment[0],
    /BACKGROUND_SOURCES/,
    'notBackgroundChat spells its own source list — it must derive from BACKGROUND_SOURCES or the two can disagree',
  );
});

test('the clone refuses a background chat as its source', () => {
  // The choke point: whatever picked the chat — the sweep, a hand-run query, a
  // manual re-run route added later — every background run passes through here.
  const body = functionBody(storeSrc, 'cloneChatForBackground');
  assert.match(
    body,
    /isBackgroundSource\(src\.source\)/,
    'cloneChatForBackground no longer checks the source chat — the SQL is then the only guard, and it only covers the sweep',
  );
  assert.match(body, /throw new Error/, 'the check must refuse the run, not skip it silently');
  assert.match(
    body,
    /source: chatTable\.source/,
    'the clone must select `source` — without it the check reads undefined and passes everything',
  );
});
