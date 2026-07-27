// One cron run, server-side: fresh shallow clone → run the turn through the
// shared agent-core (streaming to the feed, persisting to the store) → a
// deterministic check-in of whatever the agent changed → delete the checkout.
// The scheduler (Phase C) and the manual run endpoint both call runCronJob.

import fs from 'node:fs/promises';
import path from 'node:path';
import type { DB } from './db.js';
import { getDb } from './db.js';
import * as store from './store.js';
import * as feed from './feed.js';
import { cloneForRun, checkIn, cleanup } from './git.js';

export interface CronRunResult { sessionId: string; checkIn: string; }

export async function runCronJob(
  pool: DB, key: Buffer, runtime: any,
  workspaceId: string, jobName: string, sessionId: string,
): Promise<CronRunResult> {
  const db = getDb(pool);
  const workspaces = await store.listWorkspaces(db);
  const w = workspaces.find((x) => x.id === workspaceId);
  if (!w) throw new Error(`Unknown workspace ${workspaceId}`);
  const pat = await store.getSecret(db, key, 'settings', 'sync.pat');
  if (!pat) throw new Error('No sync PAT configured — cannot clone the workspace.');

  const dir = await cloneForRun(sessionId, w.repoOwner, w.repoName, w.defaultBranch, pat);
  try {
    const raw = await fs.readFile(path.join(dir, 'cron.json'), 'utf8').catch(() => '[]');
    let jobs: any[]; try { jobs = JSON.parse(raw); } catch { jobs = []; }
    const job = Array.isArray(jobs) ? jobs.find((j) => j?.name === jobName) : null;
    if (!job || !job.prompt) throw new Error(`No cron job named "${jobName}" with a prompt in cron.json.`);

    const settings = await store.readSettings(db, key);
    const ca = settings.codingAgent ?? {};
    const apiKey = (ca.providerKeys ?? {})[ca.provider] ?? '';

    await runtime.agentSend(
      {
        sessionId, text: job.prompt, workspaceId, workspacePath: dir,
        provider: ca.provider, model: ca.model, apiKey, baseUrl: ca.baseUrl,
        contextWindow: ca.contextWindow, thinkingLevel: ca.thinkingLevel,
        unattended: true, source: 'cron', cronTitle: jobName,
      },
      (event: any) => feed.publish(event.sessionId, event),
    );

    const stamp = new Date().toISOString();
    const result = await checkIn(dir, w.defaultBranch, `Shockwave cron: ${jobName} — ${stamp}`);
    return { sessionId, checkIn: result };
  } finally {
    await cleanup(dir);
  }
}
