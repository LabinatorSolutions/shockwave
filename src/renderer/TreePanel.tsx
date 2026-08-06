import React from 'react';
import type { TreeNode } from '../shared/api';
import { treeRowClass, TreeFileIcon, RenameInput } from './FileTree.jsx';

interface TreePanelProps {
  title: string;
  items: TreeNode[];
  activePath: string | null;
  onOpen: (path: string) => void;
  // Middle-click. Same gesture as the tree above — see the row's onAuxClick there.
  onOpenInNewTab?: (path: string) => void;
  onContextMenu?: (path: string) => void;
  // Rename happens in place, in the row that was right-clicked (same as the
  // tree above) — App owns which row is editing.
  renamingPath?: string | null;
  checkRenameConflict?: (name: string, path: string) => boolean;
  onRenameSubmit?: (path: string, name: string) => void;
  onRenameCancel?: () => void;
}

// One section of the quick-access panel pinned below the file tree ("Recent
// Files" / "Daily Notes", per the Appearance → treePanel setting). Rendered as
// plain file rows (the same row look as the file browser above it) so
// navigating feels identical — just preceded by a section header. Items are
// pre-filtered, pre-sorted (modified desc), and pre-capped in App; this
// component is presentation only. Rows are real files (the same TreeNodes the
// tree renders), so right-click gets the same menu and the same actions.
export default function TreePanel({
  title,
  items,
  activePath,
  onOpen,
  onOpenInNewTab,
  onContextMenu,
  renamingPath,
  checkRenameConflict,
  onRenameSubmit,
  onRenameCancel,
}: TreePanelProps) {
  if (items.length === 0) return null;
  return (
    <div>
      <div className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-[0.09em] text-muted-2">{title}</div>
      {items.map((it) => {
        const editing = renamingPath === it.id;
        return (
          <div
            key={it.id}
            className={treeRowClass(it.id === activePath)}
            title={it.id}
            onClick={() => { if (!editing) onOpen(it.id); }}
            onAuxClick={(e) => {
              if (e.button !== 1 || editing || !onOpenInNewTab) return;
              e.preventDefault();
              onOpenInNewTab(it.id);
            }}
            onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }}
            onContextMenu={(e) => {
              if (!onContextMenu) return;
              e.preventDefault();
              e.stopPropagation();
              onContextMenu(it.id);
            }}
          >
            <span className="flex w-[13px] shrink-0 items-center" />
            <TreeFileIcon />
            {editing ? (
              <RenameInput
                initialValue={it.name}
                checkConflict={(v) => checkRenameConflict && checkRenameConflict(v, it.id)}
                onSubmit={(v) => onRenameSubmit?.(it.id, v)}
                onCancel={() => onRenameCancel?.()}
              />
            ) : (
              <span className="truncate">{it.name}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}
