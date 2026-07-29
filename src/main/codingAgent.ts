// Desktop host for the shared coding-agent runtime (agent-core/agent.ts).
//
// All the turn logic lives in agent-core now; this file just builds the DESKTOP
// AgentHost — pi's scratch dir is the app userData, events go to the renderer
// (the caller composes IPC + the live-feed POST into the `emit` it passes),
// persistence is the HTTP api/chats layer, and the one host-only tool is
// open_file. Secret getters are injected from main.ts (`initDesktopAgent`) to
// avoid a circular import back into main. The companion builds its own host in
// api/ and calls the same `createAgentRuntime`.

import os from 'node:os';
import { app } from 'electron';
import { createAgentRuntime, listThinkingLevels } from '../../agent-core/agent.js';
import type { AgentHost, RunOpts, Emit } from '../../agent-core/agent.js';
import { makeSendMessageTool } from '../../agent-core/sendMessage.js';
import { getChat, upsertChat, appendMessages, setChatTitle, setRunning, getTranscript, putTranscript,
  searchChatMessages, readChatWindow, recentChats } from './api/chats.js';
import { api } from './api/client.js';
import { OPEN_FILE_TOOL } from './openFileExtension.js';

// The desktop's `send_message`: same tool the companion offers, but the sending
// happens over there — the bot token never leaves the companion. Without this, a
// chat started in Telegram and continued here couldn't answer on Telegram.
const SEND_MESSAGE_TOOL = makeSendMessageTool(async (text) => {
  try {
    const res = await api.post('/telegram/send', { text });
    return res?.ok ? { ok: true } : { ok: false, error: res?.error || 'Could not send the message.' };
  } catch (e: any) {
    return { ok: false, error: `Could not reach the Shockwave server to send it: ${e?.message ?? e}` };
  }
});

let runtime: ReturnType<typeof createAgentRuntime> | null = null;

// Wire the desktop host. `getSecrets`/`getToken` are closures over settings +
// OAuth (built in main.ts); `builtinDir` is the bundled-skills path. Call once
// at startup, before any agent:send.
export function initDesktopAgent(deps: {
  builtinDir: string;
  getSecrets: () => Promise<any[]>;
  getToken: (name: string) => Promise<string>;
}) {
  const host: AgentHost = {
    builtinDir: deps.builtinDir,
    machine: os.hostname(),
    extraTools: [OPEN_FILE_TOOL, SEND_MESSAGE_TOOL],
    dataDir: () => app.getPath('userData'), // one global scratch dir on the desktop
    getChat,
    upsertChat,
    appendMessages,
    setChatTitle,
    setRunning,
    getTranscript,
    putTranscript,
    getAgentSecrets: deps.getSecrets,
    getToken: deps.getToken,
    // Backs the same single `search_chats` tool the companion's agent gets.
    chatSearch: { searchChats: searchChatMessages, readChat: readChatWindow, recentChats },
  };
  runtime = createAgentRuntime(host);
}

function rt() {
  if (!runtime) throw new Error('Desktop agent not initialized — call initDesktopAgent() at startup.');
  return runtime;
}

export const agentSend = (opts: RunOpts, emit: Emit) => rt().agentSend(opts, emit);
export const agentAbort = (chatId: string) => rt().agentAbort(chatId);
export const agentDisposeChat = (chatId: string) => rt().agentDisposeChat(chatId);
export const agentDisposeAll = () => (runtime ? runtime.agentDisposeAll() : Promise.resolve());
export const agentRunningChats = (): string[] => (runtime ? runtime.agentRunningChats() : []);
export { listThinkingLevels };
