// Chat persistence against the API — the DESKTOP host's dumb I/O for the shared
// agent-core. All logic (the pi→row mapping, the upload-then-clear ordering)
// lives in agent-core/agent.ts now; this file just moves already-shaped data
// over HTTP. The companion host does the same operations directly against the
// store. The transcript JSONL is a local pi file, uploaded whole after a turn.

import { api } from './client.js';
import type { ChatRow } from '../../../agent-core/agent.js';

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

// Append already-mapped rows. Idempotent by (session_id, seq) server-side.
export async function persistMessages(sessionId: string, rows: ChatRow[]): Promise<number> {
  if (!Array.isArray(rows) || !rows.length) return 0;
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
