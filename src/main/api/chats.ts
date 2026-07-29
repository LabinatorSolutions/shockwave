// Chat persistence against the API — the DESKTOP host's dumb I/O for the shared
// agent-core. All logic (the pi→row mapping, the upload-then-clear ordering)
// lives in agent-core/agent.ts now; this file just moves already-shaped data
// over HTTP. The companion host does the same operations directly against the
// store. The transcript JSONL is a local pi file, uploaded whole after a turn.

import { api } from './client.js';
import type { ChatRow } from '../../../agent-core/agent.js';

export async function getChat(chatId: string): Promise<any | null> {
  const { chat } = await api.get(`/chat/${encodeURIComponent(chatId)}`);
  return chat ?? null;
}

export async function upsertChat(row: {
  chatId: string; workspaceId: string; systemPrompt?: string | null; model?: string | null;
  source?: string | null; sourceId?: string | null; machine?: string | null;
}): Promise<void> {
  await api.post('/chat', row);
}

export async function setChatTitle(chatId: string, title: string): Promise<void> {
  await api.patch(`/chat/${encodeURIComponent(chatId)}/title`, { title });
}

// Append already-mapped rows. Idempotent by entryId server-side, which assigns
// the ordering — so a retry or a duplicate re-send stores nothing twice.
export async function appendMessages(chatId: string, rows: ChatRow[]): Promise<number> {
  if (!Array.isArray(rows) || !rows.length) return 0;
  return api.post(`/chat/${encodeURIComponent(chatId)}/messages`, rows);
}

// Chat list/read for the chat:* IPC handlers.
export const listChats = (workspaceId: string, opts: { limit?: number; before?: number } = {}) => {
  const p = new URLSearchParams({ workspaceId });
  if (opts.limit) p.set('limit', String(opts.limit));
  if (opts.before) p.set('before', String(opts.before));
  return api.get(`/chats?${p}`);
};
export const listPinned = (workspaceId: string) => api.get(`/chats/pinned?workspaceId=${encodeURIComponent(workspaceId)}`);
export const searchChats = (workspaceId: string, query: string, opts: { limit?: number } = {}) => {
  const p = new URLSearchParams({ workspaceId, q: query });
  if (opts.limit) p.set('limit', String(opts.limit));
  return api.get(`/chats/search?${p}`);
};
export const getMessages = (chatId: string, after?: number) =>
  api.get(`/chat/${encodeURIComponent(chatId)}/messages${typeof after === 'number' ? `?after=${after}` : ''}`);
export const openChat = (chatId: string) => api.get(`/chat/${encodeURIComponent(chatId)}`);
export const setChatPinned = (chatId: string, pinned: boolean) => api.patch(`/chat/${encodeURIComponent(chatId)}/pinned`, { pinned });
export const deleteChat = (chatId: string) => api.del(`/chat/${encodeURIComponent(chatId)}`);

// Transcript JSONL (whole). The server keeps it so any machine can continue the
// chat. Upload after each turn; download on resume when the local file is absent.
export const putTranscript = (chatId: string, content: string): Promise<number> => api.patch(`/chat/${encodeURIComponent(chatId)}/transcript`, { content });
export const getTranscript = (chatId: string): Promise<string | null> => api.get(`/chat/${encodeURIComponent(chatId)}/transcript`);

// Cross-client execution flag. Set with this machine's name on agent_start; clear
// (machine=null) only AFTER the turn's rows + transcript are uploaded, so
// running=false on the server means "done and uploaded — safe to take over".
export const setRunning = (chatId: string, machine: string | null) => api.patch(`/chat/${encodeURIComponent(chatId)}/running`, { machine });

// Live feed: push one pi event to the companion, which fans it out over SSE to
// any other client watching this chat. Fire-and-forget; ephemeral (not stored).
export const postEvent = (chatId: string, event: any) => api.post(`/chat/${encodeURIComponent(chatId)}/events`, event);

// Reads behind the agent's `search_chats` tool. The desktop's agent runs locally
// but its chats live on the companion, so these go over HTTP.
export const searchChatMessages = (o: { workspaceId: string; query: string; limit: number; sort?: string; excludeChatId?: string }) => {
  const p = new URLSearchParams({ workspaceId: o.workspaceId, q: o.query, limit: String(o.limit) });
  if (o.sort) p.set('sort', o.sort);
  if (o.excludeChatId) p.set('exclude', o.excludeChatId);
  return api.get(`/chats/fulltext?${p}`);
};
export const readChatWindow = (o: { chatId: string; around?: number; window: number }) => {
  const p = new URLSearchParams({ window: String(o.window) });
  if (o.around != null) p.set('around', String(o.around));
  return api.get(`/chat/${encodeURIComponent(o.chatId)}/window?${p}`);
};
export const recentChats = (o: { workspaceId: string; limit: number; excludeChatId?: string }) => {
  const p = new URLSearchParams({ workspaceId: o.workspaceId, limit: String(o.limit) });
  if (o.excludeChatId) p.set('exclude', o.excludeChatId);
  return api.get(`/chats/recent?${p}`);
};
