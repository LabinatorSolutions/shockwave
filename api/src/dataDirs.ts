// Where the companion keeps per-chat working files. Path math only — no db, no
// agent runtime, nothing that has to be running for these to be true.
//
// Split out of `agentHost.ts` because everything that needs a directory was
// having to import the whole agent host to get one, which drags in Postgres and
// pi. A module that answers "where do this chat's files go" should be loadable on
// its own, and testable without a database.
//
// All three live on the same `agent-data` volume and are reclaimed by the same
// TTL sweeper (`sweeper.ts`), keyed by chatId so a re-run reuses its own dirs.

import os from 'node:os';
import path from 'node:path';

export const DATA_BASE = process.env.AGENT_DATA_DIR || path.join(os.tmpdir(), 'shockwave-agent');

// Per-run pi scratch dirs (hold the JSONL), keyed by chatId. Kept across runs
// (reused on re-run); the TTL sweeper reclaims old ones.
export const RUNS_BASE = path.join(DATA_BASE, 'runs');
export function runScratchDir(chatId: string): string {
  return path.join(RUNS_BASE, chatId);
}

// Files the USER sent us (Telegram attachments), keyed by chatId. A sibling of
// RUNS_BASE, deliberately NOT inside it: that dir is pi's own working memory
// (settings.json + the session JSONL), and mixing user uploads into it makes the
// two indistinguishable to anything walking the tree.
//
// Outside the git checkout too, which is the point — an attachment is not part of
// the workspace until the agent is asked to put it there. Anything left here is
// never committed, and ages out.
export const FILES_BASE = path.join(DATA_BASE, 'files');
export function chatFilesDir(chatId: string): string {
  return path.join(FILES_BASE, chatId);
}
