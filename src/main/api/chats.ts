// Chat persistence against the API. Replaces the db/index chat functions. The
// pi runtime (session, streaming, its JSONL file) is unchanged — this is only
// where the session row + message rows get stored. The transcript JSONL stays a
// local pi file, derived from the session id; it is not sent to the server.

import { api } from './client.js';

// pi message → row shape (moved verbatim from db/index; the server stores these).
function textOf(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((c) => c?.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('');
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
function piMessageToRow(m: any, seq: number, now: number) {
  if (m?.role === 'assistant') return { seq, role: 'assistant', content: textOf(m.content) || null, reasoning: thinkingOf(m.content), toolCalls: toolCallsOf(m.content), toolCallId: null, toolName: null, createdAt: now };
  if (m?.role === 'toolResult') return { seq, role: 'tool', content: textOf(m.content) || null, reasoning: null, toolCalls: null, toolCallId: m.toolCallId ?? null, toolName: m.toolName ?? null, createdAt: now };
  return { seq, role: 'user', content: textOf(m.content) || null, reasoning: null, toolCalls: null, toolCallId: null, toolName: null, createdAt: now };
}

export async function getSession(sessionId: string): Promise<any | null> {
  const { session } = await api.get(`/chat/${encodeURIComponent(sessionId)}`);
  return session ?? null;
}

export async function upsertSession(row: {
  sessionId: string; workspaceId: string; systemPrompt?: string | null; model?: string | null;
  source?: string | null; sourceId?: string | null; machine?: string | null;
}): Promise<void> {
  await api.post('/chat', row);
}

export async function setSessionTitle(sessionId: string, title: string): Promise<void> {
  await api.patch(`/chat/${encodeURIComponent(sessionId)}/title`, { title });
}

// Append complete messages. The API is idempotent by (session_id, seq), so we
// send the full mapped list and the server skips what it already has.
export async function persistMessages(sessionId: string, piMessages: any[], now: number): Promise<number> {
  if (!Array.isArray(piMessages) || !piMessages.length) return 0;
  const rows = piMessages.map((m, i) => piMessageToRow(m, i, now));
  return api.post(`/chat/${encodeURIComponent(sessionId)}/messages`, rows);
}

// Chat list/read for the chat:* IPC handlers.
export const listSessions = (workspaceId: string, opts: { limit?: number; before?: number } = {}) => {
  const p = new URLSearchParams({ workspaceId });
  if (opts.limit) p.set('limit', String(opts.limit));
  if (opts.before) p.set('before', String(opts.before));
  return api.get(`/chats?${p}`);
};
export const listStarred = (workspaceId: string) => api.get(`/chats/starred?workspaceId=${encodeURIComponent(workspaceId)}`);
export const searchSessions = (workspaceId: string, query: string, opts: { limit?: number } = {}) => {
  const p = new URLSearchParams({ workspaceId, q: query });
  if (opts.limit) p.set('limit', String(opts.limit));
  return api.get(`/chats/search?${p}`);
};
export const getMessages = (sessionId: string) => api.get(`/chat/${encodeURIComponent(sessionId)}/messages`);
export const openSession = (sessionId: string) => api.get(`/chat/${encodeURIComponent(sessionId)}`);
export const setSessionStarred = (sessionId: string, starred: boolean) => api.patch(`/chat/${encodeURIComponent(sessionId)}/starred`, { starred });
export const deleteSession = (sessionId: string) => api.del(`/chat/${encodeURIComponent(sessionId)}`);

// Transcript JSONL (whole). The server keeps it so any machine can continue the
// chat. Upload after each turn; download on resume when the local file is absent.
export const putTranscript = (sessionId: string, content: string) => api.patch(`/chat/${encodeURIComponent(sessionId)}/transcript`, { content });
export const getTranscript = (sessionId: string): Promise<string | null> => api.get(`/chat/${encodeURIComponent(sessionId)}/transcript`);

// Cross-client execution flag. Set with this machine's name on agent_start; clear
// (machine=null) only AFTER the turn's rows + transcript are uploaded, so
// running=false on the server means "done and uploaded — safe to take over".
export const setRunning = (sessionId: string, machine: string | null) => api.patch(`/chat/${encodeURIComponent(sessionId)}/running`, { machine });

// Live feed: push one pi event to the companion, which fans it out over SSE to
// any other client watching this chat. Fire-and-forget; ephemeral (not stored).
export const postEvent = (sessionId: string, event: any) => api.post(`/chat/${encodeURIComponent(sessionId)}/events`, event);
