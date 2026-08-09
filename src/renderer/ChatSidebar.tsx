import React, { createContext, forwardRef, memo, useCallback, useContext, useEffect, useImperativeHandle, useMemo, useReducer, useRef, useState, useSyncExternalStore } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ChevronDown, ChevronRight, Sparkles, KeyRound, Pin } from 'lucide-react';
import { PaperclipIcon, PlayIcon, StopIcon, XIcon, FileTextIcon, MicIcon, PanelRightCloseIcon, CopyIcon, CheckIcon, SearchIcon, PlusIcon, TrashIcon } from './Icons.jsx';
import { cn } from '@/lib/utils';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuCheckboxItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { CHAT_SOURCES, CHAT_SOURCE_LABELS } from './constants.js';
import { resolveImageUrl } from './imageWidgets.js';
import {
  MAX_COMPOSER_READ_BYTES,
  isImageFile,
  readAsBytes,
  toBase64,
  formatBytes,
  nextAttachmentId,
  composeMessage,
  toImageContents,
} from './chatAttachments.js';
import { useVoiceInput } from './voice/useVoiceInput.js';
import { VoiceBars } from './voice/VoiceBars.jsx';
import * as chatStore from './chatStore.js';
import { EMPTY_CHAT } from './chatStore.js';
import ConfirmDialog from './ConfirmDialog.jsx';

// Workspace path available to MARKDOWN_COMPONENTS' `img` override via context,
// so the module-level components object stays referentially stable (preserving
// MessageRow's memo) while still resolving image src against the current
// workspace.
const ChatWorkspaceContext = createContext<string | null>(null);

// Override link and image rendering in react-markdown:
//
// - <a>: left-click opens https? in the system browser instead of navigating
//   the renderer (which would blank the app — no chrome to navigate back).
//   Main also installs a will-navigate guard as a safety net, but this is the
//   UX-correct path.
//
// - <img>: agents (playwright-cli screenshots, firecrawl page captures, etc.)
//   emit markdown like `![alt](./example.png)` whose src is a workspace-relative
//   path. React-markdown's default <img> would resolve that against the
//   renderer URL (http://localhost:5173/example.png in dev, file:// in prod)
//   and 404. Rewrite through `app://media/<rel>` — the same protocol the
//   editor's image widgets use — by passing the workspace path as `activeDir`
//   AND `vault` (the agent's cwd IS the workspace root, so plain relative
//   paths and absolute paths under the workspace both resolve correctly).
//   Outside-workspace or unresolvable paths fall back to alt text instead of
//   a broken-image icon.
//
// Exported as a module-level constant so the prop reference is stable and
// MessageRow's memo isn't invalidated.
function MarkdownLink({ href, children, ...rest }: any) {
  return (
    <a
      {...rest}
      href={href}
      onClick={(e) => {
        e.preventDefault();
        if (typeof href === 'string' && /^https?:\/\//i.test(href)) {
          window.api.openExternal(href);
        }
      }}
    >
      {children}
    </a>
  );
}

// Proper component (not an inline arrow in the map) so the useContext call
// satisfies the rules-of-hooks.
function MarkdownImg({ src, alt, ...rest }: any) {
  const ws = useContext(ChatWorkspaceContext);
  const resolved = typeof src === 'string' ? resolveImageUrl(src, ws, ws) : null;
  if (!resolved) return <>{alt || ''}</>;
  return <img {...rest} src={resolved} alt={alt || ''} loading="lazy" />;
}

const MARKDOWN_COMPONENTS = {
  a: MarkdownLink,
  img: MarkdownImg,
};

// Build a short, human-readable summary line for a tool call.
function toolSummary(toolName, args) {
  const a = args ?? {};
  switch (toolName) {
    case 'read':
    case 'write':
    case 'edit':
      return a.file_path ?? a.path ?? '';
    case 'bash':
      return typeof a.command === 'string' ? a.command.split('\n')[0].slice(0, 120) : '';
    case 'grep':
      return a.pattern ?? '';
    case 'find':
      return a.pattern ?? a.path ?? '';
    case 'ls':
      return a.path ?? '';
    // A batch is the shape the tool asks the model to prefer, so the default
    // JSON dump would be a wall of escaped entries truncated mid-word. Say which
    // store and how many changes; the expanded view still shows the arguments.
    case 'memory': {
      const store = a.target === 'user' ? 'user profile' : 'memory';
      if (Array.isArray(a.operations)) return `${a.operations.length} change(s) to ${store}`;
      return a.action ? `${a.action} ${store}` : store;
    }
    default:
      try { return JSON.stringify(a).slice(0, 120); } catch { return ''; }
  }
}

// Per-tool detail rendering for the expanded view header (above the output).
// Keep these terse — the collapsed-summary line already shows the headline arg.
// Shared styling for the expanded tool-args area (JetBrains Mono, quiet).
const toolArgsClass = 'mt-1 overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-muted-foreground';
const toolArgPathClass = 'font-mono text-xs text-muted-foreground break-all';

function ToolArgsDetail({ toolName, args }) {
  const a = args ?? {};
  if (toolName === 'bash') {
    return (
      <pre className={toolArgsClass}>
        <span className="select-none text-muted-2">$ </span>{a.command ?? ''}
      </pre>
    );
  }
  if (toolName === 'edit' && Array.isArray(a.edits)) {
    return (
      <div className={toolArgsClass}>
        <div className={toolArgPathClass}>{a.path ?? ''}</div>
        {a.edits.map((e, i) => (
          <div key={i} className="mt-1">
            {String(e?.oldText ?? '').split('\n').map((ln, j) => (
              <div key={`o${j}`} className="text-destructive/80">- {ln}</div>
            ))}
            {String(e?.newText ?? '').split('\n').map((ln, j) => (
              <div key={`n${j}`} className="text-success">+ {ln}</div>
            ))}
          </div>
        ))}
      </div>
    );
  }
  if (toolName === 'write') {
    return <div className={`${toolArgsClass} ${toolArgPathClass}`}>{a.path ?? ''}</div>;
  }
  if (toolName === 'read' || toolName === 'ls') {
    return <div className={`${toolArgsClass} ${toolArgPathClass}`}>{a.path ?? ''}</div>;
  }
  if (toolName === 'grep' || toolName === 'find') {
    return (
      <div className={toolArgsClass}>
        <div><span className="font-semibold text-muted-2">pattern</span> {a.pattern ?? ''}</div>
        {a.path && <div><span className="font-semibold text-muted-2">path</span> {a.path}</div>}
      </div>
    );
  }
  let block = '';
  try { block = JSON.stringify(a, null, 2); } catch { block = String(a); }
  return <pre className={toolArgsClass}>{block}</pre>;
}

// Xs under 60s, Ym Xs over.
function formatElapsed(ms) {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m ${s}s`;
}

function formatTokens(n) {
  if (!n) return '0';
  if (n < 1000) return String(n);
  const k = n / 1000;
  return k < 10 ? `${k.toFixed(1).replace(/\.0$/, '')}k` : `${Math.round(k)}k`;
}

function AttachmentChip({ att, onRemove }: any) {
  // Two sources, one chip. A file you just picked carries its bytes inline
  // (`dataUrl`); one loaded from a stored chat carries an `app://attachment/`
  // URL that main proxies to the companion. Neither knows about the other.
  const src = att.dataUrl || att.url;
  const handleClick = () => {
    if (att.kind === 'image' && src) window.api.openExternal(src);
  };
  return (
    <div className="group relative">
      {att.kind === 'image' ? (
        <button
          type="button"
          className="block size-12 rounded-lg border border-border bg-cover bg-center"
          onClick={handleClick}
          title={att.name}
          style={{ backgroundImage: `url("${src}")` }}
          aria-label={att.name}
        />
      ) : (
        <div
          className="flex max-w-40 items-center gap-1.5 rounded-lg border border-border bg-raise px-2 py-1.5"
          title={`${att.name} · ${formatBytes(att.bytes)}`}
        >
          <span className="shrink-0 text-muted-foreground"><FileTextIcon size={16} /></span>
          <span className="truncate text-xs text-foreground/85">{att.name}</span>
        </div>
      )}
      {onRemove && (
        <button
          type="button"
          className="absolute -right-1.5 -top-1.5 flex size-4 items-center justify-center rounded-full border border-border bg-background text-muted-foreground opacity-0 shadow-sm hover:text-foreground group-hover:opacity-100"
          onClick={() => onRemove(att.id)}
          aria-label={`Remove ${att.name}`}
        ><XIcon size={10} /></button>
      )}
    </div>
  );
}

function AttachmentRow({ attachments, onRemove }: any) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {attachments.map((a) => (
        <AttachmentChip key={a.id} att={a} onRemove={onRemove ?? null} />
      ))}
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<any>(null);
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);
  const onClick = useCallback(async (e: any) => {
    e.stopPropagation();
    const value = text ?? '';
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 1200);
    } catch { /* clipboard write is best-effort */ }
  }, [text]);
  return (
    <button
      type="button"
      className="mt-1 flex size-5 items-center justify-center rounded-sm text-muted-2 opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover/message:opacity-100"
      onClick={onClick}
      aria-label={copied ? 'Copied' : 'Copy message'}
      title={copied ? 'Copied' : 'Copy message'}
    >{copied ? <CheckIcon size={12} /> : <CopyIcon size={12} />}</button>
  );
}

// One rendered chat row. Memoized so typing in the composer (which re-renders
// the parent ChatSidebar) does NOT walk every message and call ReactMarkdown
// again. Every message object is referentially stable across non-mutating
// updates (see setMessages callers), so the default shallow-prop compare
// returns true for un-touched rows. Only the actively-streaming message gets a
// new reference and re-renders.
const MessageRow = memo(function MessageRow({ message: m }: any) {
  if (m.kind === 'user') {
    // Right-aligned indigo bubble with an asymmetric radius "tail" (spec §6).
    return (
      <div className="group/message flex flex-col items-end">
        <div className="max-w-[82%] rounded-[16px_16px_5px_16px] bg-primary px-[13px] py-[9px] text-md leading-[1.45] text-primary-foreground">
          {m.attachments && m.attachments.length > 0 && (
            <div className="mb-1.5"><AttachmentRow attachments={m.attachments} /></div>
          )}
          {m.text && <div className="whitespace-pre-wrap break-words">{m.text}</div>}
        </div>
        {m.text && <CopyButton text={m.text} />}
      </div>
    );
  }
  if (m.kind === 'assistant') {
    // No bubble — full-width flowing text. The asymmetry IS the hierarchy.
    return (
      <div className="group/message flex flex-col items-start">
        <div className="chat-markdown w-full max-w-full text-md leading-[1.6] text-foreground">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS as any}>{m.text}</ReactMarkdown>
        </div>
        {m.text && <CopyButton text={m.text} />}
      </div>
    );
  }
  if (m.kind === 'thinking') {
    return <ThinkingEntry entry={m} />;
  }
  if (m.kind === 'tool') {
    return <ToolEntry entry={m} />;
  }
  return null;
});

// Rotating loader ring — the same mark as the "Working" indicator (below).
function SpinnerIcon({ size = 12 }: { size?: number }) {
  return (
    <svg
      className="animate-spin"
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      width={size}
      height={size}
      aria-hidden="true"
    >
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  );
}

// Collapsible extended-thinking block. Deliberately the SAME card as ToolEntry
// below — chevron, status circle, label — because both are "the agent did
// something on its way to an answer" and two different shapes for that read as
// two different kinds of event. While streaming the circle spins and the label
// shimmers ("Thinking"); once thinking_end fires it lands on the same green ✓ a
// finished tool gets, with a static "Thought". Closed by default in both states.
function ThinkingEntry({ entry }) {
  const streaming = !entry.done;
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-[10px] border border-border bg-raise px-2.5 py-[7px]">
      <button type="button" className="flex w-full min-w-0 items-center gap-2 text-left" onClick={() => setOpen((v) => !v)}>
        {open
          ? <ChevronDown className="size-[13px] shrink-0 text-muted-2" strokeWidth={2.2} />
          : <ChevronRight className="size-[13px] shrink-0 text-muted-2" strokeWidth={2.2} />}
        <span className="w-3 shrink-0 text-xs leading-none text-success">
          {streaming ? <SpinnerIcon size={11} /> : '✓'}
        </span>
        <span className="shrink-0 font-mono text-xs font-medium text-muted-foreground">
          {streaming ? <span className="thinking-shimmer">Thinking</span> : 'Thought'}
        </span>
      </button>
      {open && (entry.text || streaming) && (
        <div className="mt-1.5 border-t border-border pt-1.5">
          <div className="max-h-56 overflow-y-auto whitespace-pre-wrap text-sm leading-[1.55] text-muted-foreground">
            <span>{entry.text}</span>
            {streaming && <span className="animate-pulse" aria-hidden="true">▌</span>}
          </div>
        </div>
      )}
    </div>
  );
}

function ToolEntry({ entry }) {
  const [open, setOpen] = useState(false);
  const running = !entry.done;
  return (
    // One-line quiet card (spec §6): chevron + status + mono command, truncated.
    <div
      className={cn(
        'rounded-[10px] border border-border bg-raise px-2.5 py-[7px]',
        entry.isError && 'border-destructive/30',
      )}
    >
      <button type="button" className="flex w-full min-w-0 items-center gap-2 text-left" onClick={() => setOpen((v) => !v)}>
        {open
          ? <ChevronDown className="size-[13px] shrink-0 text-muted-2" strokeWidth={2.2} />
          : <ChevronRight className="size-[13px] shrink-0 text-muted-2" strokeWidth={2.2} />}
        <span className={cn('w-3 shrink-0 text-xs leading-none', entry.isError ? 'text-destructive' : 'text-success')}>
          {running ? <SpinnerIcon size={11} /> : entry.isError ? '✗' : '✓'}
        </span>
        <span className="shrink-0 font-mono text-xs font-medium text-muted-foreground">{entry.toolName}</span>
        <span className="min-w-0 truncate font-mono text-xs text-muted-foreground/80">{toolSummary(entry.toolName, entry.args)}</span>
      </button>
      {open && (
        <div className="mt-1.5 border-t border-border pt-1.5">
          <ToolArgsDetail toolName={entry.toolName} args={entry.args} />
          {(entry.output || running) && (
            <div className="mt-1.5 max-h-56 overflow-y-auto whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-muted-foreground/90">
              <span>{entry.output}</span>
              {running && <span className="animate-pulse" aria-hidden="true">▌</span>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Pin (filled when active). Used in the header + each history row.
function PinIcon({ size = 14, filled = false }: { size?: number; filled?: boolean }) {
  return <Pin size={size} fill={filled ? 'currentColor' : 'none'} aria-hidden="true" />;
}

// "3m", "2h", "5d", or a date past a week — for the history list.
function formatAgo(ms) {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return 'now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  try { return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); } catch { return `${d}d`; }
}

// Popover of recent + searchable chats. Anchored under the header history button.
// Recents paginate on scroll (keyset via the last row's updatedAt); a non-empty
// query switches to full-text search across the workspace's chats.
function HistoryPopover({ currentSessionId, onSelect, onClose, runningIds, onDeleted, chatSources, onChatSourcesChange }: any) {
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<any[]>([]);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  // Pending delete confirmation: { chatId, title } | null.
  const [confirmDelete, setConfirmDelete] = useState<any>(null);
  const confirmDeleteRef = useRef<any>(null);
  confirmDeleteRef.current = confirmDelete;
  const rootRef = useRef<any>(null);
  // The source menu portals outside this popover, so a click in it reads as an
  // outside click. Same reason the delete confirmation suspends the dismiss
  // below — without it, picking a source closes the thing you were filtering.
  const sourceMenuOpenRef = useRef(false);
  const searching = query.trim().length > 0;

  // Dismiss on any click/focus outside the popover (ignoring the header toggle,
  // which owns its own open/close), or on Escape. Suspended while the delete
  // confirmation is up — its portal renders outside the popover, and Escape
  // there should close the dialog, not the popover.
  useEffect(() => {
    const onDown = (e) => {
      if (confirmDeleteRef.current || sourceMenuOpenRef.current) return;
      const t = e.target;
      if (rootRef.current?.contains(t)) return;
      if (t?.closest?.('.chat-history-toggle')) return; // let the toggle handle itself
      onClose();
    };
    const onKey = (e) => { if (e.key === 'Escape' && !confirmDeleteRef.current && !sourceMenuOpenRef.current) onClose(); };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('focusin', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('focusin', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const [pinned, setPinnedList] = useState<any[]>([]);

  const loadRecents = useCallback(async (before?: number) => {
    setLoading(true);
    try {
      const rows = await window.api.chat.list(before ? { before } : {});
      setItems((prev) => (before ? [...prev, ...rows] : rows));
      setHasMore(rows.length >= 30);
    } finally { setLoading(false); }
  }, []);

  const loadPinned = useCallback(async () => {
    try { setPinnedList(await window.api.chat.listPinned()); } catch { /* best-effort */ }
  }, []);

  // Refresh while the list is open. A chat can appear without any action here —
  // a Telegram message, a scheduled run, a review — and the
  // popover used to be a snapshot of whenever you opened it.
  //
  // Two guards. It skips while SEARCHING, because that has its own debounced
  // fetch and re-running the recents query would replace the results underneath
  // you. And it skips once you have paged past the first page: `loadRecents()`
  // with no cursor REPLACES the list, so refreshing there would collapse the
  // history you just scrolled through. Somebody reading back through old chats
  // is not waiting for new ones.
  const pollRef = useRef<any>(null);
  useEffect(() => {
    pollRef.current = { searching, count: items.length, loadRecents, loadPinned };
  });
  useEffect(() => {
    const t = setInterval(() => {
      const st = pollRef.current;
      if (!st || st.searching || st.count > 30) return;
      st.loadRecents();
      st.loadPinned();
    }, 10_000);
    return () => clearInterval(t);
  }, []);

  // Debounced search / initial recents + pinned.
  useEffect(() => {
    let cancelled = false;
    const q = query.trim();
    if (!q) { loadRecents(); loadPinned(); return () => { cancelled = true; }; }
    const t = setTimeout(async () => {
      const rows = await window.api.chat.searchChats({ query: q });
      if (!cancelled) { setItems(rows); setHasMore(false); }
    }, 180);
    return () => { cancelled = true; clearTimeout(t); };
  }, [query, loadRecents, loadPinned]);

  const onScroll = useCallback((e) => {
    if (searching || loading || !hasMore) return;
    const el = e.currentTarget;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 40) {
      const last = items[items.length - 1];
      if (last) loadRecents(last.updatedAt);
    }
  }, [searching, loading, hasMore, items, loadRecents]);

  const onDelete = useCallback((e, it) => {
    e.stopPropagation();
    setConfirmDelete({ chatId: it.chatId, title: it.title });
  }, []);

  const performDelete = useCallback(async (chatId) => {
    await window.api.chat.deleteChat(chatId);
    setItems((prev) => prev.filter((x) => x.chatId !== chatId));
    setPinnedList((prev) => prev.filter((x) => x.chatId !== chatId));
    onDeleted?.(chatId);
  }, [onDeleted]);

  const onTogglePin = useCallback(async (e, chatId, currentlyPinned) => {
    e.stopPropagation();
    await window.api.chat.setPinned({ chatId, pinned: !currentlyPinned });
    loadRecents();
    loadPinned();
  }, [loadRecents, loadPinned]);

  const renderRow = (it, isPinned) => (
    <button
      key={it.chatId}
      type="button"
      className={cn(
        'group/row flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent',
        it.chatId === currentSessionId && 'bg-selected hover:bg-selected',
      )}
      onClick={() => onSelect(it.chatId)}
    >
      <span
        role="button"
        tabIndex={0}
        className={cn(
          'flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-2 hover:text-foreground',
          isPinned && 'text-primary hover:text-primary',
        )}
        onClick={(e) => onTogglePin(e, it.chatId, isPinned)}
        aria-label={isPinned ? 'Unpin chat' : 'Pin chat'}
        title={isPinned ? 'Unpin' : 'Pin'}
      ><PinIcon size={13} filled={isPinned} /></span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-sm text-foreground">{it.title || 'Untitled chat'}</span>
          {/* Source tag AFTER the title for non-desktop chats (cron, telegram, …).
              bg-foreground/text-background is black-on-white → auto-reverses in dark mode. */}
          {it.source && it.source !== 'desktop' && (
            <span className="shrink-0 rounded bg-foreground px-1 py-px text-micro font-semibold uppercase leading-none tracking-wide text-background">{it.source}</span>
          )}
        </span>
        {searching && it.snippet && <span className="truncate text-xs text-muted-2">{it.snippet}</span>}
      </span>
      {runningIds?.has(it.chatId) ? (
        <span className="shrink-0 text-primary" title="Responding…" aria-label="Responding"><SpinnerIcon size={12} /></span>
      ) : (
        !searching && <span className="shrink-0 text-xs text-muted-2">{formatAgo(it.updatedAt)}</span>
      )}
      <span
        role="button"
        tabIndex={0}
        className="flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-2 opacity-0 hover:text-destructive group-hover/row:opacity-100"
        onClick={(e) => onDelete(e, it)}
        aria-label="Delete chat"
        title="Delete chat"
      ><TrashIcon size={12} /></span>
    </button>
  );

  // Which sources are listed. `null` means all — the default, and what keeps a
  // source added later visible instead of silently missing from a saved list.
  // A row with no source is treated as `desktop`: agent-core writes
  // `source ?? 'desktop'`, so a null is a pre-provenance chat, not an unknown
  // kind, and hiding it under "Desktop" unchecked would lose history invisibly.
  const sourceOf = (it: any) => it?.source || 'desktop';
  const allowed: Set<string> | null = useMemo(
    () => (Array.isArray(chatSources) ? new Set(chatSources) : null),
    [chatSources],
  );
  const keep = useCallback((it: any) => !allowed || allowed.has(sourceOf(it)), [allowed]);

  const visible = useMemo(() => items.filter(keep), [items, keep]);
  const visiblePinned = useMemo(() => pinned.filter(keep), [pinned, keep]);

  // Counted off the UNFILTERED list so the menu can say what each source would
  // add back. Counting the filtered one is always zero for a hidden source —
  // i.e. the number appears only once you no longer need it.
  const countsBySource = useMemo(() => {
    const m: Record<string, number> = {};
    for (const it of items) { const k = sourceOf(it); m[k] = (m[k] ?? 0) + 1; }
    return m;
  }, [items]);

  const selected = allowed ?? new Set(CHAT_SOURCES);
  const allSelected = !allowed || CHAT_SOURCES.every((k) => allowed.has(k));
  const toggleSource = (key: string, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(key); else next.delete(key);
    // Back to everything selected stores `null`, not the full list — see above.
    const all = CHAT_SOURCES.every((k) => next.has(k));
    onChatSourcesChange?.(all ? null : CHAT_SOURCES.filter((k) => next.has(k)));
  };

  const sourceSummary = CHAT_SOURCES.filter((k) => selected.has(k))
    .map((k) => CHAT_SOURCE_LABELS[k]).join(', ') || 'Nothing';

  const showPinned = !searching && visiblePinned.length > 0;
  const empty = visible.length === 0 && !showPinned && !loading;

  return (
    <div
      // Anchored to the sidebar's right edge and never narrower than 26rem, so a
      // narrow chat column doesn't squeeze the footer controls; it spills left over
      // the editor instead. Widens with the sidebar when that is bigger.
      className="absolute right-2 top-12 z-30 flex max-h-96 w-[26rem] min-w-[calc(100%_-_1rem)] flex-col overflow-hidden rounded-lg border border-border bg-popover shadow-md"
      role="dialog"
      aria-label="Chat history"
      ref={rootRef}
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-muted-2">
        <SearchIcon size={13} />
        <input
          type="text"
          className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-2"
          placeholder="Search chats…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {/* Sits beside the search rather than under the list: it decides what the
            list contains, so it belongs where you set that, not after it. */}
        <DropdownMenu onOpenChange={(o) => {
          // Opening flips immediately; CLOSING is deferred a frame. The Escape
          // that dismisses the menu is the same keypress the popover's own
          // handler sees, so clearing this synchronously means one Escape closes
          // both. Held for a tick, the first Escape closes the menu and a second
          // closes the popover.
          if (o) sourceMenuOpenRef.current = true;
          else setTimeout(() => { sourceMenuOpenRef.current = false; }, 0);
        }}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              title={allSelected ? 'Showing all chats' : `Showing ${sourceSummary}`}
              className={cn(
                'flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs hover:bg-accent hover:text-foreground',
                allSelected ? 'text-muted-foreground' : 'bg-selected text-primary',
              )}
            >
              {allSelected ? 'All chats' : sourceSummary}
              <ChevronDown className="size-3" strokeWidth={2.2} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-52">
            <DropdownMenuLabel className="text-xs font-semibold text-muted-2">Show chats from</DropdownMenuLabel>
            {CHAT_SOURCES.map((key) => (
              <DropdownMenuCheckboxItem
                key={key}
                checked={selected.has(key)}
                onSelect={(e) => e.preventDefault()}
                onCheckedChange={(on) => toggleSource(key, !!on)}
              >
                <span className="flex w-full items-center justify-between gap-3">
                  <span>{CHAT_SOURCE_LABELS[key]}</span>
                  <span className="text-xs text-muted-2">{countsBySource[key] ?? 0}</span>
                </span>
              </DropdownMenuCheckboxItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={allSelected} onSelect={() => onChatSourcesChange?.(null)}>
              Show all
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="flex-1 overflow-y-auto p-1" onScroll={onScroll}>
        {empty && (
          <div className="px-2 py-3 text-center text-xs text-muted-foreground">{searching ? 'No matches' : 'No saved chats yet'}</div>
        )}
        {showPinned && (
          <>
            <div className="px-2 pb-1 pt-1.5 text-micro font-semibold uppercase tracking-[0.09em] text-muted-2">Pinned</div>
            {visiblePinned.map((it) => renderRow(it, true))}
            {visible.length > 0 && <div className="px-2 pb-1 pt-2 text-micro font-semibold uppercase tracking-[0.09em] text-muted-2">Recent</div>}
          </>
        )}
        {visible.map((it) => renderRow(it, false))}
      </div>
      <ConfirmDialog
        open={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        onConfirm={() => {
          const pending = confirmDelete;
          setConfirmDelete(null);
          if (pending) performDelete(pending.chatId);
        }}
        title="Delete chat?"
        message={
          `"${confirmDelete?.title || 'Untitled chat'}" and its messages will be permanently deleted.` +
          (runningIds?.has(confirmDelete?.chatId) ? ' This chat is currently responding — the response will be stopped.' : '')
        }
        confirmLabel="Delete"
        destructive
      />
    </div>
  );
}

const ChatSidebar = forwardRef<any, any>(function ChatSidebar({ onClose, workspacePath, onOpenSecrets, onOpenVoiceSettings, chatSources, onChatSourcesChange, companionStale = false }, ref) {
  // All chat state (transcripts, running flags, drafts, counters) lives in
  // chatStore — OUTSIDE this component — so background chats keep streaming
  // and nothing is lost when the sidebar collapses (unmount) or the workspace
  // switches (remount). This component is a view over the active chat's entry.
  // The store owns the single agent-event subscription; there is none here.
  const snap = useSyncExternalStore(chatStore.subscribe, chatStore.getState);
  const currentSessionId = workspacePath ? snap.activeByWorkspace[workspacePath] ?? null : null;
  const chat = (currentSessionId && snap.chats[currentSessionId]) || EMPTY_CHAT;
  const chatIdRef = useRef<string | null>(currentSessionId);
  chatIdRef.current = currentSessionId;

  // Mint the workspace's active chat on mount / workspace switch.
  useEffect(() => {
    if (workspacePath) chatStore.ensureActiveChat(workspacePath);
  }, [workspacePath]);

  const { messages, running, error, tokens, queuedCount, attachments } = chat;
  // Running on another machine → this composer is frozen (single writer per turn).
  // It unfreezes when that turn ends (agent_end clears the run's machine).
  const remoteMachine = chatStore.remoteMachineOf(chat);
  // A version mismatch freezes it too, and for a blunter reason: main refuses
  // every write to the companion while the two sides disagree, and a chat turn
  // is nothing BUT writes — the message row, the transcript, the run flag, each
  // streamed event. Left open, a turn would run, look normal, and store none of
  // itself. Refusing at the composer is the same bargain as the remote-run
  // freeze: nothing starts that can't finish.
  const frozen = !!remoteMachine || companionStale;
  const frozenReason = remoteMachine
    ? `Running on ${remoteMachine}…`
    : 'Your server needs updating before chats can run';
  // What the SPINNER shows, which is not the same question as `running`: a
  // remote turn is only observable while the feed carrying it is alive, and a
  // claim we can no longer see must not be drawn as live. See `isWorking`.
  const working = chatStore.isWorking(chat);
  const input = chat.draft;
  const chatTitle = chat.title;
  const chatPinned = chat.pinned;

  // Chats with a turn in flight (any workspace) — drives the history spinner.
  const runningIds = useMemo(
    () => new Set(Object.keys(snap.chats).filter((id) => chatStore.isWorking(snap.chats[id]))),
    [snap.chats],
  );

  // Local view-only state.
  const [rejected, setRejected] = useState<any>(null); // { name, reason }
  const [dragOver, setDragOver] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [renamingTitle, setRenamingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  // Voice input — partialText is the in-flight AssemblyAI partial transcript
  // (replaced as the model refines, then committed into `input` on end_of_turn).
  const [partialText, setPartialText] = useState('');
  const voiceVolumeRef = useRef(0);
  const scrollRef = useRef<any>(null);
  const textareaRef = useRef<any>(null);
  const fileInputRef = useRef<any>(null);
  const sidebarRootRef = useRef<any>(null);
  const dragCounterRef = useRef(0);

  // Elapsed ticker — display-only, derived from the store's runStartAt so the
  // store isn't churned 5×/sec. Just re-renders this component while running.
  const [, forceTick] = useReducer((x) => x + 1, 0);
  useEffect(() => {
    if (!working || !chat.runStartAt) return;
    const t = setInterval(forceTick, 200);
    return () => clearInterval(t);
  }, [working, chat.runStartAt]);
  const elapsedMs = working && chat.runStartAt ? Date.now() - chat.runStartAt : chat.elapsedMs;

  // Store-backed setters with the local-state call shapes the handlers below
  // (and the voice hook) expect. Each resolves the chat id at call time via
  // chatIdRef so stable closures always hit the active chat.
  const setInput = useCallback((value: any) => {
    const id = chatIdRef.current ?? (workspacePath ? chatStore.ensureActiveChat(workspacePath) : null);
    if (!id) return;
    const next = typeof value === 'function' ? value(chatStore.getState().chats[id]?.draft ?? '') : value;
    chatStore.setDraft(id, next);
  }, [workspacePath]);

  const setAttachments = useCallback((updater: any) => {
    const id = chatIdRef.current ?? (workspacePath ? chatStore.ensureActiveChat(workspacePath) : null);
    if (!id) return;
    chatStore.setAttachments(id, typeof updater === 'function' ? updater : () => updater);
  }, [workspacePath]);

  const setError = useCallback((message: any) => {
    const id = chatIdRef.current;
    if (id) chatStore.setError(id, message);
  }, []);

  // Auto-scroll to bottom when new messages arrive.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, running]);

  // Auto-grow the textarea up to ~7 lines, then internal scrolling.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [input]);

  // Voice input hook. Its token prefetch runs on mount, so every mic click
  // after the first ~200ms of an expanded sidebar uses the cached token with no
  // round-trip. Collapsing the sidebar UNMOUNTS this component (App.tsx renders
  // it conditionally), which means the hook's cleanup effect is also what stops
  // a live mic on collapse and on a workspace switch — see the stop triggers
  // spelled out in `useVoiceInput.ts`.
  const { voiceAvailable, voiceError, isConnecting: voiceConnecting, isRecording: voiceRecording, startRecording: startVoice, stopRecording: stopVoice } = useVoiceInput({
    getToken: () => window.api.voice.getToken(),
    onTranscript: (finalText) => {
      setInput((prev) => {
        const sep = prev && !prev.endsWith(' ') ? ' ' : '';
        return prev + sep + finalText;
      });
    },
    onPartialTranscript: setPartialText,
    onError: (msg) => setError(msg),
    onVolumeChange: (rms) => { voiceVolumeRef.current = rms; },
  });

  const onSend = useCallback(async () => {
    const activeId = chatIdRef.current;
    const activeEntry = activeId ? chatStore.getState().chats[activeId] : null;
    if (activeEntry && chatStore.remoteMachineOf(activeEntry)) return; // frozen: running elsewhere
    // Commit any in-flight partial transcript before submitting. The textarea
    // displays input+partial as one string, so the user expects the partial
    // they just said to be part of what gets sent.
    let typed = input.trim();
    if (partialText) {
      const sep = input && !input.endsWith(' ') ? ' ' : '';
      typed = (input + sep + partialText).trim();
      setPartialText('');
    }
    // Sending ends the utterance, so it ends the recording. An agent turn runs
    // for minutes; a mic left hot across one transcribes the room into the next
    // prompt. `discardPending` is what makes this safe rather than merely tidy —
    // the socket lingers to hear the vendor's flush, and those words would land
    // in the composer AFTER the draft cleared, opening the next message with the
    // tail of this one (and on AssemblyAI, whose final is the whole turn, with a
    // duplicate of the partial committed just above).
    if (voiceRecording) stopVoice({ discardPending: true });
    if (!typed && attachments.length === 0) return;
    if (!workspacePath) return; // composer is disabled without a workspace
    const id = chatIdRef.current ?? chatStore.ensureActiveChat(workspacePath);
    setRejected(null);

    // Save every attachment into the chat's scratch pad FIRST — the prompt is
    // built out of what main says it wrote, so the paths in it always name files
    // that exist. Writing at send rather than at ingest is what keeps a chip you
    // removed, or a draft you never sent, from leaving a file behind.
    let saved: any[] = [];
    let visionAvailable = false;
    if (attachments.length > 0) {
      try {
        const res = await window.api.agent.stashFiles({
          chatId: id,
          files: attachments.map((a) => ({
            id: a.id, name: a.name, mimeType: a.mimeType, data: a.data, sourcePath: a.sourcePath,
          })),
        });
        visionAvailable = res.visionAvailable;
        saved = res.attachments ?? [];
      } catch (err: any) {
        setRejected({ name: 'Attachments', reason: err?.message ?? String(err) });
        return; // the draft is still on screen — nothing was cleared yet
      }
      const failed = saved.filter((s) => s.error);
      if (failed.length > 0) {
        const first = attachments.find((a) => a.id === failed[0].id);
        setRejected(failed.length === 1
          ? { name: first?.name ?? 'Attachment', reason: failed[0].error }
          : { name: `${failed.length} files`, reason: `${first?.name}: ${failed[0].error} (+${failed.length - 1} more)` });
        return;
      }
    }

    // One composition, shared with Telegram: the bracketed notes naming each
    // path, then any small text file's contents, then what the user typed.
    const promptText = composeMessage(saved, typed, visionAvailable);
    const images = visionAvailable
      ? toImageContents(
        saved
          .filter((s) => s.kind === 'image')
          .map((s) => {
            const bytes = attachments.find((a) => a.id === s.id)?.data;
            return bytes ? { ...s, base64: toBase64(bytes) } : null;
          })
          .filter(Boolean),
      )
      : [];

    chatStore.setDraft(id, '');
    chatStore.setAttachments(id, () => []);
    // If this chat is mid-turn, main steers the message into the running turn.
    await chatStore.sendToChat(id, {
      text: typed,
      promptText,
      images,
      // `data` is dropped on the way into the transcript: the bubble needs a name
      // and a thumbnail, and keeping the bytes would pin every file the user ever
      // attached in memory for the life of the window.
      attachments: attachments.map(({ data, sourcePath, ...rest }) => rest),
    });
  }, [input, partialText, attachments, workspacePath, voiceRecording, stopVoice]);

  const onStop = useCallback(async () => {
    const id = chatIdRef.current;
    if (id) await chatStore.abortChat(id);
  }, []);

  // "New chat": mint a fresh entry and switch to it. The previous chat is
  // untouched — if it's mid-turn it keeps running in the background (spinner
  // in the history popover; its transcript keeps accumulating in the store).
  const onClear = useCallback(() => {
    if (!workspacePath) return;
    chatStore.newChat(workspacePath);
    setRejected(null);
    setRenamingTitle(false);
    setPartialText('');
    // The mic belongs to the composer you were talking into. Clearing the
    // partial while the socket kept streaming meant the next thing you said
    // landed in a chat you had already walked away from. The flush is kept —
    // nothing has been sent, so those words are still yours to see arrive.
    if (voiceRecording) stopVoice();
    // Focus the composer so you can just start typing. Deferred a frame: the
    // textarea is `disabled` while the previous chat ran elsewhere, and focus()
    // on a still-disabled element is a no-op.
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      const len = el.value.length;
      try { el.setSelectionRange(len, len); } catch { /* selection is cosmetic */ }
    });
  }, [workspacePath, voiceRecording, stopVoice]);

  // Pin / unpin the active chat (header pin button).
  const onToggleHeaderPin = useCallback(async () => {
    const id = chatIdRef.current;
    if (!id || !chat.persisted) return;
    const next = !chatPinned;
    chatStore.setPinned(id, next);
    try { await window.api.chat.setPinned({ chatId: id, pinned: next }); }
    catch { chatStore.setPinned(id, !next); }
  }, [chat.persisted, chatPinned]);

  // Inline rename of the active chat's title (double-click the header title).
  const startRename = useCallback(() => {
    if (!chatIdRef.current || !chat.persisted) return;
    setTitleDraft(chatTitle ?? '');
    setRenamingTitle(true);
  }, [chat.persisted, chatTitle]);

  const commitRename = useCallback(async () => {
    const id = chatIdRef.current;
    const title = titleDraft.trim();
    setRenamingTitle(false);
    if (!id || !title || title === chatTitle) return;
    chatStore.setTitle(id, title);
    try { await window.api.chat.rename({ chatId: id, title }); }
    catch { /* rename is best-effort */ }
  }, [titleDraft, chatTitle]);

  // Open a saved chat from the history popover. Cold chats hydrate from the
  // DB; chats already in the store (e.g. running in the background) switch
  // instantly with their live transcript intact.
  const onOpenSession = useCallback(async (chatId) => {
    setShowHistory(false);
    if (chatId === chatIdRef.current) return;
    try {
      await chatStore.openChat(chatId, workspacePath);
      setRenamingTitle(false);
      setRejected(null);
      setPartialText('');
    } catch (err: any) {
      setError(err?.message ?? String(err));
    }
  }, [workspacePath, setError]);

  // A chat was deleted from the history popover (main already aborted +
  // disposed its live session). Drop it from the store; if it was the one on
  // screen, move to a fresh chat.
  const onDeletedSession = useCallback((chatId) => {
    const wasActive = chatId === chatIdRef.current;
    chatStore.removeChat(chatId);
    if (wasActive && workspacePath) chatStore.newChat(workspacePath);
  }, [workspacePath]);

  // Take whatever the user gave us. No format gate: what the file IS gets
  // decided in main, which sniffs the bytes and writes it into the chat's
  // scratch pad at send time — so the only things that can fail here are
  // reading it and, for a pasted file with no path on disk, its size.
  //
  // `kind` here is for the CHIP alone (a thumbnail or a filename row); the
  // authoritative kind comes back from main with the saved descriptor.
  const ingestFiles = useCallback(async (fileList) => {
    const files = [...(fileList ?? [])];
    if (files.length === 0) return;
    const added: any[] = [];
    const failures: any[] = [];
    for (const file of files) {
      try {
        const isImage = isImageFile(file);
        // Electron answers this for anything dropped or picked from disk, and ''
        // for a File the clipboard synthesized. Having it is what lets a huge
        // archive skip the renderer entirely — main can read the file itself.
        const sourcePath = window.api.pathForFile(file) || '';

        // Images are always read: the thumbnail and the pixels the model sees
        // both come from these bytes, and every provider's own size limit is far
        // below ours. Everything else is read only when there's no path to hand
        // over instead — which is a clipboard paste, the one case that can be
        // too big to accept at all.
        const read = isImage || !sourcePath;
        if (read && !isImage && file.size > MAX_COMPOSER_READ_BYTES) {
          failures.push({ name: file.name, reason: `too large to paste (${formatBytes(file.size)}) — drag the file in instead` });
          continue;
        }

        const att: any = {
          id: nextAttachmentId(),
          kind: isImage ? 'image' : 'file',
          name: file.name || (isImage ? 'image' : 'file'),
          mimeType: file.type || '',
          bytes: file.size,
          sourcePath,
        };
        if (read) {
          att.data = await readAsBytes(file);
          // The preview declares the browser's guess at the type, which is fine
          // for an <img> — nothing reaches a provider from this string.
          if (isImage) att.dataUrl = `data:${file.type};base64,${toBase64(att.data)}`;
        }
        added.push(att);
      } catch (err: any) {
        failures.push({ name: file.name, reason: err?.message ?? String(err) });
      }
    }
    if (added.length > 0) setAttachments((prev) => [...prev, ...added]);
    if (failures.length === 1) {
      setRejected(failures[0]);
    } else if (failures.length > 1) {
      const first = failures[0];
      setRejected({
        name: `${failures.length} files`,
        reason: `${first.name}: ${first.reason} (+${failures.length - 1} more)`,
      });
    }
  }, [setAttachments]);

  const removeAttachment = useCallback((id) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }, [setAttachments]);

  const onPickFiles = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const onFileInputChange = useCallback(async (e) => {
    await ingestFiles(e.target.files);
    e.target.value = '';
  }, [ingestFiles]);

  // Any pasted FILE is an attachment now, not only an image — the composer used
  // to intercept the clipboard only when it held a picture, so pasting a PDF did
  // nothing at all, not even the error. Text on the clipboard is still text and
  // falls through to the textarea untouched (`files` is empty for a plain copy).
  const onPaste = useCallback(async (e) => {
    const files = e.clipboardData?.files;
    if (files && files.length > 0) {
      e.preventDefault();
      await ingestFiles(files);
    }
  }, [ingestFiles]);

  // Direct addEventListener — react-dnd-html5-backend registers a window-level
  // capture-phase drop handler that pre-empts React's synthetic onDrop. Same
  // pattern as src/imagePaste.js. Drag enter/leave use a counter so child
  // elements don't flicker the overlay.
  useEffect(() => {
    const el = sidebarRootRef.current;
    if (!el) return;
    const hasFiles = (e) => {
      const types = e.dataTransfer?.types;
      return types && [...types].includes('Files');
    };
    const onEnter = (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragCounterRef.current += 1;
      setDragOver(true);
    };
    const onOver = (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const onLeave = (e) => {
      if (!hasFiles(e)) return;
      dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
      if (dragCounterRef.current === 0) setDragOver(false);
    };
    const onDrop = (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      dragCounterRef.current = 0;
      setDragOver(false);
      ingestFiles(e.dataTransfer.files);
    };
    el.addEventListener('dragenter', onEnter);
    el.addEventListener('dragover', onOver);
    el.addEventListener('dragleave', onLeave);
    el.addEventListener('drop', onDrop);
    return () => {
      el.removeEventListener('dragenter', onEnter);
      el.removeEventListener('dragover', onOver);
      el.removeEventListener('dragleave', onLeave);
      el.removeEventListener('drop', onDrop);
    };
  }, [ingestFiles]);

  const onKeyDown = useCallback((e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSend();
      return;
    }
    // Escape is the fast way off the mic without reaching for the button. Only
    // while recording — otherwise the key keeps whatever meaning anything above
    // this composer gives it.
    if (e.key === 'Escape' && voiceRecording) {
      e.preventDefault();
      stopVoice();
    }
  }, [onSend, voiceRecording, stopVoice]);

  // Imperative surface for the "Send to Agent" right-click flow in App.jsx.
  // setComposerText replaces or appends; focusComposer moves caret to end and
  // gives the textarea focus. Append uses a blank-line separator.
  useImperativeHandle(ref, () => ({
    setComposerText(text, { append = false } = {}) {
      setInput((prev) => (append && prev ? `${prev}\n\n${text}` : text));
    },
    getComposerText() {
      return input;
    },
    focusComposer() {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      const len = el.value.length;
      try { el.setSelectionRange(len, len); } catch { /* selection is cosmetic */ }
    },
  }), [input, setInput]);

  // Click anywhere in the sidebar that isn't an interactive element or active
  // text selection -> focus the composer textarea and put the caret at the end.
  // Matches the common chat-UI pattern (Slack, Discord, etc.).
  const onSidebarClick = useCallback((e) => {
    if (e.target.closest('button, a, input, textarea, select, [contenteditable]')) return;
    const sel = window.getSelection?.();
    if (sel && !sel.isCollapsed) return;
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    const len = el.value.length;
    try { el.setSelectionRange(len, len); } catch { /* selection is cosmetic */ }
  }, []);

  const headerBtn = 'flex size-[26px] shrink-0 items-center justify-center rounded-[7px] text-muted-foreground hover:bg-accent hover:text-foreground';

  return (
    <div
      className="relative flex h-full min-h-0 flex-col border-l border-border bg-chat"
      role="region"
      aria-label="Coding agent chat"
      ref={sidebarRootRef}
      onClick={onSidebarClick}
    >
      {dragOver && (
        <div className="absolute inset-0 z-40 flex items-center justify-center rounded-none border-2 border-dashed border-primary bg-primary/5" aria-hidden="true">
          <div className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground">Drop to attach</div>
        </div>
      )}
      {/* 44px header: history left, avatar+title centered, collapse right (spec §6).
          No hairline — the gradient shim below softens the scroll joint instead. */}
      <div className="flex h-11 shrink-0 items-center gap-1 px-3">
        <button
          type="button"
          className={headerBtn}
          onClick={onClear}
          title="Start a new chat"
          aria-label="New chat"
        ><PlusIcon size={15} /></button>
        <button
          type="button"
          // 'chat-history-toggle' is an unstyled marker — HistoryPopover's
          // outside-click guard ignores clicks on it.
          className={cn('chat-history-toggle', headerBtn, showHistory && 'bg-selected text-primary hover:bg-selected hover:text-primary')}
          onClick={() => setShowHistory((v) => !v)}
          title="Chat history"
          aria-label="Chat history"
          aria-expanded={showHistory}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            width={15}
            height={15}
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M3 3v5h5" />
            <path d="M3.05 13A9 9 0 1 0 6 5.3L3 8" />
            <path d="M12 7v5l4 2" />
          </svg>
        </button>
        <span className="flex min-w-0 flex-1 items-center justify-center gap-[7px]">
          <span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Sparkles className="size-[13px]" strokeWidth={1.7} />
          </span>
          {renamingTitle ? (
            <input
              className="w-full max-w-48 rounded-sm border border-input bg-background px-1.5 py-0.5 text-sm font-semibold outline-none focus:border-ring"
              value={titleDraft}
              autoFocus
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
                else if (e.key === 'Escape') { e.preventDefault(); setRenamingTitle(false); }
              }}
            />
          ) : (
            <span
              className="truncate text-sm font-semibold text-foreground"
              onDoubleClick={startRename}
              title={chat.persisted ? 'Double-click to rename' : undefined}
            >{chatTitle || 'Agent Chat'}</span>
          )}
        </span>
        {chat.persisted && (
          <button
            type="button"
            className={cn(headerBtn, chatPinned && 'text-primary hover:text-primary')}
            onClick={onToggleHeaderPin}
            title={chatPinned ? 'Unpin chat' : 'Pin chat'}
            aria-label={chatPinned ? 'Unpin chat' : 'Pin chat'}
            aria-pressed={chatPinned}
          ><PinIcon size={15} filled={chatPinned} /></button>
        )}
        <button
          type="button"
          className={headerBtn}
          onClick={onClose}
          title="Collapse coding agent"
          aria-label="Collapse coding agent"
        ><PanelRightCloseIcon size={14} /></button>
      </div>
      {/* Soft fade over the transcript's top edge so scrolled text slides under the header. */}
      <div className="pointer-events-none absolute inset-x-0 top-11 z-10 h-5 bg-gradient-to-b from-chat to-transparent" aria-hidden="true" />
      {showHistory && (
        <HistoryPopover
          currentSessionId={currentSessionId}
          onSelect={onOpenSession}
          onClose={() => setShowHistory(false)}
          runningIds={runningIds}
          onDeleted={onDeletedSession}
          chatSources={chatSources}
          onChatSourcesChange={onChatSourcesChange}
        />
      )}

      {/* Conversation flows in Instrument Sans (spec §3/§6). */}
      <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-3.5 py-4 font-chat">
        <ChatWorkspaceContext.Provider value={workspacePath}>
          {messages.map((m) => <MessageRow key={m.id} message={m} />)}
        </ChatWorkspaceContext.Provider>
        {working && (
          <div className="flex items-center gap-1.5 text-xs font-semibold text-muted-2">
            <SpinnerIcon />
            <span className="thinking-shimmer">Working</span>
            <span className="font-normal">
              {formatElapsed(elapsedMs)}
              {tokens > 0 && ` · ${formatTokens(tokens)} tokens`}
              {queuedCount > 0 && ` · ${queuedCount} queued`}
            </span>
          </div>
        )}
        {error && (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-xs text-destructive">{error}</div>
        )}
      </div>

      {/* Composer card: rounded 14px, lifted off the panel (spec §6). */}
      <div className="shrink-0 px-3 pb-3 pt-2.5">
        <div className="flex flex-col gap-2 rounded-[14px] border border-input bg-background px-3 py-2.5 shadow-(--shadow-raise)">
          {attachments.length > 0 && (
            <AttachmentRow attachments={attachments} onRemove={removeAttachment} />
          )}
          {rejected && (
            <div className="flex items-center justify-between gap-2 rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
              <span className="min-w-0 truncate">{rejected.name}: {rejected.reason}</span>
              <button type="button" className="shrink-0 hover:opacity-70" onClick={() => setRejected(null)} aria-label="Dismiss"><XIcon size={12} /></button>
            </div>
          )}
        <textarea
          ref={textareaRef}
          className="max-h-44 w-full resize-none bg-transparent font-chat text-md leading-normal text-foreground outline-none placeholder:text-muted-2 disabled:opacity-50"
          value={input + (partialText ? (input && !input.endsWith(' ') ? ' ' : '') + partialText : '')}
          placeholder={frozen ? frozenReason : 'Ask the agent…'}
          disabled={frozen}
          onChange={(e) => { setInput(e.target.value); setPartialText(''); }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          rows={2}
        />
        {/* No `accept` — anything can be attached, so anything must be pickable.
            The list that used to sit here was a third hand-maintained copy of the
            extension rules, and it greyed out in the OS dialog exactly the files
            drag-and-drop would happily have taken. */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          style={{ display: 'none' }}
          onChange={onFileInputChange}
        />
        {/* Attach + API keys left, mic + square accent send right (spec §6). */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1">
            <button
              type="button"
              className="flex size-[26px] items-center justify-center rounded-[7px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
              onClick={onPickFiles}
              title="Attach images or text files"
              aria-label="Attach files"
            ><PaperclipIcon size={15} /></button>
            <button
              type="button"
              className="flex size-[26px] items-center justify-center rounded-[7px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
              onClick={onOpenSecrets}
              title="API secrets"
              aria-label="API secrets"
            ><KeyRound size={15} /></button>
          </div>
          {/* While running, Stop and Send coexist: Enter/Send steers the
              message into the running turn (pi queues it and delivers at the
              next step boundary). */}
          <div className="flex items-center gap-1.5">
            {/* The mic is ALWAYS drawn, even when the token mint refuses.
                Hiding it on failure is how a fixable key problem — a Deepgram
                key without permission to mint, a companion that was away at
                mount — became a feature that looked like it had never been
                built: no icon, no message, nothing to click. Unavailable is a
                dimmed mic whose tooltip carries the vendor's own sentence and
                whose click opens the page that fixes it. */}
            <button
              type="button"
              className={cn(
                'flex h-[26px] min-w-[26px] items-center justify-center rounded-[7px] px-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40',
                // Recording is an ACTIVE state, so it takes the app's active
                // look (`bg-selected text-primary`) — indigo meter on the
                // accent-soft chip — not `destructive`. Red is for removing
                // something; a mic that's listening destroys nothing, and the
                // one red control in the composer should stay Stop. Hover is
                // pinned or the base rule would repaint it mid-recording.
                voiceRecording && 'bg-selected text-primary hover:bg-selected hover:text-primary',
                !voiceAvailable && !voiceRecording && 'opacity-40',
              )}
              // Wrapped, not passed bare: stopVoice takes an options object and
              // a bare handler would hand it the MouseEvent.
              onClick={voiceRecording ? () => stopVoice() : voiceAvailable ? startVoice : onOpenVoiceSettings}
              disabled={voiceConnecting}
              title={
                voiceRecording ? 'Stop recording'
                  : voiceConnecting ? 'Connecting…'
                    : voiceAvailable ? 'Voice input'
                      : `${voiceError || 'Voice input is not set up.'}\nClick to open Agent Voice settings.`
              }
              aria-label={voiceRecording ? 'Stop recording' : voiceAvailable ? 'Start voice input' : 'Voice input unavailable — open settings'}
            >
              {voiceRecording
                ? <VoiceBars volumeRef={voiceVolumeRef} isRecording={voiceRecording} />
                : <MicIcon size={15} />}
            </button>
            {working && !frozen && (
              <button
                type="button"
                className="flex size-[29px] items-center justify-center rounded-[9px] bg-foreground/80 text-background hover:bg-foreground"
                onClick={onStop}
                title="Stop"
                aria-label="Stop"
              ><StopIcon size={14} /></button>
            )}
            <button
              type="button"
              className="flex size-[29px] items-center justify-center rounded-[9px] bg-primary text-primary-foreground hover:bg-primary-hover disabled:pointer-events-none disabled:opacity-40"
              onClick={onSend}
              disabled={frozen || (!input.trim() && !partialText.trim() && attachments.length === 0) || !workspacePath}
              title={frozen ? frozenReason : working ? 'Send (steers the running response)' : 'Send'}
              aria-label="Send"
            ><PlayIcon size={14} /></button>
          </div>
        </div>
        </div>
      </div>
    </div>
  );
});

export default ChatSidebar;
