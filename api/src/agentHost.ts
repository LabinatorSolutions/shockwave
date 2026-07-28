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
import type { DB } from './db.js';
import { getDb } from './db.js';
import * as store from './store.js';
import { mintToken } from './oauth.js';

const DATA_BASE = process.env.AGENT_DATA_DIR || path.join(os.tmpdir(), 'shockwave-agent');
const BUILTIN_DIR = process.env.BUILTIN_SKILLS_DIR || path.join(DATA_BASE, 'builtins');

export function makeCompanionRuntime(pool: DB, key: Buffer) {
  const db = getDb(pool);
  // An (empty) builtins dir so listBuiltinSkills has something to read.
  try { fs.mkdirSync(BUILTIN_DIR, { recursive: true }); } catch { /* ok */ }

  const host: AgentHost = {
    builtinDir: BUILTIN_DIR,
    machine: os.hostname(),
    extraTools: [],
    // Per-run scratch dir so concurrent runs don't share pi's settings.json.
    dataDir: (sessionId) => path.join(DATA_BASE, 'runs', sessionId),
    getSession: (id) => store.getSession(db, id),
    upsertSession: (row) => store.upsertSession(db, { ...row, now: Date.now() } as any),
    persistMessages: (id, rows) => store.persistMessages(db, id, rows as any),
    setSessionTitle: (id, title) => store.setSessionTitle(db, id, title),
    setRunning: (id, machine) => store.setRunning(db, id, machine),
    getTranscript: (id) => store.getTranscript(db, id),
    putTranscript: (id, content) => store.putTranscript(db, id, content),
    getAgentSecrets: async () => (await store.readSettings(db, key)).agentSecrets ?? [],
    getToken: (name: string) => mintToken(db, key, name), // static or fresh OAuth
  };
  return createAgentRuntime(host);
}
