import React, { useEffect, useMemo, useRef, useState } from 'react';
import fuzzysort from 'fuzzysort';
import { ChevronDown } from 'lucide-react';
import { Command as CommandPrimitive } from 'cmdk';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable';
import { basenameOf, dirOf, toRelPath } from './pathUtils';
import { XIcon, PlusIcon, SearchIcon } from './Icons.jsx';
import { TreeFileIcon } from './FileTree.jsx';
import { segmentsFromIndexes } from './searchHighlight';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { cn } from '@/lib/utils';

// Show the full filename incl. extension (Meeting.md, Notes.txt), matching the
// sidebar. prettyName (which strips .md) stays for wiki-link display only.
function shortLabel(path) {
  if (!path) return 'Untitled';
  return basenameOf(path);
}

// Overflow behavior, the same three moves every tabbed editor makes, in order:
// tabs shrink to a floor, then the strip scrolls, and the open-tab list is
// always one click away. Before this the strip was a plain flex row with no
// overflow rule at all, so tabs past the right edge were clipped by the window
// with no way to reach them — and the "+" button, being the last flex child,
// was pushed off first.
//
// The floor is a min-width on the TAB, not the label: shrinking is proportional,
// so without a floor every tab collapses toward nothing together and you get a
// row of ellipses instead of a few readable names and a scroll.
const TAB_MIN_W = 'min-w-[7rem]';

// Drag-to-reorder runs on **dnd-kit**, which drives drags from ordinary pointer
// events. That is the reason it's here rather than react-dnd, which the file
// tree already pulls in: react-dnd uses the browser's native HTML5 drag, and
// this app has had to defend against that twice already — `SafeHTML5Backend` in
// FileTree.tsx, and the `stopImmediatePropagation` dance in imagePaste.ts that
// stops CodeMirror reading dropped image bytes as text. A third native-drag
// surface a few pixels from the editor would be a fourth chance at that bug.
// dnd-kit shares none of that machinery, so it cannot collide with either.

function SortableTab({
  tab,
  isActive,
  label,
  tooltip,
  activeRef,
  onSwitch,
  onClose,
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: tab.id,
  });

  return (
    <div
      ref={(node) => {
        setNodeRef(node);
        if (isActive) activeRef.current = node;
      }}
      style={{
        // Translate only — deliberately NOT dnd-kit's CSS.Transform helper,
        // which also emits scaleX/scaleY. Tabs are variable width, and scaling
        // one to the width of whatever it's passing stretches its text.
        transform: transform ? `translate3d(${transform.x}px, 0, 0)` : undefined,
        transition,
      }}
      {...attributes}
      {...listeners}
      className={cn(
        'group -mb-px flex cursor-pointer items-center gap-2 rounded-t-lg px-2.5 pb-2 pt-[7px] text-[12.5px]',
        TAB_MIN_W,
        'max-w-44',
        isDragging && 'z-10 opacity-80',
        isActive
          // "Folder tab": top-rounded, attached to the toolbar seam (§5).
          ? 'border border-b-0 border-border bg-background font-medium text-foreground'
          : 'border border-transparent text-muted-foreground hover:bg-accent hover:text-foreground',
      )}
      onClick={() => onSwitch(tab.id)}
      onMouseDown={(e) => {
        // dnd-kit's PointerSensor ignores non-primary buttons, so middle-click
        // close never starts a drag and this stays a plain handler.
        if (e.button === 1) {
          e.preventDefault();
          onClose(tab.id);
        }
      }}
      title={tooltip}
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <button
        className={cn(
          'flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-2',
          'hover:bg-accent hover:text-foreground',
          !isActive && 'opacity-0 group-hover:opacity-100',
        )}
        // The drag listeners live on the tab, so without this a press on the X
        // is a drag handle and the button never gets its click.
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onClose(tab.id);
        }}
        aria-label="Close tab"
      >
        <XIcon size={12} />
      </button>
    </div>
  );
}

export default function TabStrip({
  tabs,
  activeTabId,
  vaultPath,
  activeOverrideLabel,
  onSwitch,
  onClose,
  onAdd,
  onReorder,
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLElement | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [overflowing, setOverflowing] = useState(false);

  const sensors = useSensors(
    // 4px of travel before a drag starts, so a plain click still switches tabs
    // instead of being swallowed as a zero-distance drag.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // Keep the active tab on screen. This is the part that was missing rather
  // than merely absent: the agent's `open_file` tool opens a NEW tab, so once
  // the strip was full every file the agent opened became active off-screen —
  // the editor changed under you and the tab that explains why was invisible.
  //
  // Keyed on activeTabId ALONE. Adding `tabs` looks harmless and would make a
  // drop scroll away to wherever the active tab is, undoing the drag you just
  // watched. Nothing else changes tabs in a way that needs a scroll: a new tab
  // is always activated in the same commit, and draft promotion keeps its id.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeTabId]);

  // Does the strip actually overflow? Drives whether the list button is shown
  // at all. Re-measured whenever the tabs change and whenever the strip is
  // resized — both side panels are drag-resizable, so width moves without the
  // tabs changing at all.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const measure = () => setOverflowing(el.scrollWidth > el.clientWidth + 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [tabs]);

  const labelFor = (tab) => (
    tab.id === activeTabId && activeOverrideLabel ? activeOverrideLabel : shortLabel(tab.path)
  );
  const tooltipFor = (tab) => (
    tab.path ? (toRelPath(tab.path, vaultPath) || basenameOf(tab.path)) : 'New tab'
  );

  // The open-tab list, ranked. Same engine and the same match highlighting as
  // quick search — typing a folder finds a tab the way typing a folder finds a
  // file — so the two pickers behave identically instead of merely looking
  // alike. Rows are searched by workspace-relative path for that reason.
  const rows = useMemo(() => {
    const all = tabs.map((tab) => ({
      tab,
      label: labelFor(tab),
      folder: tab.path ? toRelPath(dirOf(tab.path), vaultPath) : '',
      haystack: tab.path ? (toRelPath(tab.path, vaultPath) || basenameOf(tab.path)) : 'Untitled',
    }));
    const q = query.trim();
    // No query keeps STRIP ORDER, which the user now arranges by dragging. A
    // most-recently-used sort would quietly overrule that arrangement and
    // reshuffle between openings, so position could never be learned.
    if (!q) return all.map((r) => ({ ...r, indexes: null }));
    return fuzzysort
      .go(q, all, { key: 'haystack', limit: 200 })
      .map((res) => ({ ...(res.obj as any), indexes: res.indexes as unknown as number[] }));
  }, [tabs, query, vaultPath, activeTabId, activeOverrideLabel]); // eslint-disable-line react-hooks/exhaustive-deps -- labelFor is derived from the listed deps

  const pickTab = (id) => { setListOpen(false); onSwitch(id); };

  return (
    // min-h is the height of a strip WITH tabs (scroller's pt-2 + a tab +
    // the bottom border). Without it the strip is sized by its contents, and
    // with no tabs open the only content left is the 26px right rail — so the
    // seam under the strip jumped ~17px down the moment you opened the first
    // tab. Floor, not a fixed height: a taller tab should still grow the strip
    // rather than be clipped, and the empty case is the only one below it.
    <div className="flex min-h-[44px] shrink-0 items-stretch border-b border-border bg-background pl-3 pr-2">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={({ active, over }) => {
          if (over && active.id !== over.id) onReorder(active.id, over.id);
        }}
      >
        <SortableContext items={tabs.map((t) => t.id)} strategy={horizontalListSortingStrategy}>
          <div
            ref={scrollerRef}
            // Chromium-only (Electron), and the tab strip is ~31px of usable
            // height — a horizontal scrollbar in it would eat a third of the
            // row. Every tabbed app hides it here; the list button is the
            // visible affordance.
            style={{ scrollbarWidth: 'none' }}
            className="flex min-w-0 flex-1 items-end gap-1.5 overflow-x-auto pt-2"
          >
            {tabs.map((tab) => (
              <SortableTab
                key={tab.id}
                tab={tab}
                isActive={tab.id === activeTabId}
                label={labelFor(tab)}
                tooltip={tooltipFor(tab)}
                activeRef={activeRef}
                onSwitch={onSwitch}
                onClose={onClose}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>

      {/* Pinned right rail — outside the scroller, so "+" is always reachable. */}
      <div className="flex shrink-0 items-center gap-1 pl-1.5">
        {/* Shown only while the strip overflows — with everything visible there
            is nothing the list can tell you that the strip isn't already
            showing.
            HIDDEN, never unmounted. Both conditions that hide it (the last tab
            closing, the strip ceasing to overflow) can be reached from INSIDE
            the open popover by closing tabs, and unmounting an open Radix layer
            is the `pointer-events: none` stuck-body bug described in this
            folder's CLAUDE.md — the app renders, animates and logs perfectly
            while ignoring every click. `listOpen` keeps it visible while it's
            open so the popover never anchors to something invisible. */}
        <Popover open={listOpen} onOpenChange={(o) => { setListOpen(o); if (!o) setQuery(''); }}>
          <PopoverTrigger asChild>
            <button
              type="button"
              className={cn(
                'flex h-[26px] items-center gap-1 rounded-[7px] px-1.5 text-[11.5px] text-muted-foreground hover:bg-accent hover:text-foreground data-[state=open]:bg-selected data-[state=open]:text-primary',
                !listOpen && (tabs.length === 0 || !overflowing) && 'invisible pointer-events-none',
              )}
              title="Search open tabs"
              aria-label="Search open tabs"
            >
              <ChevronDown size={14} />
              {tabs.length}
            </button>
          </PopoverTrigger>
          {/* Styled to match the chat-history popover exactly — same shell, same
              search header, same row shape and sizes. Two lists of the same kind
              of thing in one app should not look like they came from different
              ones. cmdk stays underneath for the arrow-key/Enter handling that
              the hand-rolled history list doesn't have; only its chrome is
              replaced, which is why this uses the raw primitives rather than the
              shadcn `Command*` wrappers and their own borders and text sizes. */}
          <PopoverContent
            align="end"
            className="w-[26rem] overflow-hidden rounded-lg border border-border bg-popover p-0 shadow-md"
          >
            <CommandPrimitive shouldFilter={false} className="flex max-h-96 w-full flex-col overflow-hidden">
              <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-muted-2">
                <SearchIcon size={13} />
                <CommandPrimitive.Input
                  className="min-w-0 flex-1 bg-transparent text-[12.5px] text-foreground outline-none placeholder:text-muted-2"
                  placeholder="Search open tabs…"
                  value={query}
                  onValueChange={setQuery}
                />
              </div>
              <CommandPrimitive.List className="flex-1 overflow-y-auto p-1">
                <CommandPrimitive.Empty className="px-2 py-3 text-center text-xs text-muted-foreground">
                  No matches
                </CommandPrimitive.Empty>
                {rows.map(({ tab, label, folder, indexes }) => {
                  const isActive = tab.id === activeTabId;
                  return (
                    <CommandPrimitive.Item
                      key={tab.id}
                      value={tab.id}
                      onSelect={() => pickTab(tab.id)}
                      className={cn(
                        'group/row flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left',
                        // data-[selected] is cmdk's keyboard cursor; it has to
                        // read the same as hover or arrowing through the list
                        // looks like nothing is happening.
                        isActive
                          ? 'bg-selected data-[selected=true]:bg-selected'
                          : 'hover:bg-accent data-[selected=true]:bg-accent',
                      )}
                    >
                      <TreeFileIcon />
                      <span className="min-w-0 flex-1 truncate text-[12.5px] text-foreground">
                        {indexes
                          ? segmentsFromIndexes(label, indexes).map((s, i) => (
                            <span key={i} className={s.match ? 'font-semibold' : undefined}>{s.value}</span>
                          ))
                          : label}
                      </span>
                      {folder && <span className="shrink-0 truncate text-[11px] text-muted-2">{folder}</span>}
                      <span
                        role="button"
                        tabIndex={0}
                        className="flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-2 opacity-0 hover:text-destructive group-hover/row:opacity-100"
                        // cmdk selects the row on click; both handlers are needed
                        // so closing a tab here doesn't also switch to it.
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation();
                          onClose(tab.id);
                        }}
                        aria-label={`Close ${label}`}
                      >
                        <XIcon size={12} />
                      </span>
                    </CommandPrimitive.Item>
                  );
                })}
              </CommandPrimitive.List>
            </CommandPrimitive>
          </PopoverContent>
        </Popover>
        <button
          className="flex size-[26px] items-center justify-center rounded-[7px] text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={onAdd}
          aria-label="New tab"
        >
          <PlusIcon size={14} />
        </button>
      </div>
    </div>
  );
}
