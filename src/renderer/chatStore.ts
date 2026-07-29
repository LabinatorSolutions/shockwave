// Per-chat state for the coding-agent sidebar, kept OUTSIDE the React tree.
//
// Why a module store: chats can run concurrently in main, and their events
// keep streaming whether or not the chat is on screen. Component state can't
// hold that — ChatSidebar remounts on workspace switch (key={workspacePath})
// and only ever shows one chat. So every chat's transcript, running flag,
// counters, and composer draft live here, keyed by chatId; the component
// renders the active entry via useSyncExternalStore and stays a pure view.
//
// Event flow: ONE window.api.agent.onEvent subscription (module-level, made on
// first use, never torn down). Main stamps every event with the chatId of
// the chat it came from; the reducer below routes it into that chat's entry —
// visible or not. Because the store receives every delta for every chat, the
// on-screen transcript is always just `chats[activeId].messages`: there is no
// merge with the DB on switch. The DB is only for cold loads (a chat not yet
// touched this app run) via openChat().
//
// Chat identity: NEW chats mint their chatId here (crypto.randomUUID) and
// main hands it to pi, so events are routable from the first millisecond.
//
// Immutability: state is replaced wholesale on every update (new object refs
// down the changed path) so useSyncExternalStore snapshots compare correctly
// and MessageRow's memo keeps untouched rows referentially stable.

type ChatEntry = {
  workspace: string | null;
  messages: any[];
  running: boolean;
  /** Steer messages queued into the running turn (from pi's queue_update). */
  queuedCount: number;
  tokens: number;
  /** Final elapsed of the last run; while running, derive from runStartAt. */
  elapsedMs: number;
  runStartAt: number; // 0 = not running
  error: string | null;
  title: string | null;
  starred: boolean;
  /** Chat exists in the DB (set on first send's shockwave_chat / on open).
   *  Gates star + rename, which need a stored row. */
  persisted: boolean;
  /** Server rows loaded (new chats are born hydrated — nothing stored yet). */
  hydrated: boolean;
  /** A re-read was wanted while a turn was in flight. Re-reading replaces the
   *  transcript, and the server only holds FINISHED messages — so doing it
   *  mid-turn deletes the running tool call and it never comes back. Deferred
   *  to agent_end instead. */
  pendingResync: boolean;
  /** Set to the hostname of ANOTHER machine while it runs this chat (from the
   *  server's running flag). Non-null = frozen: the composer is disabled and we
   *  hold a live-feed subscription until the turn ends. Null = free to send. */
  remoteMachine: string | null;
  draft: string;
  attachments: any[];
  // Streaming cursors (formerly refs in ChatSidebar).
  currentAssistantId: string | null;
  currentThinkingId: string | null;
  lastSentUserId: string | null;
};

type ChatStoreState = {
  chats: Record<string, ChatEntry>;
  /** Active chat per workspace — survives the sidebar's workspace-switch remount. */
  activeByWorkspace: Record<string, string>;
};

export const EMPTY_CHAT: ChatEntry = {
  workspace: null,
  messages: [],
  running: false,
  queuedCount: 0,
  tokens: 0,
  elapsedMs: 0,
  runStartAt: 0,
  error: null,
  title: null,
  starred: false,
  persisted: false,
  hydrated: false,
  pendingResync: false,
  remoteMachine: null,
  draft: '',
  attachments: [],
  currentAssistantId: null,
  currentThinkingId: null,
  lastSentUserId: null,
};

let state: ChatStoreState = { chats: {}, activeByWorkspace: {} };
const listeners = new Set<() => void>();

// This machine's name, cached once. Lets us tell "running on THIS machine" (my
// own turn — composer stays live) from "running elsewhere" (freeze + watch).
let myMachine: string | null = null;
window.api.app?.machineId?.().then((m: string) => { myMachine = m; }).catch(() => { /* best-effort */ });
let idCounter = 0;
const nextId = () => `m${++idCounter}`;

// agent_end is emitted BEFORE the runtime uploads the turn's last rows and the
// transcript, so a deferred re-read waits this long or it reads a tail that
// isn't stored yet.
const POST_TURN_RESYNC_MS = 1500;

// Pi message content is `string | [{type:'text', text}, ...]`. Non-text parts
// (images) have no transcript representation here and are dropped.
function textOfContent(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter((c) => c?.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('');
  }
  return '';
}

function emitChange() {
  for (const l of listeners) l();
}

export function subscribe(listener: () => void) {
  ensureSubscribed();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getState(): ChatStoreState {
  return state;
}

function patchChat(chatId: string, patch: Partial<ChatEntry> | ((c: ChatEntry) => Partial<ChatEntry>)) {
  const cur = state.chats[chatId] ?? EMPTY_CHAT;
  const p = typeof patch === 'function' ? patch(cur) : patch;
  state = { ...state, chats: { ...state.chats, [chatId]: { ...cur, ...p } } };
  emitChange();
}

// Append one message to a chat's transcript.
function appendMessage(chatId: string, message: any) {
  patchChat(chatId, (c) => ({ messages: [...c.messages, message] }));
}

// Replace the message with the given id (referentially — untouched rows keep
// their identity so MessageRow's memo holds).
function mapMessage(chatId: string, id: string, fn: (m: any) => any) {
  patchChat(chatId, (c) => ({ messages: c.messages.map((m) => (m.id === id ? fn(m) : m)) }));
}

// ---- Event routing (the old ChatSidebar.handleAgentEvent, per-chat) --------

function handleAgentEvent(evt: any) {
  const chatId = evt?.chatId;
  if (!evt?.type || !chatId) return;

  if (evt.type === 'agent_start') {
    // Every event carries the machine that produced it, so "running elsewhere"
    // is known from the stream itself — not from whether you happened to open
    // the chat mid-turn (which is all `openChat` could ever tell us).
    patchChat(chatId, {
      running: true, error: null, tokens: 0, elapsedMs: 0, runStartAt: Date.now(), currentThinkingId: null,
      remoteMachine: evt.machine && myMachine && evt.machine !== myMachine ? evt.machine : null,
    });
    return;
  }
  if (evt.type === 'agent_end') {
    // A turn finished. If it ran elsewhere, unfreeze — its rows and transcript
    // are uploaded, so this machine can take over on the next send.
    patchChat(chatId, (c) => ({
      running: false,
      remoteMachine: null,
      queuedCount: 0,
      currentAssistantId: null,
      currentThinkingId: null,
      elapsedMs: c.runStartAt ? Date.now() - c.runStartAt : c.elapsedMs,
      runStartAt: 0,
      // Freeze any still-open thinking block (guards a missing thinking_end).
      messages: c.messages.map((m) => (m.kind === 'thinking' && !m.done ? { ...m, done: true } : m)),
    }));
    // A re-read that arrived mid-turn was deferred (it would have deleted the
    // live stream) — run it now. Delayed, because the runtime uploads the last
    // rows + the transcript AFTER emitting agent_end; reading too early would
    // replace the stream with rows that don't include the turn's tail yet.
    if (state.chats[chatId]?.pendingResync) {
      patchChat(chatId, { pendingResync: false });
      setTimeout(() => { hydrateOnly(chatId).catch(() => { /* the stream already holds it */ }); }, POST_TURN_RESYNC_MS);
    }
    return;
  }
  if (evt.type === 'message_start') {
    // The ONLY event carrying a user prompt. `message_end` looks like the
    // natural hook and never fires for role 'user' — a user message is whole
    // the instant it starts, so pi has nothing to close (verified against the
    // live stream: message_start(user) arrives, message_end(user) never does).
    //
    // This never mattered while every turn started here: `sendToChat` draws
    // your bubble optimistically before the send. A turn started from Telegram
    // or cron has no optimistic append, so without this the transcript reads
    // assistant-reply → assistant-reply and your own message is invisible until
    // a full re-read.
    if (evt.message?.role !== 'user') return;
    const text = textOfContent(evt.message.content);
    if (!text) return;
    // Turn started HERE → `sendToChat` already drew the bubble. Keyed on the
    // event's origin machine, not on a per-send flag: `lastSentUserId` survives
    // a successful turn (only `agent_send_failed` clears it, since the splice
    // needs it), so a stale one from an earlier desktop send swallowed the next
    // Telegram message entirely.
    if (evt.machine && myMachine && evt.machine === myMachine) return;
    // Steering a REMOTE turn from this composer: the bubble is already drawn
    // locally, but the echo carries the other machine's name. Text is a fair
    // test here — a steer is plain text, never an attachment send.
    const last = state.chats[chatId]?.messages.at(-1);
    if (last?.kind === 'user' && last.text === text) return;
    appendMessage(chatId, { id: nextId(), kind: 'user', text });
    return;
  }
  if (evt.type === 'turn_end') {
    // Pi's normalized Usage — sum totalTokens across turns; each turn re-pays
    // for the context, so the sum matches actual billed usage for the run.
    const total = evt.message?.usage?.totalTokens;
    if (typeof total === 'number') patchChat(chatId, (c) => ({ tokens: c.tokens + total }));
    return;
  }
  if (evt.type === 'queue_update') {
    const queued = (evt.steering?.length ?? 0) + (evt.followUp?.length ?? 0);
    patchChat(chatId, { queuedCount: queued });
    return;
  }
  if (evt.type === 'message_update') {
    const inner = evt.assistantMessageEvent;
    if (!inner) return;
    const chat = state.chats[chatId] ?? EMPTY_CHAT;
    if (inner.type === 'thinking_start') {
      const id = nextId();
      patchChat(chatId, (c) => ({
        currentThinkingId: id,
        currentAssistantId: null,
        messages: [...c.messages, { id, kind: 'thinking', text: '', done: false }],
      }));
      return;
    }
    if (inner.type === 'thinking_delta') {
      const delta = inner.delta ?? '';
      const id = chat.currentThinkingId;
      if (!id) {
        const newId = nextId();
        patchChat(chatId, (c) => ({
          currentThinkingId: newId,
          messages: [...c.messages, { id: newId, kind: 'thinking', text: delta, done: false }],
        }));
        return;
      }
      mapMessage(chatId, id, (m) => ({ ...m, text: m.text + delta }));
      return;
    }
    if (inner.type === 'thinking_end') {
      const id = chat.currentThinkingId;
      patchChat(chatId, { currentThinkingId: null });
      if (id) mapMessage(chatId, id, (m) => ({ ...m, done: true }));
      return;
    }
    if (inner.type === 'text_start') {
      const id = nextId();
      patchChat(chatId, (c) => ({
        currentAssistantId: id,
        messages: [...c.messages, { id, kind: 'assistant', text: '' }],
      }));
      return;
    }
    if (inner.type === 'text_delta') {
      const id = chat.currentAssistantId;
      if (!id) {
        const newId = nextId();
        patchChat(chatId, (c) => ({
          currentAssistantId: newId,
          messages: [...c.messages, { id: newId, kind: 'assistant', text: inner.delta ?? '' }],
        }));
        return;
      }
      mapMessage(chatId, id, (m) => ({ ...m, text: m.text + (inner.delta ?? '') }));
      return;
    }
    return;
  }
  if (evt.type === 'tool_execution_start') {
    patchChat(chatId, (c) => ({
      currentAssistantId: null,
      currentThinkingId: null,
      messages: [...c.messages, {
        id: nextId(),
        kind: 'tool',
        toolCallId: evt.toolCallId,
        toolName: evt.toolName,
        args: evt.args,
        output: '',
        isError: false,
        done: false,
      }],
    }));
    return;
  }
  if (evt.type === 'tool_execution_update') {
    patchChat(chatId, (c) => ({
      messages: c.messages.map((m) => (
        m.kind === 'tool' && m.toolCallId === evt.toolCallId
          ? { ...m, output: formatToolResult(evt.partialResult) }
          : m
      )),
    }));
    return;
  }
  if (evt.type === 'tool_execution_end') {
    patchChat(chatId, (c) => ({
      messages: c.messages.map((m) => (
        m.kind === 'tool' && m.toolCallId === evt.toolCallId
          ? { ...m, output: formatToolResult(evt.result), isError: !!evt.isError, done: true }
          : m
      )),
    }));
    return;
  }
  if (evt.type === 'shockwave_chat') {
    // Emitted at the start of every turn, wherever it runs. For a chat this app
    // has never seen — a Telegram or cron run — it's the first we hear of it, so
    // load it: without that it would render as a bare tail with no workspace and
    // never appear in the sidebar.
    patchChat(chatId, { persisted: true, title: evt.title ?? null, starred: !!evt.starred });
    if (!state.chats[chatId]?.hydrated) discover(chatId);
    return;
  }
  if (evt.type === 'shockwave_chat_titled') {
    patchChat(chatId, { title: evt.title ?? null });
    return;
  }
  if (evt.type === 'agent_send_failed') {
    // Main popped the bad user+failure pair from pi state; mirror by removing
    // the matching user message and surfacing the provider error.
    patchChat(chatId, (c) => ({
      messages: c.lastSentUserId ? c.messages.filter((m) => m.id !== c.lastSentUserId) : c.messages,
      lastSentUserId: null,
      error: evt.errorMessage ?? 'Send failed.',
    }));
    return;
  }
}

let subscribed = false;
function ensureSubscribed() {
  if (subscribed || typeof window === 'undefined' || !(window as any).api?.agent) return;
  subscribed = true;
  window.api.agent.onEvent((evt: any) => handleAgentEvent(evt));
  window.api.agent.onError(({ chatId, message }: any) => {
    if (!chatId) return;
    patchChat(chatId, { running: false, runStartAt: 0, error: message });
  });
  // After a window reload, chats may still be mid-turn in main — reseed their
  // running flags so the dropdown spinner and Working indicator are truthful.
  window.api.agent.runningChats?.().then((ids: string[]) => {
    for (const id of ids ?? []) patchChat(id, { running: true, runStartAt: Date.now() });
  }).catch(() => { /* best-effort */ });
  // The live feed carries every chat's events, including chats running on the
  // companion or another machine. If it drops, we miss whatever happened while
  // it was down — so re-read on reconnect.
  window.api.chat?.onFeedResync?.(() => resyncAll());
}

// ---- Pi tool-result flattening (shared with ChatSidebar's rendering) --------

// Pi tool results are shaped { content: [{type:'text', text}, ...], details? }.
// Concat text items; ignore non-text (images). Fall back to JSON for unknowns.
export function formatToolResult(result: any): string {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  if (typeof result === 'object') {
    if (Array.isArray(result.content)) {
      return result.content
        .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text)
        .join('');
    }
    if (typeof result.output === 'string') return result.output;
    if (typeof result.text === 'string') return result.text;
    try { return JSON.stringify(result, null, 2); } catch { return String(result); }
  }
  return String(result);
}

// Rebuild the UI transcript from stored DB message rows (chat:open).
// The DB keeps one row per pi message: an assistant turn carries its text +
// thinking + tool CALLS (tool_calls JSON); each tool RESULT is its own role='tool'
// row. We re-pair them here into the sidebar's flat kind-tagged model, absorbing
// each result into the tool row created from the matching call (by tool_call_id).
// Order within an assistant turn: thinking → text → tool calls. (isError isn't
// persisted, so hydrated tool rows render as non-error; images degrade to text.)
function hydrateMessages(rows: any[]) {
  const results = new Map();
  for (const r of rows) {
    if (r.role === 'tool' && r.toolCallId) results.set(r.toolCallId, r.content ?? '');
  }
  const out: any[] = [];
  for (const r of rows) {
    if (r.role === 'user') {
      out.push({ id: `h${r.seq}`, kind: 'user', text: r.content ?? '' });
    } else if (r.role === 'assistant') {
      if (r.reasoning) out.push({ id: `h${r.seq}-k`, kind: 'thinking', text: r.reasoning, done: true });
      if (r.content) out.push({ id: `h${r.seq}-t`, kind: 'assistant', text: r.content });
      if (r.toolCalls) {
        let calls: any[] = [];
        try { calls = JSON.parse(r.toolCalls) || []; } catch { /* corrupt row → skip its tools */ }
        calls.forEach((c, i) => {
          out.push({
            id: `h${r.seq}-c${i}`,
            kind: 'tool',
            toolCallId: c.id,
            toolName: c.name,
            args: c.arguments,
            output: results.get(c.id) ?? '',
            isError: false,
            done: true,
          });
        });
      }
    }
  }
  return out;
}

// ---- Actions (called by ChatSidebar) ----------------------------------------

/** Mint a fresh chat for the workspace and make it active. */
export function newChat(workspace: string | null): string {
  const id = crypto.randomUUID();
  state = {
    chats: { ...state.chats, [id]: { ...EMPTY_CHAT, workspace, hydrated: true } },
    activeByWorkspace: workspace ? { ...state.activeByWorkspace, [workspace]: id } : state.activeByWorkspace,
  };
  emitChange();
  return id;
}

// Load a chat we've just heard about from the live feed. Guarded so a burst of
// events for one unknown chat triggers a single load.
const discovering = new Set<string>();
function discover(chatId: string) {
  if (discovering.has(chatId)) return;
  discovering.add(chatId);
  hydrateOnly(chatId).catch(() => { /* next event retries */ }).finally(() => discovering.delete(chatId));
}

/** Load a chat's stored rows WITHOUT making it active (feed discovery, reconnect
 *  repair). Replaces messages — every message is stored as it happens, so the
 *  rows are the whole chat and appending a streamed tail would double them. */
export async function hydrateOnly(chatId: string) {
  // Mid-turn this would replace the live stream with rows that don't include
  // the running tool call — the call is deleted and nothing brings it back.
  // Defer to agent_end.
  if (state.chats[chatId]?.running) { patchChat(chatId, { pendingResync: true }); return; }
  const { chat: row, messages: rows, workspacePath } = await window.api.chat.open(chatId);
  if (!row) return;
  patchChat(chatId, (c) => ({
    workspace: c.workspace ?? workspacePath ?? null,
    hydrated: true,
    persisted: true,
    title: row.title ?? c.title,
    starred: !!row.starred,
    messages: hydrateMessages(rows || []),
    currentAssistantId: null,
    currentThinkingId: null,
  }));
}

/** The live feed dropped and came back: anything that happened while it was down
 *  was missed. Re-read every loaded chat — replace, so this is idempotent. */
export function resyncAll() {
  for (const [id, c] of Object.entries(state.chats)) {
    if (c.hydrated && c.persisted) hydrateOnly(id).catch(() => { /* best-effort */ });
  }
}

/** Active chat for a workspace, creating a fresh one if none. */
export function ensureActiveChat(workspace: string | null): string {
  const existing = workspace ? state.activeByWorkspace[workspace] : null;
  if (existing && state.chats[existing]) return existing;
  return newChat(workspace);
}

/** Open a saved chat: (re)load it from the server, then make it active.
 *
 *  This ALWAYS re-reads. It used to skip the fetch whenever the chat was already
 *  loaded, which meant a chat you'd looked at once was frozen for the life of
 *  the app — every later Telegram or cron message was invisible until restart.
 *  The server is the source of truth; the store is a view of it. */
export async function openChat(chatId: string, workspace: string | null) {
  const existing = state.chats[chatId];
  let ws = workspace ?? existing?.workspace ?? null;
  const { chat: row, messages: rows, workspacePath } = await window.api.chat.open(chatId);
  // Right after app start the sidebar's workspacePath prop can still be null,
  // and a chat discovered from the live feed has no local path at all — main
  // resolves it from the row's workspace id.
  ws = ws ?? workspacePath ?? null;
  // Running elsewhere? Freeze the composer (running on THIS machine is my own
  // turn, not frozen). The live feed is always on, so there's nothing to
  // subscribe to — the events are already arriving.
  const remote = row?.running && row.runningMachine && row.runningMachine !== myMachine
    ? row.runningMachine : null;
  // A turn in flight owns the on-screen transcript. Replacing it here is what
  // deleted the running tool call whenever you clicked into a chat mid-turn:
  // the server only holds FINISHED messages, so the read can't return what is
  // still running, and nothing re-read afterwards. Take the metadata, leave the
  // messages, and reconcile at agent_end.
  const live = state.chats[chatId]?.running || !!remote;
  patchChat(chatId, (c) => ({
    workspace: ws,
    hydrated: true,
    persisted: !!row || c.persisted,
    title: row?.title ?? c.title,
    starred: !!(row?.starred ?? c.starred),
    remoteMachine: remote ?? c.remoteMachine,
    ...(live ? { pendingResync: true } : {
      // REPLACE, never concat: every message is persisted as it happens, so the
      // stored rows are the whole chat. Appending a streamed tail on top would
      // double every message the feed already delivered.
      messages: hydrateMessages(rows || []),
      currentAssistantId: null,
      currentThinkingId: null,
    }),
  }));
  if (ws) {
    state = { ...state, activeByWorkspace: { ...state.activeByWorkspace, [ws]: chatId } };
    emitChange();
  }
}


/** Send (or steer, if the chat is mid-turn — main decides) a message. */
export async function sendToChat(chatId: string, { text, promptText, images, attachments }: {
  text: string; promptText: string; images: any[]; attachments: any[];
}) {
  const userId = nextId();
  patchChat(chatId, (c) => ({
    error: null,
    lastSentUserId: userId,
    // Optimistic running — agent_start confirms ~immediately; for a steer the
    // chat is already running.
    running: true,
    runStartAt: c.runStartAt || Date.now(),
    messages: [...c.messages, { id: userId, kind: 'user', text, attachments }],
  }));
  try {
    await window.api.agent.send({ chatId, text: promptText, images: images.length ? images : undefined });
  } catch (err: any) {
    patchChat(chatId, { running: false, runStartAt: 0, error: err?.message ?? String(err) });
  }
}

export async function abortChat(chatId: string) {
  try { await window.api.agent.abort(chatId); } catch { /* abort is best-effort */ }
}

/** Chat deleted (history popover) — drop local state; main already disposed. */
export function removeChat(chatId: string) {
  if (!state.chats[chatId]) return;
  const chats = { ...state.chats };
  delete chats[chatId];
  const activeByWorkspace = { ...state.activeByWorkspace };
  for (const [ws, id] of Object.entries(activeByWorkspace)) {
    if (id === chatId) delete activeByWorkspace[ws];
  }
  state = { chats, activeByWorkspace };
  emitChange();
}

export function setDraft(chatId: string, draft: string) {
  patchChat(chatId, { draft });
}

export function setAttachments(chatId: string, updater: (prev: any[]) => any[]) {
  patchChat(chatId, (c) => ({ attachments: updater(c.attachments) }));
}

export function setError(chatId: string, error: string | null) {
  patchChat(chatId, { error });
}

export function setTitle(chatId: string, title: string | null) {
  patchChat(chatId, { title });
}

export function setStarred(chatId: string, starred: boolean) {
  patchChat(chatId, { starred });
}

// Dev-only introspection for CDP-driven debugging (see electron-dev skill).
if (typeof window !== 'undefined' && (import.meta as any).env?.DEV) {
  (window as any).__chatStore = { getState, openChat, newChat, ensureActiveChat };
}
