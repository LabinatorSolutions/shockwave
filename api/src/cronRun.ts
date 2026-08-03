// One cron run, server-side: fresh shallow clone → run the turn through the
// shared agent-core (streaming to the feed, persisting to the store) → a
// deterministic check-in of whatever the agent changed → delete the checkout.
// The scheduler (Phase C) and the manual run endpoint both call runCronJob.

import fs from 'node:fs/promises';
import path from 'node:path';
import type { PgPool } from './db.js';
import { getDb } from './db.js';
import * as store from './store.js';
import * as feed from './feed.js';
import { prepareCheckout, landed, type GitAuth } from './git.js';
import { checkInAndStamp } from './gitFixer.js';
import { chatFilesDir } from './dataDirs.js';
import { sendTelegramFile } from './telegram/sendTool.js';
import {
  extractMedia, extractLocalFiles, filterDeliveryPaths, deliveryKind,
} from '../../agent-core/mediaTags.ts';
import { logger, errStr } from './log.js';

const log = logger('cron');

export interface CronRunResult { chatId: string; checkIn: string; }

// Remove a job from the checkout's cron.json. Nothing else is needed to retire a
// one-time job: the run's own check-in commits and pushes this, and the next
// scheduler reconcile sees the entry gone and drops the registration. Re-read
// from disk rather than reusing the parse above — the turn may have edited the
// file itself.
async function dropJob(dir: string, jobName: string): Promise<void> {
  const file = path.join(dir, 'cron.json');
  try {
    const jobs = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!Array.isArray(jobs)) return;
    const kept = jobs.filter((j: any) => j?.name !== jobName);
    if (kept.length === jobs.length) return;
    await fs.writeFile(file, `${JSON.stringify(kept, null, 2)}\n`);
  } catch { /* unreadable/unwritable → the entry stays; harmless, it can't fire again */ }
}

export async function runCronJob(
  pool: PgPool, key: Buffer, runtime: any,
  workspaceId: string, jobName: string, chatId: string,
): Promise<CronRunResult> {
  const db = getDb(pool);
  const workspaces = await store.listWorkspaces(db);
  const w = workspaces.find((x) => x.id === workspaceId);
  if (!w) throw new Error(`Unknown workspace ${workspaceId}`);
  const pat = await store.getSecret(db, key, 'settings', 'sync.pat');
  if (!pat) throw new Error('No sync PAT configured — cannot clone the workspace.');
  // Carried together so every network git call is pinned to THIS repo — the URL
  // is set from it on the command line rather than read from a .git/config the
  // agent can rewrite. See guards() in git.ts.
  const auth: GitAuth = { pat, owner: w.repoOwner, repo: w.repoName };

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

  // Hung-run watchdog: abort a turn that exceeds `codingAgent.maxRunMinutes` so a stuck
  // provider or runaway tool loop can't wedge the run forever (the aborted turn's
  // partial output is still persisted + checked in below).
  const maxRunMs = (Number(ca.maxRunMinutes) || 30) * 60_000;
  log.info({ ws: workspaceId, job: jobName, chatId }, 'cron run started');
  const watchdog = setTimeout(() => {
    log.warn({ ws: workspaceId, job: jobName, chatId, maxRunMs }, 'cron watchdog fired — aborting turn');
    runtime.agentAbort(chatId).catch(() => {});
  }, maxRunMs);
  let finalMessages: any[] | undefined;
  let turnText = '';
  let turnError: any = null;
  try {
    await runtime.agentSend(
      {
        chatId, text: job.prompt, workspaceId, workspacePath: dir,
        provider: ca.provider, model: ca.model, apiKey, baseUrl: ca.baseUrl,
        contextWindow: ca.contextWindow, thinkingLevel: ca.thinkingLevel ?? 'off',
        wsBuiltinSkills,
        unattended: true, source: 'cron', cronTitle: jobName,
        timezone: settings.timezone,   // same zone the scheduler evaluates cron.json in
        // Same budgets every other run writes against — see RunOpts in agent-core.
        memoryCharLimit: ca.memoryCharLimit, userCharLimit: ca.userCharLimit,
      },
      (event: any) => {
        if (event?.type === 'agent_end') finalMessages = event.messages;
        // Everything the agent said this run, for file delivery below. Built from
        // the deltas rather than agent_end, whose `messages` is pi's whole session
        // — scanning that would re-send a file on every later run of the job.
        if (event?.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
          turnText += event.assistantMessageEvent.delta ?? event.assistantMessageEvent.text ?? '';
        }
        feed.publish(event);
      },
    );
  } catch (e) {
    // Caught rather than propagated so the disposal + check-in below still run;
    // rethrown after them.
    turnError = e;
  } finally {
    clearTimeout(watchdog);
  }

  // A one-time job disposes of itself — success or failure. It can't fire again
  // either way (croner is done with a date pattern once it passes), so skipping
  // this on failure wouldn't re-run anything; it would just leave a dead line in
  // cron.json for the user to clean up.
  if (job.once) await dropJob(dir, jobName);

  const stamp = new Date().toISOString();
  // Shared with the Telegram path — deterministic check-in, git-fixer on a
  // conflict, push. See checkInWithFixer in gitFixer.ts.
  const result = await checkInAndStamp(
    db, chatId,
    dir, w.defaultBranch, `Shockwave cron: ${jobName} — ${stamp}`, auth,
    { provider: ca.provider, model: ca.model, apiKey, baseUrl: ca.baseUrl },
    { attempts: Number(ca.maxFixAttempts) || 3, maxMs: maxRunMs },
  );
  log[landed(result) ? 'info' : 'error'](
    { ws: workspaceId, job: jobName, chatId, checkIn: result, turnFailed: !!turnError }, 'cron run finished',
  );

  // Files the job produced and asked to send. A scheduled run posts no reply to
  // Telegram — the agent reaches the user with `send_message` — so a file it named
  // is delivered on its own rather than attached to a message that isn't going
  // anywhere. Best-effort: a delivery problem must not turn a successful run into
  // a failed one.
  await deliverCronFiles(pool, key, turnText, [dir, chatFilesDir(chatId)])
    .catch((e) => log.warn({ ws: workspaceId, job: jobName, chatId, err: errStr(e) }, 'file delivery failed'));

  if (turnError) throw turnError;

  // A turn can end badly WITHOUT throwing: pi reports it as the last assistant
  // message's stopReason ('error' from the provider, 'aborted' from the watchdog
  // above, 'length' on max tokens). Throw so the caller's catch records it as a
  // failed run instead of a silent success. After the check-in, so partial work
  // is still committed.
  const last = [...(finalMessages ?? [])].reverse().find((m: any) => m?.role === 'assistant');
  if (last && last.stopReason !== 'stop') throw new Error(last.errorMessage || `the run ended early (${last.stopReason}).`);

  return { chatId, checkIn: result };
}

/**
 * Send any files the run named, from `roots` and nowhere else.
 *
 * The two passes are CHAINED — the bare-path scan reads what the tag scan already
 * cleaned — so a path written as `MEDIA:/x.pdf` is not also found as a bare
 * `/x.pdf` and delivered twice.
 */
async function deliverCronFiles(pool: PgPool, key: Buffer, turnText: string, roots: string[]): Promise<void> {
  if (!turnText.trim()) return;
  const tagged = extractMedia(turnText);
  const bare = await extractLocalFiles(tagged.cleaned);
  const wanted = [...tagged.media, ...bare.paths.map((p) => ({ path: p, isVoice: false }))];
  const files = await filterDeliveryPaths(wanted, roots);
  for (const f of files) {
    await sendTelegramFile(
      pool, key, f.path,
      deliveryKind(f.path, { isVoice: f.isVoice, forceDocument: tagged.forceDocument }),
    );
  }
}
