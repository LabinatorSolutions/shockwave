import { FILE_ACTIONS } from './constants.js';
import { isOpenable } from './MediaView.js';

interface OpenFileContextMenuOpts {
  // One or more absolute file paths the menu acts on.
  paths: string[];
  getIsBookmarked?: (path: string) => boolean;
  conflictMode?: boolean;
  // Rename is the one action the menu can't complete on its own — it needs a
  // name typed in. The caller puts its own row into edit mode.
  onRename?: () => void;
  onFileAction?: (action: string, paths: string[]) => void;
}

// The file context menu, shared by every list that shows files: the file tree
// and the quick-access panel below it. Everything downstream keys on paths, not
// on a react-arborist node, so both callers dispatch through the same route.
export async function openFileContextMenu({
  paths,
  getIsBookmarked,
  conflictMode = false,
  onRename,
  onFileAction,
}: OpenFileContextMenuOpts) {
  if (!paths || paths.length === 0) return;
  const action = await window.api.showFileContextMenu({
    isMd: paths.every((p) => p.toLowerCase().endsWith('.md')),
    // "Open in new tab" is offered for any file the app can actually open
    // (.md + image/video/drawing), not just markdown.
    isOpenable: paths.every((p) => isOpenable(p)),
    isBookmarked: getIsBookmarked ? paths.every((p) => getIsBookmarked(p)) : false,
    selectionCount: paths.length,
    conflictMode: !!conflictMode,
  });
  if (!action) return;
  if (action === FILE_ACTIONS.RENAME) {
    // Rename is single-only (the menu template hides it when multi).
    onRename?.();
  } else {
    onFileAction?.(action, paths);
  }
}
