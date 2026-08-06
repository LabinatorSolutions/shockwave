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
  pinned: boolean;
  /** Chat exists in the DB (set on first send's shockwave_chat / on open).
   *  Gates pin + rename, which need a stored row. */
  persisted: boolean;
  /** Server rows loaded (new chats are born hydrated — nothing stored yet). */
  hydrated: boolean;
  /** A re-read was wanted while a turn was in flight. Re-reading replaces the
   *  transcript, and the server only holds FINISHED messages — so doing it
   *  mid-turn deletes the running tool call and it never comes back. Deferred
   *  to agent_end instead. */
  pendingResync: boolean;
  /** The machine whose turn this is, as stamped on the events (or read off the
   *  server row). Null = nothing in flight that we know of.
   *
   *  Stored RAW — whether it's someone else's machine is derived by
   *  `remoteMachineOf`, never frozen in here. `myMachine` is resolved over IPC
   *  at startup, so a turn whose first event beat that answer would have been
   *  labelled local for the rest of its life. */
  runMachine: string | null;
  draft: string;
  attachments: any[];
  // Streaming cursors (formerly refs in ChatSidebar).
  currentAssistantId: string | null;
  currentThinkingId: string | null;
  /** The bubbles belonging to the assistant message currently streaming, so
   *  `message_end` can reconcile them whatever else nulled the cursors first
   *  (pi's ordering of `tool_execution_start` vs `message_end` is not ours to
   *  assume). Cleared at `message_end`. */
  msgAssistantId: string | null;
  msgThinkingId: string | null;
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
  pinned: false,
  persisted: false,
  hydrated: false,
  pendingResync: false,
  runMachine: null,
  draft: '',
  attachments: [],
  currentAssistantId: null,
  currentThinkingId: null,
  msgAssistantId: null,
  msgThinkingId: null,
  lastSentUserId: null,
};

let state: ChatStoreState = { chats: {}, activeByWorkspace: {} };
const listeners = new Set<() => void>();

// This machine's name, cached once. Lets us tell "running on THIS machine" (my
// own turn — composer stays live) from "running elsewhere" (freeze + watch).
let myMachine: string | null = null;
window.api.app?.machineId?.().then((m: string) => { myMachine = m; emitChange(); }).catch(() => { /* best-effort */ });

// Is the companion reachable right now? Main's live feed IS the reachability
// signal (see "Connection state" in `src/main/CLAUDE.md`); this mirrors it so
// `isWorking` can ask whether the channel carrying a remote turn's events is
// still alive. Seeded true so the first paint isn't a flash of "disconnected"
// before main answers — the same reasoning as `App.tsx`'s own copy.
let companionOnline = true;
let idCounter = 0;
const nextId = () => `m${++idCounter}`;

/** Another machine is running this chat → freeze the composer.
 *
 *  DERIVED on every read, never stored: `myMachine` arrives asynchronously, so
 *  a comparison made once at `agent_start` can be permanently wrong for any
 *  turn whose first event won that race. */
export function remoteMachineOf(c: ChatEntry): string | null {
  return c.runMachine && myMachine && c.runMachine !== myMachine ? c.runMachine : null;
}

/** Is this chat working RIGHT NOW — as far as we can honestly tell?
 *
 *  Two facts, ANDed, and neither of them stored as "working":
 *
 *  1. Something says a turn is in flight (`running`).
 *  2. The channel that claim came down is still alive.
 *
 *  A turn on THIS machine reports over IPC, which is alive for as long as the
 *  app is, so (2) is free. A turn on the companion or another machine reports
 *  over the live feed — and a dead feed means we know NOTHING about that turn,
 *  which must not render as "Working".
 *
 *  That distinction is the whole bug this replaced. `running` was set by
 *  `agent_start` and cleared only by `agent_end`, so losing one terminal event
 *  — a feed that died silently, a companion restarted mid-run — left the
 *  spinner counting upward forever. Worse, the stale flag then BLOCKED the
 *  re-read that would have corrected it (see `hydrateOnly`), so nothing short
 *  of restarting the app could clear it. Deriving the answer means there is no
 *  stored flag left to get stuck. */
export function isWorking(c: ChatEntry): boolean {
  if (!c.running) return false;
  return remoteMachineOf(c) ? companionOnline : true;
}

// Pi message content is `string | [{type:'text', text}, ...]`. Non-text parts
// (images) have no transcript representation here and are dropped.
//
// This MUST stay identical to `textOf` in `agent-core/agent.ts` — that one builds
// the stored row, this one builds the bubble, and `message_end` below makes the
// two equal by running the same join over the same object. Same parity discipline
// as `linkParser.ts` vs `linkIndex.ts`.
function textOfContent(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter((c) => c?.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('');
  }
  return '';
}
// Mirror of `thinkingOf` in `agent-core/agent.ts` — the row's `reasoning`.
function thinkingOfContent(content: any): string | null {
  if (!Array.isArray(content)) return null;
  const t = content.filter((c) => c?.type === 'thinking' && typeof c.thinking === 'string').map((c) => c.thinking).join('');
  return t || null;
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
    // the chat mid-turn (which is all `openChat` could ever tell us). Kept raw;
    // `remoteMachineOf` does the comparison at read time.
    patchChat(chatId, {
      running: true, error: null, tokens: 0, elapsedMs: 0, runStartAt: Date.now(), currentThinkingId: null,
      runMachine: evt.machine ?? myMachine ?? null,
    });
    return;
  }
  if (evt.type === 'agent_end') {
    // A turn finished. If it ran elsewhere, unfreeze — its rows and transcript
    // are uploaded, so this machine can take over on the next send.
    patchChat(chatId, (c) => ({
      running: false,
      runMachine: null,
      queuedCount: 0,
      currentAssistantId: null,
      currentThinkingId: null,
      msgAssistantId: null,
      msgThinkingId: null,
      elapsedMs: c.runStartAt ? Date.now() - c.runStartAt : c.elapsedMs,
      runStartAt: 0,
      // Freeze any still-open thinking block (guards a missing thinking_end).
      messages: c.messages.map((m) => (m.kind === 'thinking' && !m.done ? { ...m, done: true } : m)),
    }));
    return;
  }
  if (evt.type === 'shockwave_turn_stored') {
    // The runtime finished uploading the turn's rows + transcript. A re-read
    // deferred during the turn can run now — and only now: agent_end fires
    // BEFORE those uploads, so reading on it would pull a tail that isn't
    // stored yet and wipe good streamed content.
    if (!state.chats[chatId]?.pendingResync) return;
    patchChat(chatId, { pendingResync: false });
    hydrateOnly(chatId).catch(() => { /* the stream already holds it */ });
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
    //
    // This is exhaustive, not a heuristic: the composer is disabled for the
    // whole of a remote turn (`frozen` in ChatSidebar), so a message can never
    // be drawn locally AND come back stamped with another machine's name.
    if (evt.machine && myMachine && evt.machine === myMachine) return;
    appendMessage(chatId, { id: nextId(), kind: 'user', text });
    return;
  }
  if (evt.type === 'message_end') {
    // The finished message, taken whole — NOT our running sum of deltas.
    //
    // pi persists THIS OBJECT (`sessionManager.appendMessage(event.message)`),
    // and agent-core derives the stored row's `content`/`reasoning` from it with
    // the same joins used here. Assigning from it therefore makes the bubble
    // equal to the row BY CONSTRUCTION — the live view and a later re-read can't
    // drift, whatever happened to the delta stream in between. Accumulating is
    // how you render; the message is what you keep.
    if (evt.message?.role !== 'assistant') return;
    const text = textOfContent(evt.message.content);
    const reasoning = thinkingOfContent(evt.message.content);
    patchChat(chatId, (c) => {
      let messages = c.messages;
      let assistantId = c.msgAssistantId;
      // Text that never streamed a delta has no bubble yet; open one so the
      // equality above holds for it too rather than nearly holding.
      if (!assistantId && text) {
        assistantId = nextId();
        messages = [...messages, { id: assistantId, kind: 'assistant', text: '' }];
      }
      return {
        messages: messages.map((m) => {
          if (m.id === assistantId) return { ...m, text };
          if (m.id === c.msgThinkingId) return { ...m, text: reasoning ?? m.text, done: true };
          return m;
        }),
        currentAssistantId: null,
        currentThinkingId: null,
        msgAssistantId: null,
        msgThinkingId: null,
      };
    });
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
    // A CONTENT-BLOCK boundary is not a message boundary. `*_start` fires per
    // block, and how often a provider opens one is its own habit: pi-ai's
    // google-generative-ai/google-vertex adapters open a fresh block on every
    // thinking↔text flip, mistral-conversations on every flip AND after every
    // tool call, anthropic-messages occasionally, openai-completions never. The
    // stored row joins ALL of a message's text blocks into one string (and all
    // its thinking into one `reasoning`), so opening a bubble per block splits
    // one message across two — the split landing mid-word wherever the block
    // boundary fell. So: one thinking bubble and one text bubble per message,
    // matching what `hydrateMessages` renders from the row.
    if (inner.type === 'thinking_start') {
      if (chat.msgThinkingId) {
        const id = chat.msgThinkingId;
        patchChat(chatId, (c) => ({
          currentThinkingId: id,
          messages: c.messages.map((m) => (m.id === id ? { ...m, done: false } : m)),
        }));
        return;
      }
      const id = nextId();
      patchChat(chatId, (c) => ({
        currentThinkingId: id,
        msgThinkingId: id,
        messages: [...c.messages, { id, kind: 'thinking', text: '', done: false }],
      }));
      return;
    }
    if (inner.type === 'thinking_delta') {
      const delta = inner.delta ?? '';
      const id = chat.currentThinkingId ?? chat.msgThinkingId;
      if (!id) {
        const newId = nextId();
        patchChat(chatId, (c) => ({
          currentThinkingId: newId,
          msgThinkingId: newId,
          messages: [...c.messages, { id: newId, kind: 'thinking', text: delta, done: false }],
        }));
        return;
      }
      mapMessage(chatId, id, (m) => ({ ...m, text: m.text + delta }));
      return;
    }
    if (inner.type === 'thinking_end') {
      // Closes the BLOCK, not the message — `msgThinkingId` deliberately stays,
      // so a later flip back to thinking reopens this bubble instead of a new one.
      const id = chat.currentThinkingId;
      patchChat(chatId, { currentThinkingId: null });
      if (id) mapMessage(chatId, id, (m) => ({ ...m, done: true }));
      return;
    }
    if (inner.type === 'text_start') {
      if (chat.msgAssistantId) {
        patchChat(chatId, { currentAssistantId: chat.msgAssistantId });
        return;
      }
      const id = nextId();
      patchChat(chatId, (c) => ({
        currentAssistantId: id,
        msgAssistantId: id,
        messages: [...c.messages, { id, kind: 'assistant', text: '' }],
      }));
      return;
    }
    if (inner.type === 'text_delta') {
      const id = chat.currentAssistantId ?? chat.msgAssistantId;
      if (!id) {
        const newId = nextId();
        patchChat(chatId, (c) => ({
          currentAssistantId: newId,
          msgAssistantId: newId,
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
    patchChat(chatId, { persisted: true, title: evt.title ?? null, pinned: !!evt.pinned });
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
    //
    // This ENDS the turn, so it clears the run state too. It didn't, and only
    // got away with it because pi happens to emit `agent_end` alongside — a
    // second event doing the load-bearing work. Any failure that skipped it
    // left the spinner running next to the error explaining why it shouldn't be.
    patchChat(chatId, (c) => ({
      messages: c.lastSentUserId ? c.messages.filter((m) => m.id !== c.lastSentUserId) : c.messages,
      lastSentUserId: null,
      running: false,
      runMachine: null,
      runStartAt: 0,
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
    patchChat(chatId, { running: false, runMachine: null, runStartAt: 0, error: message });
  });
  // After a window reload, chats may still be mid-turn in main — reseed their
  // running flags so the dropdown spinner and Working indicator are truthful.
  // These are BY DEFINITION local (main is running them), so they are stamped
  // with this machine and never gated on the feed.
  window.api.agent.runningChats?.().then((ids: string[]) => {
    for (const id of ids ?? []) patchChat(id, { running: true, runStartAt: Date.now(), runMachine: myMachine });
  }).catch(() => { /* best-effort */ });
  // Companion reachability, mirrored from main's one signal. A remote turn's
  // events only exist while this is true, so `isWorking` reads it — and every
  // change has to re-render, since it is an input to what the spinner shows.
  window.api.settings?.companionState?.().then((s: any) => {
    companionOnline = !!s?.online; emitChange();
  }).catch(() => { /* best-effort — the push below is the durable source */ });
  window.api.settings?.onCompanionState?.(({ online }: any) => {
    companionOnline = !!online; emitChange();
  });
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
// A stored message's images, in the shape `AttachmentChip` renders. `url` (not
// `dataUrl`) is what separates these from the composer's freshly-picked files,
// which still carry their bytes in memory until the send round-trips.
function attachmentsOf(row: any) {
  if (!Array.isArray(row?.attachments) || !row.attachments.length) return undefined;
  return row.attachments.map((a: any, i: number) => ({
    id: a.id,
    kind: 'image',
    name: `image ${i + 1}`,
    mimeType: a.mimeType,
    url: `app://attachment/${encodeURIComponent(a.id)}`,
  }));
}

function hydrateMessages(rows: any[]) {
  const results = new Map();
  for (const r of rows) {
    if (r.role === 'tool' && r.toolCallId) results.set(r.toolCallId, r.content ?? '');
  }
  const out: any[] = [];
  for (const r of rows) {
    if (r.role === 'user') {
      // Stored images come back as ids, not bytes — the chip resolves each one
      // through `app://attachment/<id>`, so a chat open costs nothing extra and
      // only the pictures actually on screen are fetched.
      out.push({ id: `h${r.seq}`, kind: 'user', text: r.content ?? '', attachments: attachmentsOf(r) });
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
  const cur = state.chats[chatId];
  // A turn running on THIS machine owns the screen: it is streaming into the
  // transcript right now and the server holds only FINISHED messages, so a
  // replace would delete the tool call still in flight. Defer to agent_end.
  //
  // The guard is deliberately narrow — running *here*, not running at all. It
  // used to cover both, which meant a stale flag blocked the one read that
  // could have cleared it: the reconnect repair bailed at the door and the
  // chat stayed "Working" until the app was restarted. A flag that can veto
  // its own correction isn't a cache, it's a lock.
  if (cur?.running && !remoteMachineOf(cur)) { patchChat(chatId, { pendingResync: true }); return; }
  const { chat: row, messages: rows, workspacePath } = await window.api.chat.open(chatId);
  if (!row) return;
  patchChat(chatId, (c) => ({ ...applyRunState(c, row), ...applyRow(c, row, rows, workspacePath ?? null) }));
}

/** What the server row says about execution, which for anything not running on
 *  this machine outranks whatever our events left behind.
 *
 *  The rule that makes this safe to trust: the machine doing the work clears
 *  `running` only AFTER it has uploaded the turn's rows and transcript (see
 *  `setRunning` in `api/src/store.ts`). So `running: false` doesn't mean "the
 *  agent stopped talking" — it means "finished AND stored", i.e. everything
 *  worth showing is in the rows we just read. Nothing on screen can be lost by
 *  believing it. */
function applyRunState(c: ChatEntry, row: any): Partial<ChatEntry> {
  const machine = row?.running ? (row.runningMachine ?? null) : null;
  // Running on this machine is our own business — main and the store already
  // agree about it, and the row lags by a round trip. Leave it alone.
  if (c.running && !remoteMachineOf(c)) return {};
  if (!machine || (myMachine && machine === myMachine)) {
    return { running: false, runMachine: null, runStartAt: 0 };
  }
  // Still going elsewhere. The row carries no start time, so keep ours if we
  // have one rather than resetting the clock on every reconnect.
  return { running: true, runMachine: machine, runStartAt: c.runStartAt || Date.now() };
}

/** The stored rows, applied — unless a turn is still in flight elsewhere, in
 *  which case the live transcript stays and the re-read is deferred to
 *  `shockwave_turn_stored` (the server has only its finished half). */
function applyRow(c: ChatEntry, row: any, rows: any[], workspacePath: string | null): Partial<ChatEntry> {
  const base = {
    workspace: c.workspace ?? workspacePath ?? null,
    hydrated: true,
    persisted: true,
    title: row?.title ?? c.title,
    // A row that exists is authoritative about its own pin; no row at all (a
    // chat with nothing stored yet) can't speak to it, so keep what we have.
    pinned: row ? !!row.pinned : c.pinned,
  };
  const live = (c.running && !remoteMachineOf(c)) || !!(row?.running && row.runningMachine && row.runningMachine !== myMachine);
  if (live) return { ...base, pendingResync: true };
  return {
    ...base,
    messages: hydrateMessages(rows || []),
    currentAssistantId: null,
    currentThinkingId: null,
    msgAssistantId: null,
    msgThinkingId: null,
  };
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
  // Same two rules `hydrateOnly` uses, for the same reasons: the row decides
  // what is running anywhere but here (`applyRunState`), and a turn in flight
  // keeps the on-screen transcript (`applyRow`) because the server holds only
  // its finished half. Opening a chat is a re-read like any other — it must not
  // grow its own answer to either question.
  //
  // REPLACE, never concat: every message is persisted as it happens, so the
  // stored rows are the whole chat. Appending a streamed tail on top would
  // double every message the feed already delivered.
  patchChat(chatId, (c) => ({
    ...applyRunState(c, row),
    ...applyRow(c, row, rows, ws),
    workspace: ws,
    persisted: !!row || c.persisted,
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
    // chat is already running. Stamped with THIS machine, because that is what
    // it is: a turn we are about to host, reporting over IPC.
    running: true,
    runMachine: myMachine,
    runStartAt: c.runStartAt || Date.now(),
    messages: [...c.messages, { id: userId, kind: 'user', text, attachments }],
  }));
  try {
    await window.api.agent.send({ chatId, text: promptText, images: images.length ? images : undefined });
  } catch (err: any) {
    patchChat(chatId, { running: false, runMachine: null, runStartAt: 0, error: err?.message ?? String(err) });
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

export function setPinned(chatId: string, pinned: boolean) {
  patchChat(chatId, { pinned });
}

// Dev-only introspection for CDP-driven debugging (see electron-dev skill).
if (typeof window !== 'undefined' && (import.meta as any).env?.DEV) {
  (window as any).__chatStore = { getState, openChat, newChat, ensureActiveChat };
}
