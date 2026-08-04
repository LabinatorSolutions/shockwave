// The COMPANION host for the shared agent-core runtime. Same contract the
// desktop implements, but the I/O is direct: persistence hits the drizzle store,
// events publish straight to the in-process feed, pi's scratch dir is per-run
// (isolates concurrent cron runs' skills settings), and there's no host-only
// tool. Secrets come from the store; OAuth token minting is Phase D (static
// tokens work now).

import os from 'node:os';
import path from 'node:path';
import { DATA_BASE, runScratchDir, chatFilesDir } from './dataDirs.js';
import fs from 'node:fs';
import { createAgentRuntime } from '../../agent-core/agent.js';
import type { AgentHost } from '../../agent-core/agent.js';
import { initModelCatalog } from '../../agent-core/modelCatalog.js';
import type { PgPool } from './db.js';
import { getDb } from './db.js';
import * as store from './store.js';
import { mintToken } from './oauth.js';
import { makeSendMessageTool } from '../../agent-core/sendMessage.js';
import { OPEN_FILE_STUB } from './openFileStub.js';
import { voiceConfigOf } from '../../agent-core/voiceProviders.js';
import { sendTelegramMessage } from './telegram/sendTool.js';
import { logger, errStr } from './log.js';

const alog = logger('agent');

// Bundled built-in skills, shipped into the image (BUILTIN_SKILLS_DIR) so the
// server agent has the SAME skills as the desktop; falls back to an empty dir.
const BUILTIN_DIR = process.env.BUILTIN_SKILLS_DIR || path.join(DATA_BASE, 'builtins');

export function makeCompanionRuntime(pool: PgPool, key: Buffer) {
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
    //
    // Built per session rather than once, because the reply mode is per WORKSPACE
    // and the host is built once per process — so the tool has to be told which
    // workspace this turn belongs to in order to read that preference. It cannot
    // write it; that is `/voice`. The chat travels with it for the same reason in
    // reverse: each bubble is recorded against the conversation that sent it, so
    // replying to one comes back HERE rather than to whatever chat the bot was
    // last pointed at.
    extraTools: ({ chatId, workspaceId, workspacePath }) => [
      makeSendMessageTool((text, opts) => sendTelegramMessage(pool, key, text, {
        ...opts, chatId, workspaceId, workDir: workspacePath,
      })),
      // Registered so the catalog the prompt lists and the tools pi holds are the
      // same set. It cannot work here and says so; the gate refuses the call
      // first anyway. See openFileStub.ts.
      OPEN_FILE_STUB,
    ],
    // Per-run scratch dir so concurrent runs don't share pi's settings.json.
    dataDir: (chatId) => runScratchDir(chatId),
    // The same directory inbound Telegram attachments are written to, so a file
    // the user sent and a file the agent made sit together — which is what the
    // agent is told, and what delivery reads from.
    scratchDir: (chatId) => chatFilesDir(chatId),
    getVoiceConfig: async () => voiceConfigOf(await store.readSettings(db, key)),
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
  const runtime = createAgentRuntime(host);

  // Log every turn's boundary. Picked fields only — the payload carries the
  // provider API key, so it must never be logged whole.
  const agentSend = async (payload: any, emit: any) => {
    const t0 = Date.now();
    const ctx = {
      chatId: payload?.chatId, source: payload?.source, ws: payload?.workspaceId,
      provider: payload?.provider, model: payload?.model,
    };
    alog.info(ctx, 'agent turn started');
    try {
      const r = await runtime.agentSend(payload, emit);
      alog.info({ ...ctx, ms: Date.now() - t0 }, 'agent turn finished');
      return r;
    } catch (e: any) {
      alog.error({ ...ctx, ms: Date.now() - t0, err: errStr(e) }, 'agent turn failed');
      throw e;
    }
  };
  return { ...runtime, agentSend };
}
