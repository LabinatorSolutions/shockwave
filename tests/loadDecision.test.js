import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideLoad } from '../src/renderer/loadDecision.ts';

// Shorthand: the common case is "tab t1 is showing file A, and the editor agrees".
const showing = (path, tabId = 't1', isDark = false) => ({
  lastLoad: { tabId, path, isDark },
  activeTabId: tabId,
  activeFile: path,
  isDark,
  promoted: null,
  currentDocKey: path,
  draftKey: `draft:${tabId}`,
});

test('content already on screen — no disk read', () => {
  assert.deepEqual(decideLoad(showing('/w/A.md')), { rekeyDraftTo: null, read: false });
});

test('switching to another file reads it', () => {
  const d = decideLoad({ ...showing('/w/A.md'), activeFile: '/w/B.md' });
  assert.equal(d.read, true);
});

test('a draft that was just saved keeps its buffer — no read, history re-keyed', () => {
  // The draft in t1 became /w/Untitled.md; the tab now points at it and the editor is
  // still holding the draft. What is on screen IS that file's content.
  const d = decideLoad({
    lastLoad: { tabId: 't1', path: null, isDark: false },
    activeTabId: 't1',
    activeFile: '/w/Untitled.md',
    isDark: false,
    promoted: { tabId: 't1', path: '/w/Untitled.md' },
    currentDocKey: 'draft:t1',
    draftKey: 'draft:t1',
  });
  assert.deepEqual(d, { rekeyDraftTo: '/w/Untitled.md', read: false });
});

// THE BUG: an empty new file, then a click on a real file in the tree. The click reuses
// the draft's tab, so its path goes null -> /w/Real.md exactly as a save would. Nothing
// was saved (an untouched draft is never written), so there is no `promoted` record and
// the file must be read. Before the fix this skipped the read and showed the empty draft
// buffer as /w/Real.md — and the next keystroke saved that emptiness over the file.
test('draft tab navigating to another file reads that file (untouched draft)', () => {
  const d = decideLoad({
    lastLoad: { tabId: 't1', path: null, isDark: false },
    activeTabId: 't1',
    activeFile: '/w/Real.md',
    isDark: false,
    promoted: null,
    currentDocKey: 'draft:t1',
    draftKey: 'draft:t1',
  });
  assert.equal(d.read, true);
});

// Same click, but the draft HAD been typed into, so it was saved on the way out. React 18
// batches the save and the navigation into one render, so both facts land together: the
// draft became /w/Untitled.md AND the tab now points at /w/Real.md. The buffer belongs to
// Untitled, so Real must still be read — and Untitled keeps its undo history.
test('draft saved and navigated away in one render: reads the new file, keeps history', () => {
  const d = decideLoad({
    lastLoad: { tabId: 't1', path: null, isDark: false },
    activeTabId: 't1',
    activeFile: '/w/Real.md',
    isDark: false,
    promoted: { tabId: 't1', path: '/w/Untitled.md' },
    currentDocKey: 'draft:t1',
    draftKey: 'draft:t1',
  });
  assert.deepEqual(d, { rekeyDraftTo: '/w/Untitled.md', read: true });
});

// A rebuilt editor holds nothing, whatever the bookkeeping says. This is graph view (which
// unmounts the editor) and the theme toggle (which recreates the view): the active file
// never changes, so only the editor's own answer can reveal that the buffer is gone.
test('rebuilt editor reads from disk even though the record says it is loaded', () => {
  const d = decideLoad({ ...showing('/w/A.md'), currentDocKey: null });
  assert.equal(d.read, true);
});

test('editor holding some other document reads from disk', () => {
  const d = decideLoad({ ...showing('/w/A.md'), currentDocKey: '/w/Other.md' });
  assert.equal(d.read, true);
});

test('theme change reloads', () => {
  const d = decideLoad({ ...showing('/w/A.md'), isDark: true });
  assert.equal(d.read, true);
});

test('two tabs on one file: switching between them reloads for the new tab', () => {
  const d = decideLoad({ ...showing('/w/A.md'), activeTabId: 't2', draftKey: 'draft:t2' });
  assert.equal(d.read, true);
});

// A promotion belonging to a different tab must not license skipping this one's read —
// e.g. a background flush saved another tab's draft while we switched here.
test('a promotion from another tab is ignored', () => {
  const d = decideLoad({
    lastLoad: { tabId: 't1', path: null, isDark: false },
    activeTabId: 't1',
    activeFile: '/w/Real.md',
    isDark: false,
    promoted: { tabId: 't2', path: '/w/Real.md' },
    currentDocKey: 'draft:t1',
    draftKey: 'draft:t1',
  });
  assert.deepEqual(d, { rekeyDraftTo: null, read: true });
});

// The editor was rebuilt in the same render the draft was saved (theme toggled while a
// new file was pending). The view is empty, so the buffer is NOT authoritative and the
// just-saved file has to be read back off disk.
test('promotion into a rebuilt editor still reads from disk', () => {
  const d = decideLoad({
    lastLoad: { tabId: 't1', path: null, isDark: false },
    activeTabId: 't1',
    activeFile: '/w/Untitled.md',
    isDark: true,
    promoted: { tabId: 't1', path: '/w/Untitled.md' },
    currentDocKey: null,
    draftKey: 'draft:t1',
  });
  assert.deepEqual(d, { rekeyDraftTo: null, read: true });
});
