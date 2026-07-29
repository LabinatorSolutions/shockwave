// The COMPANION host for the shared agent-core runtime. Same contract the
// desktop implements, but the I/O is direct: persistence hits the drizzle store,
// events publish straight to the in-process feed, pi's scratch dir is per-run
// (isolates concurrent cron runs' skills settings), and there's no host-only
// tool. Secrets come from the store; OAuth token minting is Phase D (static
// tokens work now).

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createAgentRuntime } from '../../agent-core/agent.js';
import type { AgentHost } from '../../agent-core/agent.js';
import { initModelCatalog } from '../../agent-core/modelCatalog.js';
import type { DB } from './db.js';
import { getDb } from './db.js';
import * as store from './store.js';
import { mintToken } from './oauth.js';
import { makeSendMessageTool } from '../../agent-core/sendMessage.js';
import { sendTelegramMessage } from './telegram/sendTool.js';

const DATA_BASE = process.env.AGENT_DATA_DIR || path.join(os.tmpdir(), 'shockwave-agent');
// Bundled built-in skills, shipped into the image (BUILTIN_SKILLS_DIR) so the
// server agent has the SAME skills as the desktop; falls back to an empty dir.
const BUILTIN_DIR = process.env.BUILTIN_SKILLS_DIR || path.join(DATA_BASE, 'builtins');

// Per-run pi scratch dirs (hold the JSONL) live here, keyed by chatId. Kept
// across runs (reused on re-run); the TTL sweeper reclaims old ones.
export const RUNS_BASE = path.join(DATA_BASE, 'runs');
export function runScratchDir(chatId: string): string {
  return path.join(RUNS_BASE, chatId);
}

export function makeCompanionRuntime(pool: DB, key: Buffer) {
  const db = getDb(pool);
  // Ensure the builtins dir exists (shipped one, or empty fallback) + seed the
  // model-catalog disk cache, same as the desktop does at startup.
  try { fs.mkdirSync(BUILTIN_DIR, { recursive: true }); } catch { /* ok */ }
  initModelCatalog(DATA_BASE);

  const host: AgentHost = {
    builtinDir: BUILTIN_DIR,
    machine: os.hostname(),
    // Proactively DM the user on Telegram. The bot token lives here, so this
    // host sends directly; the desktop's copy of the tool posts to /telegram/send.
    extraTools: [makeSendMessageTool((text) => sendTelegramMessage(pool, key, text))],
    // Per-run scratch dir so concurrent runs don't share pi's settings.json.
    dataDir: (chatId) => runScratchDir(chatId),
    getChat: (id) => store.getChat(db, id),
    upsertChat: (row) => store.upsertChat(db, { ...row, now: Date.now() } as any),
    appendMessages: (id, rows) => store.appendMessages(db, id, rows as any),
    setChatTitle: (id, title) => store.setChatTitle(db, id, title),
    setRunning: (id, machine) => store.setRunning(db, id, machine),
    getTranscript: (id) => store.getTranscript(db, id),
    putTranscript: (id, content) => store.putTranscript(db, id, content),
    getAgentSecrets: async () => (await store.readSettings(db, key)).agentSecrets ?? [],
    getToken: (name: string) => mintToken(db, key, name), // static or fresh OAuth
    chatSearch: {
      searchChats: (o) => store.searchChatMessages(db, o.workspaceId, o.query, o.limit, o.sort, o.excludeChatId),
      readChat: (o) => store.readChatWindow(db, o.chatId, o.around, o.window),
      recentChats: (o) => store.recentChats(db, o.workspaceId, o.limit, o.excludeChatId),
    },
  };
  return createAgentRuntime(host);
}
