// Enforces the one rule that keeps credentials off the screen: an IPC handler may
// only return the STRIPPED settings read.
//
// `readSettings` and `readSettingsSafe` carry live credentials — provider keys,
// your GitHub token, agent tokens. They exist for main's own use (running the
// agent, pushing to git, minting the voice token). `readSettingsForRenderer` is the
// one that strips them.
//
// Nothing in the language stops a future handler returning the wrong one, and the
// leak would be silent — the app would work perfectly while handing every key to
// the renderer. A comment saying "use the right one" is exactly the kind of
// unenforced policy that let `cb(0)` ("trust any certificate") survive in this
// codebase for as long as it did. So it's checked mechanically.
//
// This is a source scan, not a runtime test. It's coarse, and that's the trade:
// it can't be fooled by a refactor and needs no Electron.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const MAIN = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8');

/** Every `ipcMain.handle('name', …)` body, crudely bounded by the next handler. */
function handlers(src) {
  const out = [];
  const re = /ipcMain\.handle\(\s*'([^']+)'/g;
  let m;
  const starts = [];
  while ((m = re.exec(src))) starts.push({ name: m[1], at: m.index });
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i].at;
    const to = i + 1 < starts.length ? starts[i + 1].at : src.length;
    out.push({ name: starts[i].name, body: src.slice(from, to) });
  }
  return out;
}

test('main.ts has IPC handlers to scan (the scan itself still works)', () => {
  // Guards against the regex silently matching nothing after a refactor, which
  // would make every assertion below vacuously pass.
  const found = handlers(MAIN);
  assert.ok(found.length > 30, `expected many handlers, found ${found.length}`);
  assert.ok(found.some((h) => h.name === 'settings:read'), 'settings:read must be present');
});

test('settings:read returns the stripped read', () => {
  const h = handlers(MAIN).find((x) => x.name === 'settings:read');
  assert.match(h.body, /readSettingsForRenderer\(\)/);
  assert.doesNotMatch(h.body, /readSettingsSafe\(\)/);
  assert.doesNotMatch(h.body, /await readSettings\(\)/);
});

test('no handler RETURNS a settings object that still carries credentials', () => {
  // The unstripped reads may be CALLED in a handler — sync needs the PAT, voice
  // needs the AssemblyAI key — they just must not be handed back wholesale. So the
  // check is on returning `settings`, not on reading it.
  const offenders = [];
  for (const h of handlers(MAIN)) {
    const usesRaw = /await readSettings\(\)/.test(h.body) || /readSettingsSafe\(\)/.test(h.body);
    if (!usesRaw) continue;
    // `return settings` / `return { settings }` / `return {...settings}` — any
    // shape that hands the object itself to the renderer.
    if (/return\s+settings\b/.test(h.body)
      || /return\s*\{\s*settings\b/.test(h.body)
      || /return\s*\{\s*\.\.\.settings\b/.test(h.body)) {
      offenders.push(h.name);
    }
  }
  assert.deepEqual(
    offenders, [],
    `these handlers return unstripped settings to the renderer: ${offenders.join(', ')}`,
  );
});

test('the push to the renderer strips too', () => {
  // `settings:changed` is the second door. It sends a full settings object, so it
  // has to strip as well — main-initiated writes (an OAuth refresh) reach the
  // renderer through here, not through settings:read.
  const store = readFileSync(new URL('../src/main/settingsStore.ts', import.meta.url), 'utf8');
  const emit = store.slice(store.indexOf('async function emitChanged'));
  const body = emit.slice(0, emit.indexOf('\n}\n'));
  assert.match(body, /stripCredentials\(/, 'settings:changed must strip credentials');
});
