// The shared coding-agent runtime. One live pi AgentSession per chat, kept in a
// map keyed by chatId. This is ALL the turn logic — booting/resuming a
// session, running or steering a turn, the pi→row mapping, the upload-then-
// clear-running ordering, resume-from-transcript, and auto-title — with every
// host-specific bit of I/O injected via `AgentHost`. The desktop and the
// companion each build a host and call `createAgentRuntime(host)`; the logic is
// this one copy, so a change lands in both.
//
// What is NOT here (host's job, pure I/O): where events go (`emit`, per call so
// the desktop can follow window reloads), where rows/transcripts are stored,
// where secrets/tokens come from, pi's scratch-dir root (`dataDir`, per session
// so the server can isolate concurrent runs), and any host-only tool.

import { join } from 'node:path';
import fs from 'node:fs';
import { createAgentSession, AuthStorage, ModelRegistry, SessionManager, DefaultResourceLoader } from '@earendil-works/pi-coding-agent';
import { getModel, getModels, completeSimple } from '@earendil-works/pi-ai/compat';
import { getCatalogModel } from './modelCatalog.js';
import { agentDirFor, agentSkillsDir, ensureDirs, listBuiltinSkills, listWorkspaceSkills, workspaceSkillsDir, computeEffectivePaths, writePiSettings } from './skillLibrary.js';
import { assembleSystemPrompt, rebuildSystemPrompt } from './defaults/index.js';
import { activeToolNames } from './defaults/tools.js';
import { makeAgentTokenTools } from './agentTokens.js';
import { makeTranscribeTool } from './transcribe.js';
import { makeDailyNoteTool } from './dailyNoteTool.js';
import { makeSkillTools } from './skillTool.js';
import { makeChatSearchTool, type ChatSearchHost } from './chatSearch.js';
import { imagesOf } from './messageImages.js';

export type Emit = (event: any) => void;

// One pi session ENTRY → one stored row. Tool CALLS ride on the assistant row
// (`toolCalls` JSON); each tool RESULT is a `role:'tool'` row.
//
// `entryId` is pi's own SessionEntry.id — the row's identity, stable and unique
// for the life of the chat. There is deliberately no `seq` here: ordering is the
// server's to assign. Rows used to be numbered by their index in pi's live
// message array, which is the RESOLVED LLM context — it shrinks on compaction,
// rewinds on branching, and gets spliced on a failed turn, so an index is not an
// identity and reusing one silently dropped real messages.
export interface ChatRow {
  entryId: string; parentId: string | null;
  role: string; content: string | null; reasoning: string | null;
  toolCalls: string | null; toolCallId: string | null; toolName: string | null; createdAt: number;
  /**
   * Images the user sent with this message, base64. Kept on the row so the ONE
   * append that stores a message also stores its pictures — both hosts hand
   * images to pi the same way, so desktop and Telegram are covered by this alone.
   * `content` is text-only by design (it feeds the search tsvector), so without
   * this the image had nowhere to go and was dropped.
   */
  images?: { mimeType: string; data: string }[];
}

// Everything host-specific. All I/O; no logic.
export interface AgentHost {
  builtinDir: string;                       // bundled built-in skills
  machine: string;                          // running_machine / provenance stamp
  extraTools: any[];                        // host-only tools (desktop: [open_file]; server: [])
  dataDir(chatId: string): string;       // pi scratch-dir root; per-session so the server can isolate runs
  /**
   * The AGENT's own directory for this chat — working files, downloads, anything
   * it is producing to send rather than to keep, and (on the companion) the files
   * the user sent it. Named in the system prompt, so it must be a real path.
   *
   * Deliberately not `dataDir`: that one is pi's working memory (its settings and
   * session log), and mixing the agent's files into it makes the two
   * indistinguishable to anything walking the tree.
   */
  scratchDir(chatId: string): string;
  /** Speech-to-text config for the `transcribe` tool — `settings.transcription`. */
  getTranscription(): Promise<{ provider?: string; apiKey?: string }>;
  // persistence — dumb I/O; the core does the mapping/ordering:
  getChat(id: string): Promise<any | null>;
  upsertChat(row: { chatId: string; workspaceId: string; systemPrompt?: string | null; model?: string | null; source?: string | null; sourceId?: string | null; machine?: string | null }): Promise<void>;
  /** Append rows in order. MUST be idempotent by `entryId`; assigns ordering itself. */
  appendMessages(id: string, rows: ChatRow[]): Promise<number>;
  setChatTitle(id: string, title: string): Promise<void>;
  setRunning(id: string, machine: string | null): Promise<void>;
  getTranscript(id: string): Promise<string | null>;
  /** Store pi's session file; returns the new `transcriptUpdatedAt` version. */
  putTranscript(id: string, content: string): Promise<number | void>;
  // secrets for the agent-tokens tools:
  getAgentSecrets(): Promise<any[]>;
  getToken(name: string): Promise<string>;
  /** Surface a non-fatal persistence problem (transcript upload). Optional. */
  onError?(chatId: string, message: string): void;
  /** Backs the `search_chats` tool. Omit and the tool isn't offered. */
  chatSearch?: ChatSearchHost;
}

export interface RunOpts {
  chatId: string; text: string; images?: any[];
  workspaceId: string; workspacePath: string;
  provider: string; model: string; apiKey: string;
  baseUrl?: string; contextWindow?: number; thinkingLevel?: string;
  wsBuiltinSkills?: Record<string, any>;
  unattended?: boolean; source?: string; sourceId?: string; cronTitle?: string;
  /** `settings.timezone` — named in the Scheduled runs prompt section. */
  timezone?: string;
}

type Entry = {
  session: any;
  unsubscribe: (() => void) | null;
  key: string;
  workspacePath: string;
  jsonlPath: string;
  running: boolean;
  emit: Emit;
  lastFailureError: string | null;
  modelObj: any;
  modelRegistry: any;
  /** pi's session log — the source of identified entries to store. */
  sessionManager: any;
  /** Entry ids already sent, so each message is stored once. */
  sentIds: Set<string>;
  /** Serializes message appends so rows are stored in the order pi emitted them. */
  writeChain: Promise<void>;
  /** Rows whose append hasn't landed yet — re-sent after the turn. */
  pending: ChatRow[];
  /** `transcriptUpdatedAt` as of our last upload/boot. If the row's value moves
   *  past this, another client advanced the chat and our session is stale. */
  transcriptAt: number | null;
};

const TITLE_PROMPT = 'Generate a short, descriptive title (3-7 words) for a conversation that starts with the following exchange. The title should capture the main topic or intent. Return ONLY the title text, nothing else. No quotes, no punctuation at the end, no prefixes.';

// `source` is in the key because it decides the tool set (see toolsForSource):
// the same chat continued from Telegram and then the desktop must rebuild rather
// than reuse a live session still holding the other side's tools.
function makeKey({ workspacePath, provider, model, apiKey, baseUrl, contextWindow, thinkingLevel, source }: any) {
  return [workspacePath, provider, model, apiKey, baseUrl ?? '', contextWindow ?? '', thinkingLevel ?? '', source ?? 'desktop'].join(' ');
}

// ── pi content → text / row mapping ──────────────────────────────────────────
function textOf(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((c) => c && c.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('');
  return '';
}
function thinkingOf(content: any): string | null {
  if (!Array.isArray(content)) return null;
  const t = content.filter((c) => c?.type === 'thinking' && typeof c.thinking === 'string').map((c) => c.thinking).join('');
  return t || null;
}
function toolCallsOf(content: any): string | null {
  if (!Array.isArray(content)) return null;
  const calls = content.filter((c) => c?.type === 'toolCall').map((c) => ({ id: c.id, name: c.name, arguments: c.arguments }));
  return calls.length ? JSON.stringify(calls) : null;
}
// Map one pi SessionEntry to a storable row. Returns null for entry kinds that
// aren't conversation (model_change, thinking_level_change, compaction markers,
// extension customs) — those belong to pi's session log, not to what the user
// reads.
function entryToRow(entry: any): ChatRow | null {
  if (!entry || entry.type !== 'message' || !entry.id) return null;
  const m = entry.message;
  if (!m) return null;
  const base = {
    entryId: String(entry.id),
    parentId: entry.parentId != null ? String(entry.parentId) : null,
    createdAt: Date.parse(entry.timestamp) || Date.now(),
  };
  if (m.role === 'assistant') return { ...base, role: 'assistant', content: textOf(m.content) || null, reasoning: thinkingOf(m.content), toolCalls: toolCallsOf(m.content), toolCallId: null, toolName: null };
  if (m.role === 'toolResult') return { ...base, role: 'tool', content: textOf(m.content) || null, reasoning: null, toolCalls: null, toolCallId: m.toolCallId ?? null, toolName: m.toolName ?? null };
  return { ...base, role: 'user', content: textOf(m.content) || null, reasoning: null, toolCalls: null, toolCallId: null, toolName: null, images: imagesOf(m.content) };
}

// Locate pi's session file for a chat. pi writes `<timestamp>_<id>.jsonl` when it
// creates one, and we write `<id>.jsonl` when rebuilding from a transcript — so
// accept both rather than assuming either.
function findSessionFile(sessionsDir: string, chatId: string): string | null {
  const exact = join(sessionsDir, `${chatId}.jsonl`);
  if (fs.existsSync(exact)) return exact;
  try {
    const hit = fs.readdirSync(sessionsDir).find((f) => f.endsWith(`_${chatId}.jsonl`));
    return hit ? join(sessionsDir, hit) : null;
  } catch { return null; } // dir doesn't exist yet
}

// models.dev names its top reasoning tier 'max'; pi calls the same tier 'xhigh'.
function toPiThinkingLevel(level: string): string {
  return level === 'max' ? 'xhigh' : level;
}

// Resolve a (provider, model) to a runnable pi Model. Pi's bundled catalog wins;
// otherwise synthesize from models.dev by cloning a sibling's provider wiring.
export async function resolveModel(provider: any, model: any) {
  if (!provider || !model) return null;
  const real = getModel(provider, model);
  if (real) return real;
  const rec = await getCatalogModel(provider, model);
  if (!rec) return null;
  const sibling = getModels(provider)[0];
  if (!sibling) return null;
  return {
    id: rec.id, name: rec.name, api: sibling.api, provider, baseUrl: sibling.baseUrl,
    compat: sibling.compat, reasoning: rec.reasoning, input: rec.input, cost: rec.cost,
    contextWindow: rec.contextWindow, maxTokens: rec.maxTokens,
  };
}

// Reasoning levels for the model dropdown (host-independent).
export async function listThinkingLevels(provider: string, model: string) {
  if (!provider) return ['off'];
  if (provider === 'openai-compatible') return ['off', 'minimal', 'low', 'medium', 'high'];
  if (!model) return ['off'];
  try {
    const rec = await getCatalogModel(provider, model);
    if (!rec || !rec.reasoning) return ['off'];
    return [...new Set(['off', ...rec.reasoningLevels.map(toPiThinkingLevel)])];
  } catch {
    return ['off'];
  }
}

// ── The runtime — one per host (desktop / companion) ─────────────────────────
export function createAgentRuntime(host: AgentHost) {
  const sessions = new Map<string, Entry>();
  const booting = new Map<string, Promise<Entry>>();
  // Token tools built once with this host's getters closed over.
  const tokenTools = makeAgentTokenTools(host.getAgentSecrets, host.getToken);
  // Which chat/workspace a tool call belongs to is per-turn, so the tool reads it
  // through a getter set at boot rather than being rebuilt per session.
  let searchCtx = { workspaceId: '', chatId: '' };
  const searchTools = host.chatSearch ? [makeChatSearchTool(host.chatSearch, () => searchCtx)] : [];

  // Store every message pi has appended to its session but we haven't sent yet.
  //
  // The source is `sessionManager.getEntries()` — pi's own append-only log, where
  // each entry already carries a stable unique id. We read it on every
  // `message_end` (and again after the turn), so a message is stored the moment
  // it's complete: tool calls show up while the turn is still running, and a turn
  // that errors, is aborted, or times out keeps everything it managed to do.
  //
  // Why not the `entry_appended` event, which looks purpose-built for this: its
  // only emit site is the EXTENSION api's appendEntry(), for custom entries.
  // Conversation messages are appended via sessionManager.appendMessage(), which
  // emits nothing — so it never fires for a user/assistant/toolResult message.
  //
  // Fire-and-forget (pi's subscribe is sync) but CHAINED per session, so rows
  // arrive in pi's order — the server assigns `seq` on arrival. A failed append
  // stays in `pending` and is retried after the turn; since identity is the entry
  // id, re-sending is a no-op for anything already stored.
  function syncEntries(entry: Entry, chatId: string) {
    let fresh: ChatRow[];
    try {
      fresh = (entry.sessionManager?.getEntries() ?? [])
        .filter((e: any) => e?.id && !entry.sentIds.has(e.id))
        .map(entryToRow)
        .filter((r): r is ChatRow => !!r);
    } catch { return; } // manager torn down mid-turn
    if (!fresh.length) return;
    for (const r of fresh) entry.sentIds.add(r.entryId);
    entry.pending.push(...fresh);
    entry.writeChain = entry.writeChain
      .then(() => host.appendMessages(chatId, fresh))
      .then(() => { for (const r of fresh) { const i = entry.pending.indexOf(r); if (i >= 0) entry.pending.splice(i, 1); } })
      .catch(() => { /* stays in `pending`; the post-turn flush retries it */ });
  }

  async function disposeEntry(chatId: string) {
    const entry = sessions.get(chatId);
    if (!entry) return;
    sessions.delete(chatId);
    if (entry.unsubscribe) {
      try { entry.unsubscribe(); } catch { /* already unsubscribed */ }
      entry.unsubscribe = null;
    }
    try { await entry.session.abort(); } catch { /* best-effort */ }
    try { entry.session.dispose(); } catch { /* best-effort */ }
  }

  async function bootSession(chatId: string, opts: RunOpts, emitEvent: Emit): Promise<Entry> {
    const { workspacePath, provider, model, apiKey, baseUrl, contextWindow, thinkingLevel, wsBuiltinSkills, unattended, source, cronTitle, timezone } = opts;
    const level = toPiThinkingLevel(thinkingLevel || 'off');

    const dataDir = host.dataDir(chatId);
    // The agent's own directory for this chat: working files, and anything the
    // user sent it. Outside the workspace, so nothing here is committed. Created
    // up front because the prompt names it, and a path the agent is told about
    // should exist when it goes looking.
    const scratchDir = host.scratchDir(chatId);
    try { fs.mkdirSync(scratchDir, { recursive: true }); } catch { /* best-effort */ }
    await ensureDirs(dataDir);
    const builtins = await listBuiltinSkills(host.builtinDir);
    const wsSkills = await listWorkspaceSkills(workspacePath);
    const effectivePaths = computeEffectivePaths(builtins, wsBuiltinSkills ?? {}, wsSkills);
    await writePiSettings(dataDir, { skills: effectivePaths, extensions: [] });

    await disposeEntry(chatId);

    const authStorage = AuthStorage.inMemory();
    const modelRegistry = ModelRegistry.create(authStorage);

    let modelObj: any;
    if (provider === 'openai-compatible') {
      modelRegistry.registerProvider('openai-compatible', {
        baseUrl, apiKey: apiKey || 'local', api: 'openai-completions',
        models: [{ id: model, name: model, reasoning: level !== 'off', input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: contextWindow || 128000, maxTokens: 16384 }],
      });
      modelObj = modelRegistry.find('openai-compatible', model);
    } else {
      authStorage.setRuntimeApiKey(provider, apiKey);
      modelObj = await resolveModel(provider, model);
      if (!modelObj) throw new Error(`Model "${model}" not found for provider "${provider}".`);
    }

    const agentDir = agentDirFor(dataDir);
    const sessionsDir = join(agentDir, 'sessions');
    const row = await host.getChat(chatId);
    // pi names its file `<timestamp>_<chatId>.jsonl`, so the path can't be
    // reconstructed from the id — it has to be looked up. Building it by hand
    // meant the local file was NEVER found and every resume fell through to the
    // transcript download (and, if that was empty, to a brand-new empty session).
    let jsonlPath = findSessionFile(sessionsDir, chatId);
    if (row) {
      // THE SERVER IS THE SOURCE OF TRUTH — always take its copy, unconditionally.
      // A local file is only this machine's working copy, and it goes stale the
      // moment any other client (the desktop, Telegram, cron, a second machine)
      // takes a turn in this chat: that client uploads its transcript and ours
      // knows nothing about it. Anything present only on our disk is, by
      // definition, something no other client has seen.
      //
      // Don't "keep the local file if it looks newer". Line counts only mean
      // ahead-ness on a shared lineage; once both sides have diverged, that test
      // picks the stale local copy — the exact bug this prevents. The one thing
      // lost is pi's context from a turn whose transcript upload failed, and that
      // self-heals (the whole file is re-uploaded every turn), the messages are
      // already stored row-by-row, and the failure is reported, not swallowed.
      const content = await host.getTranscript(chatId);
      if (content) {
        jsonlPath = join(sessionsDir, `${chatId}.jsonl`);
        fs.mkdirSync(sessionsDir, { recursive: true });
        fs.writeFileSync(jsonlPath, content);
      }
    }
    let sessionManager: any;
    let promptOverride: string;
    if (row && jsonlPath) {
      sessionManager = SessionManager.open(jsonlPath);
      // Keep the SOUL this chat was created with; rebuild the helper for THIS
      // run, so its tool list matches the side actually executing the turn.
      promptOverride = row.systemPrompt
        ? rebuildSystemPrompt(row.systemPrompt, { unattended: !!unattended, source, scratchDir, timezone })
        : await assembleSystemPrompt(workspacePath, { unattended: !!unattended, source, scratchDir, timezone });
    } else {
      // A brand-new chat. If the row exists we'd be silently restarting a real
      // conversation from empty — refuse instead, so a lost transcript surfaces
      // rather than quietly truncating the chat.
      if (row) throw new Error('This chat\'s transcript is missing on the server, so it cannot be continued. Start a new chat.');
      sessionManager = SessionManager.create(workspacePath, sessionsDir, { id: chatId });
      promptOverride = await assembleSystemPrompt(workspacePath, { unattended: !!unattended, source, scratchDir, timezone });
    }

    const resourceLoader = new DefaultResourceLoader({ cwd: workspacePath, agentDir, systemPromptOverride: () => promptOverride });
    await resourceLoader.reload();

    // One filtered list for this run's source, used twice: as the names pi is
    // allowed to run, and (via the prompt above) as what the agent is told it
    // has. pi filters CUSTOM tools against the allowlist too, so a host tool the
    // catalog doesn't name is dropped without a word — warn instead of leaving
    // the agent to discover it mid-turn.
    const allowed = activeToolNames(source);
    // Built per session because it writes into THIS chat's scratch pad.
    const transcribeTools = allowed.includes('transcribe')
      ? [makeTranscribeTool(host.getTranscription, scratchDir)]
      : [];
    // Built per session because it resolves paths inside THIS workspace. Its
    // config is read off disk per call, so a settings change mid-chat is picked
    // up without a reboot.
    const dailyNoteTools = allowed.includes('daily_note')
      ? [makeDailyNoteTool(workspacePath, timezone)]
      : [];
    // Built per session because the skill roots are THIS workspace's, and
    // because a review run's read-before-write state must not be shared with
    // any other run. On a review run this also returns a `read` that wraps pi's
    // own — see skillTool.ts for why the override is where the mark lives.
    const skillTools = allowed.includes('skill_manage')
      ? makeSkillTools({
        cwd: workspacePath,
        roots: {
          agentDir: agentSkillsDir(workspacePath),
          protectedDirs: [workspaceSkillsDir(workspacePath), host.builtinDir].filter(Boolean),
        },
        trackReads: source === 'review',
      })
      : [];
    const extraTools = host.extraTools.filter((t: any) => allowed.includes(t?.name));
    for (const t of host.extraTools) {
      if (!allowed.includes(t?.name)) console.warn(`[agent] host tool "${t?.name}" is not offered on ${source ?? 'desktop'} runs — add it to TOOL_CATALOG to enable it.`);
    }

    const { session } = await createAgentSession({
      cwd: workspacePath, agentDir, model: modelObj, thinkingLevel: level as any,
      authStorage, modelRegistry, sessionManager, resourceLoader,
      customTools: [...tokenTools, ...searchTools, ...transcribeTools, ...dailyNoteTools, ...skillTools, ...extraTools],
      tools: allowed,
    });

    const entry: Entry = {
      session, unsubscribe: null,
      key: makeKey({ workspacePath, provider, model, apiKey, baseUrl, contextWindow, thinkingLevel: thinkingLevel || 'off', source }),
      workspacePath, jsonlPath: session.sessionFile ?? '', running: false,
      emit: emitEvent, lastFailureError: null, modelObj, modelRegistry,
      sessionManager, sentIds: new Set<string>(), writeChain: Promise.resolve(), pending: [],
      transcriptAt: row?.transcriptUpdatedAt ?? null,
    };

    // Stamp every event with its chatId and hand it to the (single) sink. The
    // host's emit routes it — desktop: renderer + feed; server: feed.
    //
    // `message_end` is ALSO where messages get stored — see syncEntries. Storing
    // as pi completes each message (not in one batch after the turn) is what makes
    // tool calls visible while they run, and what lets an errored, aborted, or
    // timed-out turn keep everything it managed to do.
    entry.unsubscribe = session.subscribe((event: any) => {
      if (event?.type === 'agent_end' && Array.isArray(event.messages)) {
        const failure = event.messages.find((m: any) => m?.role === 'assistant' && m?.stopReason === 'error' && m?.errorMessage) as any;
        if (failure) entry.lastFailureError = failure.errorMessage;
      }
      // `message_end` = one message is complete and now in pi's session log.
      if (event?.type === 'message_end' || event?.type === 'agent_end') syncEntries(entry, chatId);
      entry.emit({ ...event, chatId, machine: host.machine });
    });

    // A resumed session's log already holds every earlier message, and those are
    // already stored — mark them sent so a boot doesn't re-upload the history.
    try { for (const e of sessionManager.getEntries() ?? []) if (e?.id) entry.sentIds.add(e.id); } catch { /* fresh session */ }

    sessions.set(chatId, entry);

    await host.upsertChat({
      chatId, workspaceId: opts.workspaceId, systemPrompt: promptOverride,
      model: model ?? null, source: source ?? 'desktop', sourceId: opts.sourceId ?? cronTitle ?? null, machine: host.machine,
    });

    if (cronTitle) {
      const existing = await host.getChat(chatId);
      if (existing && !existing.title) await host.setChatTitle(chatId, cronTitle);
    }

    const dbRow = await host.getChat(chatId);
    entry.emit({ type: 'shockwave_chat', chatId, machine: host.machine, title: dbRow?.title ?? null, pinned: !!dbRow?.pinned });

    return entry;
  }

  async function ensureSession(chatId: string, opts: RunOpts, emitEvent: Emit): Promise<Entry> {
    const key = makeKey({ ...opts, thinkingLevel: opts.thinkingLevel || 'off' });
    const existing = sessions.get(chatId);
    if (existing) {
      existing.emit = emitEvent;
      // Reusing a live session skips boot entirely — including the transcript
      // read — so a turn another client took in the meantime would be invisible
      // to this one. Re-boot when the stored transcript has moved past ours.
      const stale = !existing.running && await transcriptMovedOn(chatId, existing);
      if (!stale && (existing.running || (existing.key === key && existing.workspacePath === opts.workspacePath))) return existing;
    }
    const inflight = booting.get(chatId);
    if (inflight) {
      const entry = await inflight;
      entry.emit = emitEvent;
      return entry;
    }
    const boot = bootSession(chatId, opts, emitEvent).finally(() => booting.delete(chatId));
    booting.set(chatId, boot);
    return boot;
  }

  async function maybeGenerateTitle(entry: Entry, chatId: string, messages: any[]) {
    const row = await host.getChat(chatId);
    if (!row || row.title) return;
    const firstUser = messages.find((m) => m?.role === 'user');
    const firstAsst = messages.find((m) => m?.role === 'assistant');
    if (!firstUser) return;
    const { modelObj, modelRegistry } = entry;
    if (!modelObj || !modelRegistry) return;
    const exchange = `User: ${textOf(firstUser.content)}\n\nAssistant: ${textOf(firstAsst?.content)}`.slice(0, 2000);
    (async () => {
      try {
        const auth = await modelRegistry.getApiKeyAndHeaders(modelObj);
        if (!auth?.ok) return;
        const res = await completeSimple(
          modelObj,
          { messages: [{ role: 'user', content: `${TITLE_PROMPT}\n\n${exchange}`, timestamp: Date.now() }] },
          { apiKey: auth.apiKey, headers: auth.headers, env: auth.env, maxTokens: 32 },
        );
        const title = (res?.content ?? []).filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('').trim().replace(/^["']|["']$/g, '').slice(0, 100);
        if (title) {
          await host.setChatTitle(chatId, title);
          entry.emit({ type: 'shockwave_chat_titled', chatId, title });
        }
      } catch { /* title is best-effort */ }
    })();
  }

  async function agentSend(opts: RunOpts, emitEvent: Emit) {
    const { chatId, text, images, workspacePath, provider, model, apiKey } = opts;
    if (!chatId) throw new Error('agentSend requires a chatId.');
    // search_chats scopes to this workspace and skips this chat.
    searchCtx = { workspaceId: opts.workspaceId ?? '', chatId };
    const hasImages = Array.isArray(images) && images.length > 0;

    // Mid-turn send → hand it to the running turn; pi delivers it at the next
    // step. Checked BEFORE the config validation below: a steer joins a session
    // that is already booted and configured, so the caller has nothing to supply
    // (the Telegram webhook relays one with no workspace or model at all).
    //
    // `emit` is deliberately NOT re-pointed. It used to be, which handed the
    // running turn's event stream to the second message's sink — freezing the
    // first reply half-written and drawing the rest under the wrong message.
    const live = sessions.get(chatId);
    if (live?.running) {
      await live.session.prompt(text, { ...(hasImages ? { images } : {}), streamingBehavior: 'steer' });
      return;
    }

    if (!workspacePath) throw new Error('Open a workspace first.');
    if (!provider) throw new Error('Coding agent provider not configured.');
    if (!model) throw new Error('Coding agent model not configured.');
    if (provider !== 'openai-compatible' && !apiKey) throw new Error('Coding agent API key not configured. Open Settings → LLM / Agent.');

    const entry = await ensureSession(chatId, opts, emitEvent);
    entry.lastFailureError = null;
    entry.running = true;
    // Mark running on the companion (this machine). Cleared only AFTER upload below.
    host.setRunning(chatId, host.machine).catch(() => { /* best-effort */ });
    let threw = false;
    try {
      await entry.session.prompt(text, hasImages ? { images } : undefined);
    } catch (e) {
      threw = true;
      throw e;
    } finally {
      entry.running = false;
      if (threw) host.setRunning(chatId, null).catch(() => { /* nothing to upload */ });
    }

    if (entry.lastFailureError) {
      const errorMessage = entry.lastFailureError;
      entry.lastFailureError = null;
      const msgs = entry.session.state?.messages;
      if (Array.isArray(msgs) && msgs.length >= 2) {
        const last = msgs[msgs.length - 1];
        const prev = msgs[msgs.length - 2];
        if (last?.role === 'assistant' && last?.stopReason === 'error' && prev?.role === 'user') msgs.splice(msgs.length - 2, 2);
      }
      // `machine` like every other emit — a client filters the feed by origin to
      // drop the echo of its own run, and an unstamped event isn't recognizable
      // as its own.
      entry.emit({ type: 'agent_send_failed', errorMessage, chatId, machine: host.machine });
      host.setRunning(chatId, null).catch(() => { /* nothing new to upload */ });
      return;
    }

    // Messages are already stored — they were appended as pi emitted them. All
    // that's left is to settle any append that hasn't landed, then upload pi's
    // session file, THEN clear running (so a viewer never sees "done" early).
    await flushPending(entry, chatId);
    await uploadTranscript(entry, chatId);
    host.setRunning(chatId, null).catch(() => { /* best-effort */ });
    // Everything this turn produced is now stored. A viewer that deferred a
    // re-read (re-reading mid-turn would replace the live stream with rows that
    // don't include what is still running) can safely take it now. Without this
    // the viewer has to guess a delay after agent_end, which fires BEFORE the
    // two awaits above.
    entry.emit({ type: 'shockwave_turn_stored', chatId, machine: host.machine });
    maybeGenerateTitle(entry, chatId, entry.session.state?.messages ?? []).catch(() => { /* best-effort */ });
  }

  // Boot the session WITHOUT running a turn, so a host can do it while it is
  // waiting on something else.
  //
  // The companion's Telegram path uses this: transcribing a voice note is
  // seconds of network, and booting needs none of the text — so the checkout and
  // the boot happen alongside the transcription instead of after it. The
  // subsequent agentSend then finds the session already in `sessions` and starts
  // prompting immediately.
  //
  // Safe to call and then call agentSend: `booting` dedups an in-flight boot and
  // `ensureSession` returns the cached entry. Never call it for a chat with a
  // turn in flight — the running entry would have its `emit` re-pointed at the
  // new caller's sink, which is the bug that froze a reply half-written (see
  // agentSend). Hosts check that themselves; this one does too, so a caller that
  // forgets can't cause it.
  async function agentPrepare(opts: RunOpts, emitEvent: Emit): Promise<void> {
    const { chatId, workspacePath, provider, model, apiKey } = opts;
    if (!chatId || !workspacePath || !provider || !model) return;
    if (provider !== 'openai-compatible' && !apiKey) return;
    if (sessions.get(chatId)?.running) return; // a live turn owns its own sink
    searchCtx = { workspaceId: opts.workspaceId ?? '', chatId };
    await ensureSession(chatId, opts, emitEvent);
  }

  // Wait for in-flight appends, then re-send anything that failed. Idempotent by
  // entryId, so a re-send of an already-stored row is a true no-op.
  async function flushPending(entry: Entry, chatId: string) {
    syncEntries(entry, chatId); // catch anything after the last message_end
    await entry.writeChain.catch(() => { /* individual failures land in `pending` */ });
    if (!entry.pending.length) return;
    const retry = entry.pending.splice(0);
    try {
      await host.appendMessages(chatId, retry);
    } catch (e: any) {
      entry.pending.push(...retry);
      // Last chance to store them — a silent loss here is invisible until someone
      // opens the chat later and finds it short.
      host.onError?.(chatId, `${retry.length} message(s) could not be saved: ${e?.message ?? e}`);
    }
  }

  // Has another client advanced this chat since we booted or last uploaded?
  async function transcriptMovedOn(chatId: string, entry: Entry): Promise<boolean> {
    try {
      const row = await host.getChat(chatId);
      const at = row?.transcriptUpdatedAt ?? null;
      return at != null && entry.transcriptAt != null && at > entry.transcriptAt;
    } catch { return false; } // offline → keep working with what we have
  }

  // pi's own session JSONL, whole — the only thing that lets another machine pick
  // this chat up. Never silent: a lost transcript is how a resume ends up with an
  // empty session, so a failure is reported rather than swallowed.
  async function uploadTranscript(entry: Entry, chatId: string) {
    const file = entry.session.sessionFile || entry.jsonlPath;
    if (!file) { host.onError?.(chatId, 'pi session has no file on disk — transcript not saved.'); return; }
    try {
      const at = await host.putTranscript(chatId, fs.readFileSync(file, 'utf8'));
      if (typeof at === 'number') entry.transcriptAt = at; // our copy is current again
    } catch (e: any) {
      host.onError?.(chatId, `Failed to save the chat transcript: ${e?.message ?? e}`);
    }
  }

  async function agentAbort(chatId: string) {
    const entry = sessions.get(chatId);
    if (entry) { try { await entry.session.abort(); } catch { /* best-effort */ } }
  }

  async function agentDisposeChat(chatId: string) {
    await disposeEntry(chatId);
  }

  async function agentDisposeAll() {
    await Promise.all([...sessions.keys()].map((id) => disposeEntry(id)));
  }

  function agentRunningChats(): string[] {
    return [...sessions.entries()].filter(([, e]) => e.running).map(([id]) => id);
  }

  return { agentSend, agentPrepare, agentAbort, agentDisposeChat, agentDisposeAll, agentRunningChats };
}
