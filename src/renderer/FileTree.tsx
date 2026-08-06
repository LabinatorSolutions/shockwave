import React, { createContext, forwardRef, useCallback, useContext, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Tree } from 'react-arborist';
import { useDrop } from 'react-dnd';
import { HTML5Backend, NativeTypes } from 'react-dnd-html5-backend';
import { ChevronDown, ChevronRight, FileText, Folder } from 'lucide-react';
import { openFileContextMenu } from './fileContextMenu.js';
import { SIDEBAR_IMAGE_MIME } from './imagePaste.js';
import { cn } from '@/lib/utils';

// Row visuals shared with TreePanel (same look as the file browser).
export const treeRowClass = (selected: boolean) => cn(
  // Extra left padding so the row fill / selection ring extends a few px past
  // the caret instead of hugging it.
  'flex h-6 cursor-pointer items-center gap-1.5 rounded-md pl-3 pr-2 text-[12.5px] text-foreground/85',
  'hover:bg-accent',
  selected && 'bg-accent',
);

export function TreeFileIcon() {
  return <FileText className="size-3.5 shrink-0 text-muted-2" strokeWidth={1.6} />;
}

export function TreeFolderIcon() {
  return <Folder className="size-[15px] shrink-0 fill-folder stroke-none" />;
}

// react-dnd's HTML5 backend dispatches `hover` from a requestAnimationFrame
// using target ids captured at dragover time. react-arborist re-registers every
// row's drop target whenever it rebuilds its node list — any Tree prop identity
// change, and `tree.open(parentId)` inside its own drop handler — so a queued
// hover can fire with ids that no longer exist and dnd-core throws an uncaught
// "Expected targetIds to be registered" mid-drag (seen when dropping a file
// onto a folder). Wrap the manager so hover only ever sees live ids.
function SafeHTML5Backend(manager: any, context: any, options: any) {
  const registry = manager.getRegistry();
  const actions = manager.getActions();
  const safeManager = {
    getMonitor: () => manager.getMonitor(),
    getRegistry: () => registry,
    getActions: () => ({
      ...actions,
      hover: (targetIds: string[], opts: any) =>
        actions.hover(targetIds.filter((id) => registry.getTarget(id)), opts),
    }),
  };
  return (HTML5Backend as any)(safeManager, context, options);
}

// react-arborist renders the Tree's children render-prop AS A COMPONENT
// (`const Node = tree.renderNode` in its RowContainer). If that function's
// identity changes between renders, React sees a new component type and
// unmounts + remounts every row's subtree — which destroys the rename input
// mid-edit (its useState re-initializes to node.data.name, silently reverting
// what the user typed the next time anything re-renders the app). So the
// render-prop must be THIS stable module-level component; everything it needs
// beyond react-arborist's own row props travels via context.
const NodeExtrasContext = createContext<any>(null);

function NodeWithExtras(props: any) {
  const extras = useContext(NodeExtrasContext);
  return (
    <Node
      {...props}
      {...extras}
      isBookmarked={extras.getIsBookmarked ? extras.getIsBookmarked(props.node.id) : false}
    />
  );
}

const FileTree = forwardRef<any, any>(function FileTree(
  { data, onSelect, onRename, onFileAction, onFolderAction, onOpenInNewTab, onMoveItems, disableDrop, getIsBookmarked, conflictMode, checkRenameConflict, onRootContextMenu, contentSized, onImportFiles },
  ref,
) {
  const wrapRef = useRef<any>(null);
  const treeRef = useRef<any>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  // Visible row count for contentSized mode (folders closed ⇒ only their row
  // counts). Synced from react-arborist's visibleNodes after mount/data/toggle.
  const [visibleCount, setVisibleCount] = useState(() => data?.length ?? 0);
  const syncVisibleCount = useCallback(() => {
    setVisibleCount(treeRef.current?.visibleNodes?.length ?? 0);
  }, []);

  useEffect(() => {
    if (!wrapRef.current) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize({ width, height });
    });
    ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (contentSized) syncVisibleCount();
  }, [contentSized, data, size.width, syncVisibleCount]);

  // Per-app row props, delivered to NodeWithExtras via context so updates
  // re-render rows without remounting them (see NodeExtrasContext above).
  const nodeExtras = useMemo(
    () => ({ onFileAction, onFolderAction, onOpenInNewTab, onImportFiles, getIsBookmarked, conflictMode, checkRenameConflict }),
    [onFileAction, onFolderAction, onOpenInNewTab, onImportFiles, getIsBookmarked, conflictMode, checkRenameConflict],
  );

  // Stable Tree callbacks: any prop identity change makes react-arborist run
  // api.update → rebuild its whole NodeApi list (and mid-drag, re-register
  // every drop target — see SafeHTML5Backend). Inline arrows here would do
  // that on every render.
  const contentSizedRef = useRef(contentSized);
  contentSizedRef.current = contentSized;
  const syncVisibleCountRef = useRef(syncVisibleCount);
  syncVisibleCountRef.current = syncVisibleCount;
  const onMoveItemsRef = useRef(onMoveItems);
  onMoveItemsRef.current = onMoveItems;
  const handleToggle = useCallback(() => {
    if (contentSizedRef.current) setTimeout(() => syncVisibleCountRef.current(), 0);
  }, []);
  const handleMove = useCallback(({ dragIds, parentId }: any) => {
    onMoveItemsRef.current?.(dragIds, parentId);
  }, []);

  useImperativeHandle(ref, () => ({
    // Put a node into rename-edit mode. Retries briefly because the node may not be
    // present in the Tree's internal model yet (data prop just updated).
    editNode(id) {
      const tryEdit = (attempt = 0) => {
        const tree = treeRef.current;
        if (tree && tree.get?.(id)) {
          tree.edit(id);
          return;
        }
        if (attempt < 10) requestAnimationFrame(() => tryEdit(attempt + 1));
      };
      tryEdit();
    },
    // Collapse every folder in the tree.
    closeAll() {
      treeRef.current?.closeAll?.();
    },
  }), []);

  return (
    <div
      ref={wrapRef}
      className="tree-fill h-full w-full"
      // contentSized: the tree is as tall as its visible rows and the parent
      // (tree-wrap) owns the scroll, so anything below it (the quick-access
      // panel) sits directly beneath the last row and scrolls as one. Used in
      // bookmark mode and whenever the panel is shown. Otherwise the tree fills
      // its container and scrolls internally (ResizeObserver-driven height).
      style={contentSized ? { height: visibleCount * 24, flex: '0 0 auto' } : undefined}
      onContextMenu={(e) => {
        // Row Nodes stopPropagation on their own onContextMenu, so this only
        // fires on empty space below/around the tree rows.
        if (!onRootContextMenu) return;
        e.preventDefault();
        onRootContextMenu();
      }}
    >
      {size.width > 0 && (
        <NodeExtrasContext.Provider value={nodeExtras}>
          <Tree
            ref={treeRef}
            data={data}
            openByDefault={false}
            // Confine react-arborist's react-dnd backend to the tree element so
            // it stops owning window-wide drag events (the editor/chat handle
            // their own native drops). wrapRef is mounted before size>0 gates the
            // Tree in, so it's non-null here.
            dndRootElement={wrapRef.current}
            dndBackend={SafeHTML5Backend}
            width={size.width}
            height={contentSized ? visibleCount * 24 : size.height}
            indent={16}
            rowHeight={24}
            onSelect={onSelect}
            onRename={onRename}
            onToggle={handleToggle}
            onMove={handleMove}
            disableDrop={disableDrop}
          >
            {NodeWithExtras}
          </Tree>
        </NodeExtrasContext.Provider>
      )}
    </div>
  );
});

export default FileTree;

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|bmp)$/i;

// Rename input, shared by the tree rows and the quick-access panel below them —
// renaming always happens in the row the user clicked, so this is deliberately
// free of any react-arborist node. Files show the FULL literal name (incl.
// extension) — no `.md` hiding. Live collision check turns the field red (like
// the title bar) and blocks Enter; blur/Escape revert.
export function RenameInput({ initialValue, checkConflict, onSubmit, onCancel }: any) {
  const [val, setVal] = useState(initialValue);
  const conflict = checkConflict ? !!checkConflict(val) : false;
  return (
    <input
      autoFocus
      className={cn(
        'h-5 w-full min-w-0 rounded-sm border border-input bg-background px-1 text-[12.5px] outline-none focus:border-ring',
        conflict && 'border-destructive focus:border-destructive',
      )}
      value={val}
      onChange={(e) => setVal(e.target.value)}
      onBlur={() => onCancel()}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onCancel();
        if (e.key === 'Enter') {
          if (conflict) onCancel();
          else onSubmit(e.currentTarget.value);
        }
      }}
    />
  );
}

function Node({ node, tree, style, dragHandle, onFileAction, onFolderAction, onOpenInNewTab, onImportFiles, getIsBookmarked, isBookmarked, conflictMode, checkRenameConflict }: any) {
  const isFolder = node.isInternal;
  const isImage = !isFolder && IMAGE_EXT_RE.test(node.data.name);
  const willReceiveDrop = isFolder && node.willReceiveDrop;

  // Accept OS file drags (Finder etc.) via react-dnd's NativeTypes.FILE —
  // rows render inside react-arborist's DndProvider, so this shares its
  // HTML5 backend. Folder rows import into the folder; file rows into their
  // parent folder. Copy semantics; App owns the actual import.
  const importDir = isFolder ? node.id : node.id.slice(0, node.id.lastIndexOf('/'));
  const [{ isFileOver }, fileDropRef] = useDrop(() => ({
    accept: [NativeTypes.FILE],
    canDrop: () => !!onImportFiles,
    drop: (item: any) => { onImportFiles?.(importDir, item.files); },
    collect: (m) => ({ isFileOver: m.isOver() && m.canDrop() }),
  }), [onImportFiles, importDir]);

  const handleDragStart = (e) => {
    if (!isImage) return;
    // Native dataTransfer payload, read back by the editor/chat drop handler.
    e.dataTransfer.setData(SIDEBAR_IMAGE_MIME, node.id);
    e.dataTransfer.effectAllowed = 'copy';

    // Custom drag image — a small chip with the filename. Browser snapshots
    // the element at this moment, so we add off-screen, snapshot, then
    // remove on the next frame.
    const ghost = document.createElement('div');
    ghost.className = 'image-drag-ghost';
    ghost.textContent = node.data.name;
    document.body.appendChild(ghost);
    e.dataTransfer.setDragImage(ghost, 8, 8);
    requestAnimationFrame(() => ghost.remove());

    // Stop react-arborist's react-dnd drag source (for image rows we want a
    // drag-to-embed, not a tree reorder) so it doesn't override our drag image
    // with getEmptyImage().
    e.stopPropagation();
  };

  const handleContextMenu = async (e) => {
    e.preventDefault();
    e.stopPropagation();

    if (isFolder) {
      // Conflict view is review-only — folders are just grouping, no actions.
      if (conflictMode) return;
      // Folder context menus stay single-selection — mixed folder/file
      // multi-select adds more UX confusion than it's worth here.
      const action = await window.api.showFolderContextMenu();
      if (!action) return;
      if (onFolderAction) onFolderAction(action, node.id);
      return;
    }

    // File context. Finder semantics: if the right-clicked row is part of an
    // existing multi-selection, the action operates on the whole selection.
    // Otherwise the selection collapses to just this row.
    const selectedIds = tree?.selectedIds ?? new Set();
    let targetPaths;
    if (selectedIds.has(node.id) && selectedIds.size > 1) {
      // Drop folders from the multi-selection — bulk file ops only act on files.
      targetPaths = [];
      for (const id of selectedIds) {
        const n = tree.get(id);
        if (n && !n.isInternal) targetPaths.push(id);
      }
      if (targetPaths.length === 0) targetPaths = [node.id];
    } else {
      // Deliberately do NOT select the row: selecting fires the tree's onSelect,
      // which opens/loads the file. A right-click should only show the menu —
      // the menu targets node.id directly, so no selection is needed.
      targetPaths = [node.id];
    }

    await openFileContextMenu({
      paths: targetPaths,
      getIsBookmarked: getIsBookmarked ?? (() => !!isBookmarked),
      conflictMode,
      onRename: () => node.edit(),
      onFileAction,
    });
  };

  return (
    <div
      ref={(el) => { dragHandle?.(el); fileDropRef(el); }}
      // react-arborist supplies the nesting indent as an inline paddingLeft,
      // which beats the class padding — fold the row's own 12px inset into it.
      style={{ ...style, paddingLeft: `${(parseFloat(style?.paddingLeft) || 0) + 12}px` }}
      className={cn(
        // Selected folders and files share the same quiet gray fill.
        treeRowClass(node.isSelected),
        (willReceiveDrop || isFileOver) && 'bg-selected',
      )}
      onClick={(e) => {
        // react-arborist's default Row wrapper around this Node also binds
        // onClick={node.handleClick}. If we don't stop propagation, the click
        // bubbles up and handleClick runs TWICE — for a Cmd+click that means
        // the second call sees isSelected=true (we just added it) and
        // immediately deselects, undoing the multi-select. So we stop the
        // event here and own the click logic ourselves.
        e.stopPropagation();
        // Delegate to react-arborist's modifier-aware handler so Cmd+click
        // toggles a multi-selection and Shift+click extends a range.
        node.handleClick(e);
        // Folder expand-collapse only on a plain click — if the user is
        // Cmd/Shift-clicking to build a selection, leave folder state alone.
        if (isFolder && !e.metaKey && !e.shiftKey && !e.ctrlKey && !e.altKey) {
          node.toggle();
        }
      }}
      // Middle-click opens the file in a new tab. It is the only modifier-free
      // gesture available here: react-arborist's handleClick (above) already owns
      // Cmd/Ctrl+click for multi-select and Shift+click for range-select, so
      // neither can carry a second meaning — VS Code's explorer has the same
      // collision and resolves it the same way, keeping Cmd for selection.
      onAuxClick={(e) => {
        if (e.button !== 1 || isFolder || !onOpenInNewTab) return;
        e.preventDefault();
        e.stopPropagation();
        onOpenInNewTab(node.id);
      }}
      // Chromium starts its autoscroll on middle mousedown; without this the row
      // sprouts a scroll cursor before auxclick ever fires.
      onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }}
      onDoubleClick={() => !isFolder && node.edit()}
      onContextMenu={handleContextMenu}
      onDragStart={handleDragStart}
    >
      <span className="flex w-[13px] shrink-0 items-center">
        {isFolder && (node.isOpen
          ? <ChevronDown className="size-[11px] text-muted-2" strokeWidth={2.4} />
          : <ChevronRight className="size-[11px] text-muted-2" strokeWidth={2.4} />)}
      </span>
      {isFolder ? <TreeFolderIcon /> : <TreeFileIcon />}
      {node.isEditing ? (
        <RenameInput
          initialValue={node.data.name}
          checkConflict={(v) => !isFolder && checkRenameConflict && checkRenameConflict(v, node.id)}
          onSubmit={(v) => node.submit(v)}
          onCancel={() => node.reset()}
        />
      ) : (
        <span className={cn('truncate', isFolder && 'font-medium')}>{node.data.name}</span>
      )}
    </div>
  );
}
