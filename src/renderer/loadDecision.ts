/**
 * When does the editor need to read the active file from disk?
 *
 * There is ONE editor view for the whole app and tabs swap documents through it, so before
 * every switch something has to answer: is the content already on screen, or not? Getting
 * that answer wrong in the "already there" direction is the expensive mistake — the editor
 * keeps showing a buffer that doesn't belong to the file the tab now points at, and since
 * the tab still saves to that file, the next keystroke writes the wrong content over it.
 *
 * Two ways it was got wrong, both of which shipped:
 *
 * 1. A draft tab's path going from null to a real path was read as "the draft was just
 *    saved, so the buffer is authoritative." A draft tab ALSO gets a path by navigating
 *    somewhere else — clicking a file in the tree reuses the active tab — and React 18
 *    batches state updates made after an `await`, so a save and a navigation arrive in ONE
 *    render and look identical from the outside. An empty new file followed by a click on
 *    a real file therefore displayed the empty buffer as that file. The caller now records
 *    what the draft actually became (`promoted`) instead of inferring it.
 *
 * 2. "Already loaded" was answered from `lastLoad` alone — a copy of a fact the editor
 *    itself owns. Copies drift: the view is rebuilt on a theme change and destroyed
 *    outright when graph view unmounts the editor, and neither of those changes the active
 *    file, so the record still claimed the content was loaded while the view sat empty.
 *    `currentDocKey` is the editor's own answer and it decides; a rebuilt view says null.
 *
 * Pure so it can be tested without a DOM — the effect in App.tsx supplies the inputs and
 * performs the two actions this returns.
 */

export interface LastLoad {
  tabId: string | null;
  path: string | null;
  isDark: boolean | null;
}

export interface LoadDecisionInput {
  /** What the load effect believes it last put on screen. */
  lastLoad: LastLoad;
  activeTabId: string | null;
  /** The active tab's file. Callers handle drafts (no file) before getting here. */
  activeFile: string;
  isDark: boolean;
  /** What a draft in this tab was just saved as, straight from the code that saved it. */
  promoted: { tabId: string | null; path: string } | null;
  /** Which document the editor is ACTUALLY holding, or null for a view never loaded into. */
  currentDocKey: string | null;
  /** The undo-history key a draft in this tab uses before it has a file. */
  draftKey: string | null;
}

export interface LoadDecision {
  /**
   * Re-key the on-screen draft's undo history to this path, or null for nothing to do.
   * Happens even when the file is then read from disk: the history belongs to the file the
   * draft became either way, and leaving it under the draft key loses it the moment
   * anything looks it up again.
   */
  rekeyDraftTo: string | null;
  /** Read `activeFile` from disk and show it. */
  read: boolean;
}

export function decideLoad({
  lastLoad,
  activeTabId,
  activeFile,
  isDark,
  promoted,
  currentDocKey,
  draftKey,
}: LoadDecisionInput): LoadDecision {
  // Did the draft in THIS tab just become a file, and is that draft still what's on screen?
  const justPromoted = !!promoted
    && promoted.tabId === activeTabId
    && !!draftKey
    && currentDocKey === draftKey;

  const rekeyDraftTo = justPromoted ? promoted!.path : null;

  // Skip the read only when the file now showing IS the one the draft became. Anything
  // else — including the tab navigating elsewhere in the same render — is a different
  // document and has to come off disk.
  if (justPromoted && promoted!.path === activeFile) {
    return { rekeyDraftTo, read: false };
  }

  const alreadyLoaded = lastLoad.tabId === activeTabId
    && lastLoad.path === activeFile
    && lastLoad.isDark === isDark
    // The editor has to agree. Its answer is the original; lastLoad is the copy.
    && currentDocKey === activeFile;

  return { rekeyDraftTo, read: !alreadyLoaded };
}
