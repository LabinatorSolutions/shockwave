import { useCallback, useRef, useState } from 'react';

let nextTabId = 1;
const makeTabId = () => `t${nextTabId++}`;

/**
 * One tab per file: every open goes through this first, and if the path is
 * already showing somewhere we switch to that tab instead of making a second one.
 *
 * It isn't only convention (VS Code, Sublime and IntelliJ all activate the
 * existing tab; a file is duplicated only across SPLIT PANES, which this app has
 * none of). The editor parks view state and undo history keyed by DOCUMENT PATH,
 * not by tab — see "Per-document undo history" in Editor.tsx — so two tabs on one
 * file already share their cursor, scroll and undo stack. A duplicate tab can
 * therefore hold nothing the original doesn't; it is strictly a worse copy.
 *
 * Matches a tab's CURRENT path only. A file sitting in some tab's back-history
 * isn't open, and stealing focus to it would make back/forward unusable.
 */
const tabForPath = (tabs, filePath) => tabs.find((t) => t.path === filePath) ?? null;

/**
 * Owns: tabs, activeTabId, viewStateByPath, and per-tab navigation history.
 *
 * Tab shape: { id, path, isDraft, history: string[], historyIndex: number }.
 * `history`/`historyIndex` model browser-style back/forward inside a single tab.
 * Drafts have history: [] / historyIndex: -1; back/forward are disabled.
 *
 * Does NOT load content into the editor — that's done by App via an effect that watches
 * activeFile and writes via the editor's imperative `loadDocument` API. This keeps the
 * load timing decoupled from React state-update ordering.
 *
 * Every place that forgets a path here must forget it in the editor too: the editor
 * parks one EditorState (and therefore one undo history) per document path. See
 * "Per-document undo history" in Editor.tsx.
 *
 * Inputs:
 *   editorRef         — ref to the imperative Editor (for capturing current view state on leave)
 *   writeNow          — flushes any pending debounced save
 *   onAfterSwitch?    — optional, fires after any tab op completes (e.g., turn off graph mode)
 */
export function useTabs({ editorRef, writeNow, onAfterSwitch }: any): any {
  const [tabs, setTabs] = useState<any[]>([]);
  const [activeTabId, setActiveTabId] = useState<any>(null);
  const viewStateByPath = useRef(new Map());

  const activeTab = tabs.find((t) => t.id === activeTabId) || null;
  const activeFile = activeTab?.path ?? null;
  const activeIsDraft = !!activeTab?.isDraft;
  const canGoBack = !!activeTab && activeTab.historyIndex > 0;
  const canGoForward = !!activeTab && activeTab.historyIndex < activeTab.history.length - 1;

  // Capture the editor's view state for the currently-active file BEFORE we change tabs.
  const captureCurrentViewState = useCallback(() => {
    if (!activeFile) return;
    const editor = editorRef.current;
    if (!editor) return;
    const state = editor.getViewState();
    if (state) viewStateByPath.current.set(activeFile, state);
  }, [activeFile, editorRef]);

  const renameTabsPath = useCallback((oldPath, newPath) => {
    setTabs((prev) => prev.map((t) => {
      const touchesPath = t.path === oldPath;
      const touchesHistory = t.history.includes(oldPath);
      if (!touchesPath && !touchesHistory) return t;
      return {
        ...t,
        path: touchesPath ? newPath : t.path,
        isDraft: touchesPath ? false : t.isDraft,
        history: touchesHistory ? t.history.map((p) => (p === oldPath ? newPath : p)) : t.history,
      };
    }));
    const vs = viewStateByPath.current.get(oldPath);
    if (vs !== undefined) {
      viewStateByPath.current.set(newPath, vs);
      viewStateByPath.current.delete(oldPath);
    }
    // The editor keys undo history by path too — re-key it so a rename doesn't
    // silently drop the file's history.
    editorRef.current?.renameDocument?.(oldPath, newPath);
  }, [editorRef]);

  const openInActiveTab = useCallback(async (filePath) => {
    await writeNow();
    captureCurrentViewState();
    // Minted OUTSIDE the updater: React may invoke an updater twice (StrictMode),
    // and an id minted inside would advance the counter on each pass, so the id
    // setActiveTabId captured wouldn't be the one in the array we returned.
    const freshId = makeTabId();
    setTabs((prev) => {
      const existing = tabForPath(prev, filePath);
      if (existing) {
        setActiveTabId(existing.id);
        return prev;
      }
      if (prev.length === 0) {
        setActiveTabId(freshId);
        return [{ id: freshId, path: filePath, isDraft: false, history: [filePath], historyIndex: 0 }];
      }
      return prev.map((t) => {
        if (t.id !== activeTabId) return t;
        // Truncate forward history, then push (skip if it would duplicate the current entry).
        const truncated = t.history.slice(0, t.historyIndex + 1);
        const top = truncated[truncated.length - 1];
        const nextHistory = top === filePath ? truncated : [...truncated, filePath];
        return {
          ...t,
          path: filePath,
          isDraft: false,
          history: nextHistory,
          historyIndex: nextHistory.length - 1,
        };
      });
    });
    onAfterSwitch?.();
  }, [writeNow, activeTabId, captureCurrentViewState, onAfterSwitch]);

  // Dedups too — see tabForPath. With one editor pane, "open in a new tab" for a
  // file that's already open has no outcome distinct from going to that tab, so
  // that's what it does (as VS Code and IntelliJ do). It never looks like a
  // no-op: you visibly land on the existing tab.
  const openInNewTab = useCallback(async (filePath) => {
    await writeNow();
    captureCurrentViewState();
    const id = makeTabId();
    setTabs((prev) => {
      const existing = tabForPath(prev, filePath);
      if (existing) {
        setActiveTabId(existing.id);
        return prev;
      }
      setActiveTabId(id);
      return [...prev, { id, path: filePath, isDraft: false, history: [filePath], historyIndex: 0 }];
    });
    onAfterSwitch?.();
  }, [writeNow, captureCurrentViewState, onAfterSwitch]);

  const addDraftTab = useCallback(async () => {
    await writeNow();
    captureCurrentViewState();
    const id = makeTabId();
    setTabs((prev) => [...prev, { id, path: null, isDraft: true, history: [], historyIndex: -1 }]);
    setActiveTabId(id);
    onAfterSwitch?.();
  }, [writeNow, captureCurrentViewState, onAfterSwitch]);

  const switchTab = useCallback(async (id) => {
    if (id === activeTabId) return;
    await writeNow();
    captureCurrentViewState();
    setActiveTabId(id);
    onAfterSwitch?.();
  }, [activeTabId, writeNow, captureCurrentViewState, onAfterSwitch]);

  const closeTab = useCallback(async (id) => {
    await writeNow();
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === id);
      const next = prev.filter((t) => t.id !== id);
      if (id === activeTabId) {
        if (next.length === 0) {
          setActiveTabId(null);
        } else {
          const newActive = next[Math.max(0, idx - 1)];
          setActiveTabId(newActive.id);
        }
      }
      return next;
    });
  }, [activeTabId, writeNow]);

  const closeTabsForPath = useCallback((filePath) => {
    setTabs((prev) => {
      const activeWasClosed = prev.find((t) => t.id === activeTabId)?.path === filePath;
      const next: any[] = [];
      for (const t of prev) {
        if (t.path === filePath) continue;
        if (!t.history.includes(filePath)) {
          next.push(t);
          continue;
        }
        // Purge deleted path from this tab's history; shift the index for each removed entry at or before it.
        const nextHistory: any[] = [];
        let nextIndex = t.historyIndex;
        for (let i = 0; i < t.history.length; i++) {
          if (t.history[i] === filePath) {
            if (i <= t.historyIndex) nextIndex--;
          } else {
            nextHistory.push(t.history[i]);
          }
        }
        next.push({
          ...t,
          history: nextHistory,
          historyIndex: Math.max(-1, Math.min(nextIndex, nextHistory.length - 1)),
        });
      }
      if (next.length === prev.length) return prev;
      if (activeWasClosed) {
        setActiveTabId(next.length === 0 ? null : next[0].id);
      }
      return next;
    });
    viewStateByPath.current.delete(filePath);
    editorRef.current?.evictDocument?.(filePath);
  }, [activeTabId, editorRef]);

  // Close every tab whose current path is inside the given folder; purge folder paths from history too.
  const closeTabsUnderPath = useCallback((folderPath) => {
    const prefix = folderPath.endsWith('/') ? folderPath : folderPath + '/';
    const inFolder = (p) => typeof p === 'string' && p.startsWith(prefix);
    setTabs((prev) => {
      const activeTab = prev.find((t) => t.id === activeTabId);
      const activeWasClosed = activeTab && inFolder(activeTab.path);
      const next: any[] = [];
      for (const t of prev) {
        if (inFolder(t.path)) continue;
        const hasFolderInHistory = t.history.some(inFolder);
        if (!hasFolderInHistory) { next.push(t); continue; }
        const nextHistory: any[] = [];
        let nextIndex = t.historyIndex;
        for (let i = 0; i < t.history.length; i++) {
          if (inFolder(t.history[i])) {
            if (i <= t.historyIndex) nextIndex--;
          } else {
            nextHistory.push(t.history[i]);
          }
        }
        next.push({
          ...t,
          history: nextHistory,
          historyIndex: Math.max(-1, Math.min(nextIndex, nextHistory.length - 1)),
        });
      }
      if (next.length === prev.length && !next.some((t, i) => t !== prev[i])) return prev;
      if (activeWasClosed) {
        setActiveTabId(next.length === 0 ? null : next[0].id);
      }
      // Drop view-state entries for all removed paths.
      for (const t of prev) {
        if (inFolder(t.path)) {
          viewStateByPath.current.delete(t.path);
          editorRef.current?.evictDocument?.(t.path);
        }
      }
      return next;
    });
  }, [activeTabId, editorRef]);

  const resetTabs = useCallback(() => {
    setTabs([]);
    setActiveTabId(null);
    viewStateByPath.current.clear();
    // Workspace switch — none of the parked undo histories belong to the new one.
    editorRef.current?.clearDocuments?.();
  }, [editorRef]);

  const goBack = useCallback(async (tabId) => {
    await writeNow();
    captureCurrentViewState();
    setTabs((prev) => prev.map((t) => {
      if (t.id !== tabId || t.historyIndex <= 0) return t;
      const nextIndex = t.historyIndex - 1;
      return { ...t, path: t.history[nextIndex], historyIndex: nextIndex };
    }));
    onAfterSwitch?.();
  }, [writeNow, captureCurrentViewState, onAfterSwitch]);

  const goForward = useCallback(async (tabId) => {
    await writeNow();
    captureCurrentViewState();
    setTabs((prev) => prev.map((t) => {
      if (t.id !== tabId || t.historyIndex >= t.history.length - 1) return t;
      const nextIndex = t.historyIndex + 1;
      return { ...t, path: t.history[nextIndex], historyIndex: nextIndex };
    }));
    onAfterSwitch?.();
  }, [writeNow, captureCurrentViewState, onAfterSwitch]);

  // Reopen a workspace's tabs at load. Caller has already filtered `paths` to
  // files that still exist — a path that vanished since the last run must never
  // become a tab, because a tab with no file behind it can't be loaded and can't
  // be told apart from a draft.
  //
  // Fresh ids rather than stored ones: ids are per-run and mean nothing across
  // launches, and minting here keeps `nextTabId` the only source of them.
  const restoreTabs = useCallback((paths: string[], activePath: string | null) => {
    if (!paths.length) return;
    const restored = paths.map((p) => ({
      id: makeTabId(), path: p, isDraft: false, history: [p], historyIndex: 0,
    }));
    const active = restored.find((t) => t.path === activePath) ?? restored[0];
    setTabs(restored);
    setActiveTabId(active.id);
  }, []);

  // Drag-to-reorder. Moves one tab to another's position and changes NOTHING
  // else — not the active tab, not any tab's path or history. Reordering is
  // presentation; the only index-sensitive behavior in this hook is closeTab's
  // "activate the tab to the left", which reads the array at close time and so
  // follows the new order by itself.
  const reorderTabs = useCallback((fromId, toId) => {
    if (fromId === toId) return;
    setTabs((prev) => {
      const from = prev.findIndex((t) => t.id === fromId);
      const to = prev.findIndex((t) => t.id === toId);
      if (from < 0 || to < 0) return prev;
      const next = prev.slice();
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  }, []);

  // Flip a draft tab to a real file. Caller has already created the file on disk.
  const promoteTabPath = useCallback((tabId, newPath) => {
    setTabs((prev) => prev.map((t) => (
      t.id === tabId
        ? { ...t, path: newPath, isDraft: false, history: [newPath], historyIndex: 0 }
        : t
    )));
  }, []);

  return {
    tabs,
    activeTabId,
    activeTab,
    activeFile,
    activeIsDraft,
    canGoBack,
    canGoForward,
    setActiveTabId,
    setTabs,
    openInActiveTab,
    openInNewTab,
    addDraftTab,
    switchTab,
    closeTab,
    closeTabsForPath,
    closeTabsUnderPath,
    renameTabsPath,
    reorderTabs,
    restoreTabs,
    captureCurrentViewState,
    resetTabs,
    promoteTabPath,
    goBack,
    goForward,
    viewStateByPath,
  };
}
