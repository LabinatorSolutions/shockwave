// CLAUDE.md spells this out: the parser has two copies, one in the renderer
// (src/linkIndex.ts) and one in main (electron/linkParser.ts). They MUST stay
// in lockstep — the watcher uses the main copy, the in-memory index uses the
// renderer copy, and any drift causes silent corruption.
//
// This test runs both parsers against the same inputs and asserts equality.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLinks as rendererParse, normalizeTarget as rendererNorm } from '../src/renderer/linkIndex.ts';
import { parseLinks as mainParse, normalizeTarget as mainNorm } from '../src/main/linkParser.ts';

const FIXTURES = [
  '',
  'no links here\n',
  '[[Simple]]\n',
  '[[Alpha]] inline with [[Beta]] on one line\n',
  '[[Foo#Heading]]\n',
  '[[Foo|Alias]]\n',
  '[[Foo#H|Display]]\n',
  'leading text [[Foo]] trailing\n',
  '  [[Indented]]\n    [[deeper]]\n',
  '[[ws/path/in-target]]\n',         // path-like target — parsed as literal
  '[[FOO]]\n[[foo]]\n[[Foo]]\n',     // case variants
  'multi\nline\n[[X]]\n  context after\n  more context\n\nblank above',
  '[[Trailing space ]] and [[ Leading space]]\n',
  '[[]] empty body should not match\n',
  '[ not a link \n[[real]]\n',
  'para [[X]]\n- bullet a\n- bullet b\n',           // same-indent bullets under a paragraph
  'para [[X]]\n\n- bullet after blank\n',            // blank kills the bullet run
  '- [[X]]\n- sibling\n\t- child\n',                 // bullet link line: siblings + children both in
  'para [[X]]\n1. ordered\n2) also ordered\n',       // ordered markers
  'para [[X]]\n- a\n\n- b after blank\n',            // blank mid-list ends context
  '\\[\\[escaped]] should still match the regex (we don\'t process escapes)\n',
];

for (let i = 0; i < FIXTURES.length; i++) {
  const f = FIXTURES[i];
  test(`parser parity fixture #${i}: ${JSON.stringify(f.slice(0, 60))}`, () => {
    const r = rendererParse(f);
    const m = mainParse(f);
    assert.deepEqual(r, m, `Parser output differs for fixture: ${JSON.stringify(f)}`);
  });
}

test('normalizeTarget parity', () => {
  const inputs = ['Foo', 'Foo.md', 'Foo#H', 'Foo|A', '  Foo  ', 'FOO.MD', 'path/Foo'];
  for (const i of inputs) {
    assert.equal(rendererNorm(i), mainNorm(i), `mismatch for "${i}"`);
  }
});
