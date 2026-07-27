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
import { getSession, upsertSession, persistMessages, setSessionTitle, setRunning, getTranscript, putTranscript } from './api/chats.js';
import { OPEN_FILE_TOOL } from './openFileExtension.js';

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
    extraTools: [OPEN_FILE_TOOL],
    dataDir: () => app.getPath('userData'), // one global scratch dir on the desktop
    getSession,
    upsertSession,
    persistMessages,
    setSessionTitle,
    setRunning,
    getTranscript,
    putTranscript,
    getAgentSecrets: deps.getSecrets,
    getToken: deps.getToken,
  };
  runtime = createAgentRuntime(host);
}

function rt() {
  if (!runtime) throw new Error('Desktop agent not initialized — call initDesktopAgent() at startup.');
  return runtime;
}

export const agentSend = (opts: RunOpts, emit: Emit) => rt().agentSend(opts, emit);
export const agentAbort = (sessionId: string) => rt().agentAbort(sessionId);
export const agentDisposeSession = (sessionId: string) => rt().agentDisposeSession(sessionId);
export const agentDisposeAll = () => (runtime ? runtime.agentDisposeAll() : Promise.resolve());
export const agentRunningSessions = (): string[] => (runtime ? runtime.agentRunningSessions() : []);
export { listThinkingLevels };
