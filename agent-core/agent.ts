// The shared coding-agent runtime. One live pi AgentSession per chat, kept in a
// map keyed by sessionId. This is ALL the turn logic — booting/resuming a
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
import { agentDirFor, ensureDirs, listBuiltinSkills, listWorkspaceSkills, computeEffectivePaths, writePiSettings } from './skillLibrary.js';
import { assembleSystemPrompt } from './defaults/index.js';
import { ACTIVE_TOOL_NAMES } from './defaults/tools.js';
import { makeAgentTokenTools } from './agentTokens.js';

export type Emit = (event: any) => void;

// One pi message → one stored row. Tool CALLS ride on the assistant row
// (`toolCalls` JSON); each tool RESULT is a `role:'tool'` row. This mapping lived
// in the desktop's HTTP layer; it's core logic, so it lives here and both hosts
// store the already-mapped rows.
export interface ChatRow {
  seq: number; role: string; content: string | null; reasoning: string | null;
  toolCalls: string | null; toolCallId: string | null; toolName: string | null; createdAt: number;
}

// Everything host-specific. All I/O; no logic.
export interface AgentHost {
  builtinDir: string;                       // bundled built-in skills
  machine: string;                          // running_machine / provenance stamp
  extraTools: any[];                        // host-only tools (desktop: [open_file]; server: [])
  dataDir(sessionId: string): string;       // pi scratch-dir root; per-session so the server can isolate runs
  // persistence — dumb I/O; the core does the mapping/ordering:
  getSession(id: string): Promise<any | null>;
  upsertSession(row: { sessionId: string; workspaceId: string; systemPrompt?: string | null; model?: string | null; source?: string | null; sourceId?: string | null; machine?: string | null }): Promise<void>;
  persistMessages(id: string, rows: ChatRow[]): Promise<number>;
  setSessionTitle(id: string, title: string): Promise<void>;
  setRunning(id: string, machine: string | null): Promise<void>;
  getTranscript(id: string): Promise<string | null>;
  putTranscript(id: string, content: string): Promise<void>;
  // secrets for the agent-tokens tools:
  getAgentSecrets(): Promise<any[]>;
  getToken(name: string): Promise<string>;
}

export interface RunOpts {
  sessionId: string; text: string; images?: any[];
  workspaceId: string; workspacePath: string;
  provider: string; model: string; apiKey: string;
  baseUrl?: string; contextWindow?: number; thinkingLevel?: string;
  wsBuiltinSkills?: Record<string, any>;
  unattended?: boolean; source?: string; cronTitle?: string;
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
};

const TITLE_PROMPT = 'Generate a short, descriptive title (3-7 words) for a conversation that starts with the following exchange. The title should capture the main topic or intent. Return ONLY the title text, nothing else. No quotes, no punctuation at the end, no prefixes.';

function makeKey({ workspacePath, provider, model, apiKey, baseUrl, contextWindow, thinkingLevel }: any) {
  return [workspacePath, provider, model, apiKey, baseUrl ?? '', contextWindow ?? '', thinkingLevel ?? ''].join(' ');
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
function piMessageToRow(m: any, seq: number, now: number): ChatRow {
  if (m?.role === 'assistant') return { seq, role: 'assistant', content: textOf(m.content) || null, reasoning: thinkingOf(m.content), toolCalls: toolCallsOf(m.content), toolCallId: null, toolName: null, createdAt: now };
  if (m?.role === 'toolResult') return { seq, role: 'tool', content: textOf(m.content) || null, reasoning: null, toolCalls: null, toolCallId: m.toolCallId ?? null, toolName: m.toolName ?? null, createdAt: now };
  return { seq, role: 'user', content: textOf(m.content) || null, reasoning: null, toolCalls: null, toolCallId: null, toolName: null, createdAt: now };
}

// models.dev names its top reasoning tier 'max'; pi calls the same tier 'xhigh'.
function toPiThinkingLevel(level: string): string {
  return level === 'max' ? 'xhigh' : level;
}

// Resolve a (provider, model) to a runnable pi Model. Pi's bundled catalog wins;
// otherwise synthesize from models.dev by cloning a sibling's provider wiring.
async function resolveModel(provider: any, model: any) {
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

  async function disposeEntry(sessionId: string) {
    const entry = sessions.get(sessionId);
    if (!entry) return;
    sessions.delete(sessionId);
    if (entry.unsubscribe) {
      try { entry.unsubscribe(); } catch { /* already unsubscribed */ }
      entry.unsubscribe = null;
    }
    try { await entry.session.abort(); } catch { /* best-effort */ }
    try { entry.session.dispose(); } catch { /* best-effort */ }
  }

  async function bootSession(sessionId: string, opts: RunOpts, emitEvent: Emit): Promise<Entry> {
    const { workspacePath, provider, model, apiKey, baseUrl, contextWindow, thinkingLevel, wsBuiltinSkills, unattended, source, cronTitle } = opts;
    const level = toPiThinkingLevel(thinkingLevel || 'off');

    const dataDir = host.dataDir(sessionId);
    await ensureDirs(dataDir);
    const builtins = await listBuiltinSkills(host.builtinDir);
    const wsSkills = await listWorkspaceSkills(workspacePath);
    const effectivePaths = computeEffectivePaths(builtins, wsBuiltinSkills ?? {}, wsSkills);
    await writePiSettings(dataDir, { skills: effectivePaths, extensions: [] });

    await disposeEntry(sessionId);

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
    const row = await host.getSession(sessionId);
    const jsonlPath = join(agentDir, 'sessions', `${sessionId}.jsonl`);
    if (row && !fs.existsSync(jsonlPath)) {
      try {
        const content = await host.getTranscript(sessionId);
        if (content) { fs.mkdirSync(join(agentDir, 'sessions'), { recursive: true }); fs.writeFileSync(jsonlPath, content); }
      } catch { /* offline or no transcript → create fresh below */ }
    }
    let sessionManager: any;
    let promptOverride: string;
    if (row && fs.existsSync(jsonlPath)) {
      sessionManager = SessionManager.open(jsonlPath);
      promptOverride = row.systemPrompt ?? await assembleSystemPrompt(workspacePath);
    } else {
      sessionManager = SessionManager.create(workspacePath, join(agentDir, 'sessions'), { id: sessionId });
      promptOverride = await assembleSystemPrompt(workspacePath, { unattended: !!unattended });
    }

    const resourceLoader = new DefaultResourceLoader({ cwd: workspacePath, agentDir, systemPromptOverride: () => promptOverride });
    await resourceLoader.reload();

    const { session } = await createAgentSession({
      cwd: workspacePath, agentDir, model: modelObj, thinkingLevel: level as any,
      authStorage, modelRegistry, sessionManager, resourceLoader,
      customTools: [...tokenTools, ...host.extraTools],
      tools: ACTIVE_TOOL_NAMES,
    });

    const entry: Entry = {
      session, unsubscribe: null,
      key: makeKey({ workspacePath, provider, model, apiKey, baseUrl, contextWindow, thinkingLevel: thinkingLevel || 'off' }),
      workspacePath, jsonlPath: session.sessionFile ?? '', running: false,
      emit: emitEvent, lastFailureError: null, modelObj, modelRegistry,
    };

    // Stamp every event with its sessionId and hand it to the (single) sink. The
    // host's emit routes it — desktop: renderer + feed; server: feed.
    entry.unsubscribe = session.subscribe((event: any) => {
      if (event?.type === 'agent_end' && Array.isArray(event.messages)) {
        const failure = event.messages.find((m: any) => m?.role === 'assistant' && m?.stopReason === 'error' && m?.errorMessage) as any;
        if (failure) entry.lastFailureError = failure.errorMessage;
      }
      entry.emit({ ...event, sessionId });
    });

    sessions.set(sessionId, entry);

    await host.upsertSession({
      sessionId, workspaceId: opts.workspaceId, systemPrompt: promptOverride,
      model: model ?? null, source: source ?? 'desktop', sourceId: cronTitle ?? null, machine: host.machine,
    });

    if (cronTitle) {
      const existing = await host.getSession(sessionId);
      if (existing && !existing.title) await host.setSessionTitle(sessionId, cronTitle);
    }

    const dbRow = await host.getSession(sessionId);
    entry.emit({ type: 'shockwave_session', sessionId, title: dbRow?.title ?? null, starred: !!dbRow?.starred });

    return entry;
  }

  async function ensureSession(sessionId: string, opts: RunOpts, emitEvent: Emit): Promise<Entry> {
    const key = makeKey({ ...opts, thinkingLevel: opts.thinkingLevel || 'off' });
    const existing = sessions.get(sessionId);
    if (existing) {
      existing.emit = emitEvent;
      if (existing.running || (existing.key === key && existing.workspacePath === opts.workspacePath)) return existing;
    }
    const inflight = booting.get(sessionId);
    if (inflight) {
      const entry = await inflight;
      entry.emit = emitEvent;
      return entry;
    }
    const boot = bootSession(sessionId, opts, emitEvent).finally(() => booting.delete(sessionId));
    booting.set(sessionId, boot);
    return boot;
  }

  async function maybeGenerateTitle(entry: Entry, sessionId: string, messages: any[]) {
    const row = await host.getSession(sessionId);
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
          await host.setSessionTitle(sessionId, title);
          entry.emit({ type: 'shockwave_session_titled', sessionId, title });
        }
      } catch { /* title is best-effort */ }
    })();
  }

  async function agentSend(opts: RunOpts, emitEvent: Emit) {
    const { sessionId, text, images, workspacePath, provider, model, apiKey } = opts;
    if (!sessionId) throw new Error('agentSend requires a sessionId.');
    if (!workspacePath) throw new Error('Open a workspace first.');
    if (!provider) throw new Error('Coding agent provider not configured.');
    if (!model) throw new Error('Coding agent model not configured.');
    if (provider !== 'openai-compatible' && !apiKey) throw new Error('Coding agent API key not configured. Open Settings → LLM / Agent.');

    const hasImages = Array.isArray(images) && images.length > 0;

    // Mid-turn send → steer into the running turn.
    const live = sessions.get(sessionId);
    if (live?.running) {
      live.emit = emitEvent;
      await live.session.prompt(text, { ...(hasImages ? { images } : {}), streamingBehavior: 'steer' });
      return;
    }

    const entry = await ensureSession(sessionId, opts, emitEvent);
    entry.lastFailureError = null;
    entry.running = true;
    // Mark running on the companion (this machine). Cleared only AFTER upload below.
    host.setRunning(sessionId, host.machine).catch(() => { /* best-effort */ });
    let threw = false;
    try {
      await entry.session.prompt(text, hasImages ? { images } : undefined);
    } catch (e) {
      threw = true;
      throw e;
    } finally {
      entry.running = false;
      if (threw) host.setRunning(sessionId, null).catch(() => { /* nothing to upload */ });
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
      entry.emit({ type: 'agent_send_failed', errorMessage, sessionId });
      host.setRunning(sessionId, null).catch(() => { /* nothing new to upload */ });
      return;
    }

    // Turn succeeded: upload the turn (rows + whole JSONL), THEN clear running.
    const msgs = entry.session.state?.messages ?? [];
    const now = Date.now();
    const rows = msgs.map((m: any, i: number) => piMessageToRow(m, i, now));
    try {
      await host.persistMessages(sessionId, rows);
      try {
        const content = fs.readFileSync(entry.jsonlPath, 'utf8');
        await host.putTranscript(sessionId, content);
      } catch { /* jsonl not ready yet */ }
    } catch { /* best-effort persist */ }
    host.setRunning(sessionId, null).catch(() => { /* best-effort */ });
    maybeGenerateTitle(entry, sessionId, msgs).catch(() => { /* best-effort */ });
  }

  async function agentAbort(sessionId: string) {
    const entry = sessions.get(sessionId);
    if (entry) { try { await entry.session.abort(); } catch { /* best-effort */ } }
  }

  async function agentDisposeSession(sessionId: string) {
    await disposeEntry(sessionId);
  }

  async function agentDisposeAll() {
    await Promise.all([...sessions.keys()].map((id) => disposeEntry(id)));
  }

  function agentRunningSessions(): string[] {
    return [...sessions.entries()].filter(([, e]) => e.running).map(([id]) => id);
  }

  return { agentSend, agentAbort, agentDisposeSession, agentDisposeAll, agentRunningSessions };
}
