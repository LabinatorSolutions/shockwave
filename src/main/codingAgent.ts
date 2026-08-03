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
import fs from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
import { createAgentRuntime, listThinkingLevels } from '../../agent-core/agent.js';
import type { AgentHost, RunOpts, Emit } from '../../agent-core/agent.js';
import type { VoiceConfig } from '../../agent-core/voiceProviders.js';
import { makeSendMessageTool, type SendOutput } from '../../agent-core/sendMessage.js';
import { readVoiceReply, writeVoiceReply } from '../../agent-core/voiceReply.js';
import { sweepScratchDirs } from '../../agent-core/scratchSweep.js';
import { getChat, upsertChat, appendMessages, setChatTitle, setRunning, getTranscript, putTranscript,
  searchChatMessages, readChatWindow, recentChats } from './api/chats.js';
import { api } from './api/client.js';
import { OPEN_FILE_TOOL } from './openFileExtension.js';

// The desktop's `send_message`: same tool the companion offers, but the sending
// happens over there — the bot token never leaves the companion. Without this, a
// chat started in Telegram and continued here couldn't answer on Telegram.
// The reply MODE is read and written HERE, against this machine's checkout —
// the copy the turn is running in — and the existing GitHub sync carries a change
// to the companion's copy. The companion does the same against its own checkout.
// One rule, no coordination, and no way for the two sides to write different
// files for the same request.
//
// Delivery and synthesis still happen over there: the bot token and ffmpeg are
// both companion-only. So this resolves the mode locally and sends it EXPLICITLY,
// which also means the server never has to guess a workspace it can't see.
function makeDesktopSendTool(workspacePath: string) {
  return makeSendMessageTool(async (text, opts) => {
    let savedMode: SendOutput | undefined;
    let saveFailed = false;
    if (opts.save && opts.output) {
      if (await writeVoiceReply(workspacePath, opts.output)) savedMode = opts.output;
      else saveFailed = true;
    }
    const output = opts.output ?? await readVoiceReply(workspacePath);
    try {
      const res = await api.post('/telegram/send', { text, output });
      if (!res?.ok) return { ok: false, error: res?.error || 'Could not send the message.' };
      return { ok: true, ...(savedMode ? { savedMode } : {}), ...(saveFailed ? { saveFailed } : {}) };
    } catch (e: any) {
      return { ok: false, error: `Could not reach the Shockwave server to send it: ${e?.message ?? e}` };
    }
  });
}

// The agent's own directory for a chat — working files and anything it is
// producing to send rather than to keep. Kept OUT of the workspace, because the
// workspace is committed and synced: without this, a temp file the agent made
// lands in the user's repo. Per chat so two running chats can't collide.
//
// The companion's equivalent is the same directory its inbound attachments land
// in; here nothing arrives from outside, so it starts empty.
const SCRATCH_BASE = () => path.join(app.getPath('userData'), 'agent-scratch');
const chatScratchDir = (chatId: string) => path.join(SCRATCH_BASE(), chatId);

/**
 * Delete scratch directories nobody has touched for `ttlDays`, except the ones
 * belonging to pinned chats.
 *
 * Fire-and-forget at startup, never awaited on the boot path — reclaiming disk is
 * not worth delaying the window by even the time it takes to stat a directory.
 * The rule is the shared one (`agent-core/scratchSweep.ts`), so this and the
 * companion's hourly sweeper delete by the same standard: pinning a chat keeps
 * everything that chat owns, on every machine.
 *
 * `pinned` comes from the companion — it is the only place that flag exists — so
 * the caller must skip this entirely when it can't be read. Sweeping with an
 * empty set would mean an offline launch deletes exactly what pinning promised
 * to keep.
 */
export function sweepAgentScratch(ttlDays: unknown, pinned: ReadonlySet<string>): void {
  void (async () => {
    const [removed] = await sweepScratchDirs([SCRATCH_BASE()], { ttlDays, keep: pinned });
    if (removed) console.log(`[agent] swept ${removed} stale scratch dir(s)`);
  })();
}

/** Drop one chat's scratch pad. Called when the chat itself is deleted. */
export async function removeAgentScratch(chatId: string): Promise<void> {
  await fs.rm(chatScratchDir(chatId), { recursive: true, force: true }).catch(() => { /* best-effort */ });
}

let runtime: ReturnType<typeof createAgentRuntime> | null = null;

// Wire the desktop host. `getSecrets`/`getToken` are closures over settings +
// OAuth (built in main.ts); `builtinDir` is the bundled-skills path. Call once
// at startup, before any agent:send.
export function initDesktopAgent(deps: {
  builtinDir: string;
  getSecrets: () => Promise<any[]>;
  getToken: (name: string) => Promise<string>;
  getVoiceConfig: () => Promise<VoiceConfig>;
}) {
  const host: AgentHost = {
    builtinDir: deps.builtinDir,
    machine: os.hostname(),
    extraTools: ({ workspacePath }) => [OPEN_FILE_TOOL, makeDesktopSendTool(workspacePath)],
    dataDir: () => app.getPath('userData'), // one global pi scratch dir on the desktop
    scratchDir: (chatId) => chatScratchDir(chatId),
    getVoiceConfig: deps.getVoiceConfig,
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
