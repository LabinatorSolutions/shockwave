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
import { prepareCheckout, checkIn, syncAndPush } from './git.js';
import { gitFix } from './gitFixer.js';

export interface CronRunResult { chatId: string; checkIn: string; }

export async function runCronJob(
  pool: DB, key: Buffer, runtime: any,
  workspaceId: string, jobName: string, chatId: string,
): Promise<CronRunResult> {
  const db = getDb(pool);
  const workspaces = await store.listWorkspaces(db);
  const w = workspaces.find((x) => x.id === workspaceId);
  if (!w) throw new Error(`Unknown workspace ${workspaceId}`);
  const pat = await store.getSecret(db, key, 'settings', 'sync.pat');
  if (!pat) throw new Error('No sync PAT configured — cannot clone the workspace.');

  // Reuse-or-clone the checkout (reset to origin if it existed). Kept after the
  // run; the TTL sweeper reclaims idle dirs.
  const dir = await prepareCheckout(chatId, w.repoOwner, w.repoName, w.defaultBranch, pat);

  const raw = await fs.readFile(path.join(dir, 'cron.json'), 'utf8').catch(() => '[]');
  let jobs: any[]; try { jobs = JSON.parse(raw); } catch { jobs = []; }
  const job = Array.isArray(jobs) ? jobs.find((j) => j?.name === jobName) : null;
  if (!job || !job.prompt) throw new Error(`No cron job named "${jobName}" with a prompt in cron.json.`);

  const settings = await store.readSettings(db, key);
  // Unified system timezone → the agent's "current date" (pi reads local tz).
  process.env.TZ = settings.timezone || 'UTC';   // optional setting → fallback at point of use
  const ca = settings.codingAgent ?? {};
  const apiKey = (ca.providerKeys ?? {})[ca.provider] ?? '';

  // Per-workspace built-in-skill on/off map, from the checkout's workspace file
  // (.shockwave/ syncs), so the server agent honors the same skill exceptions
  // as the desktop.
  let wsBuiltinSkills: Record<string, any> = {};
  try {
    const wsRaw = await fs.readFile(path.join(dir, '.shockwave', 'workspace.json'), 'utf8');
    wsBuiltinSkills = JSON.parse(wsRaw)?.builtinSkills ?? {};
  } catch { /* no workspace file → defaults */ }

  // Hung-run watchdog: abort a turn that exceeds CRON_MAX_RUN_MINUTES so a stuck
  // provider or runaway tool loop can't wedge the run forever (the aborted turn's
  // partial output is still persisted + checked in below).
  const maxRunMs = (Number(process.env.CRON_MAX_RUN_MINUTES) || 30) * 60_000;
  const watchdog = setTimeout(() => { runtime.agentAbort(chatId).catch(() => {}); }, maxRunMs);
  let finalMessages: any[] | undefined;
  try {
    await runtime.agentSend(
      {
        chatId, text: job.prompt, workspaceId, workspacePath: dir,
        provider: ca.provider, model: ca.model, apiKey, baseUrl: ca.baseUrl,
        contextWindow: ca.contextWindow, thinkingLevel: ca.thinkingLevel ?? 'off',
        wsBuiltinSkills,
        unattended: true, source: 'cron', cronTitle: jobName,
      },
      (event: any) => {
        if (event?.type === 'agent_end') finalMessages = event.messages;
        feed.publish(event);
      },
    );
  } finally {
    clearTimeout(watchdog);
  }

  const stamp = new Date().toISOString();
  let result = await checkIn(dir, w.defaultBranch, `Shockwave cron: ${jobName} — ${stamp}`, pat);
  // Deterministic path couldn't resolve it → hand to the git-fixer agent. It
  // resolves and commits with no credentials of its own; the push is ours,
  // after it verifies clean (see gitFixer.ts).
  if (result === 'conflict') {
    const fixed = await gitFix(dir, w.defaultBranch, {
      provider: ca.provider, model: ca.model, apiKey, baseUrl: ca.baseUrl,
    });
    result = fixed ? await syncAndPush(dir, w.defaultBranch, pat) : 'conflict';
  }

  // A turn can end badly WITHOUT throwing: pi reports it as the last assistant
  // message's stopReason ('error' from the provider, 'aborted' from the watchdog
  // above, 'length' on max tokens). Throw so the caller's catch records it as a
  // failed run instead of a silent success. After the check-in, so partial work
  // is still committed.
  const last = [...(finalMessages ?? [])].reverse().find((m: any) => m?.role === 'assistant');
  if (last && last.stopReason !== 'stop') throw new Error(last.errorMessage || `the run ended early (${last.stopReason}).`);

  return { chatId, checkIn: result };
}
