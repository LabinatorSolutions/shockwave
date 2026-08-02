// One self-improvement run: take a chat that has done enough work, hand the
// agent that conversation, and let it update its own skills.
//
// This is `cronRun.ts` with a different trigger. Same shape throughout — claim a
// checkout, run one turn through the shared agent-core streaming to the feed
// under a watchdog, then land the work with `checkInWithFixer`. The differences
// are that the prompt is built from a stored conversation rather than read from
// `cron.json`, and that the run's tools are the narrow review set (see
// `toolsForSource` in agent-core/defaults/tools.ts).
//
// It is a NEW chat, not a turn in the one being reviewed. That keeps the
// reviewed conversation untouched — hermes shares its fork's session with the
// parent and needs a row of flags to stop the harness prompt leaking into the
// user's real transcript. Here a separate chat makes that impossible by
// construction.

import fs from 'node:fs/promises';
import path from 'node:path';
import type { PgPool } from './db.js';
import { getDb } from './db.js';
import * as store from './store.js';
import * as feed from './feed.js';
import { prepareCheckout, type GitAuth } from './git.js';
import { checkInWithFixer } from './gitFixer.js';
import { buildReviewPrompt } from '../../agent-core/defaults/reviewPrompt.js';
import { logger } from './log.js';

const log = logger('review');

export interface ReviewRunResult { chatId: string; checkIn: string; }

/**
 * Review `sourceChatId` in a fresh chat of its own.
 *
 * `reviewChatId` is minted by the caller so events route from the first
 * millisecond, exactly as cron does it.
 */
export async function runReview(
  pool: PgPool, key: Buffer, runtime: any,
  workspaceId: string, sourceChatId: string, reviewChatId: string,
): Promise<ReviewRunResult> {
  const db = getDb(pool);

  const workspaces = await store.listWorkspaces(db);
  const w = workspaces.find((x) => x.id === workspaceId);
  if (!w) throw new Error(`Unknown workspace ${workspaceId}`);

  const pat = await store.getSecret(db, key, 'settings', 'sync.pat');
  if (!pat) throw new Error('No sync PAT configured — cannot clone the workspace.');
  const auth: GitAuth = { pat, owner: w.repoOwner, repo: w.repoName };

  // The conversation being reviewed. Read BEFORE the checkout so a chat that
  // turns out to be empty costs nothing.
  const messages = await store.getMessages(db, sourceChatId);
  if (!messages.length) throw new Error(`Chat ${sourceChatId} has no messages to review.`);
  const prompt = buildReviewPrompt(messages as any);

  const dir = await prepareCheckout(reviewChatId, w.repoOwner, w.repoName, w.defaultBranch, pat);

  const settings = await store.readSettings(db, key);
  process.env.TZ = settings.timezone || 'UTC';   // optional setting → fallback at point of use
  const ca = settings.codingAgent ?? {};
  const apiKey = (ca.providerKeys ?? {})[ca.provider] ?? '';

  // Same per-workspace built-in toggles the other server-side runs honour.
  let wsBuiltinSkills: Record<string, any> = {};
  try {
    const raw = await fs.readFile(path.join(dir, '.shockwave', 'workspace.json'), 'utf8');
    wsBuiltinSkills = JSON.parse(raw)?.builtinSkills ?? {};
  } catch { /* no workspace file → defaults */ }

  const maxRunMs = (Number(ca.maxRunMinutes) || 30) * 60_000;
  log.info({ ws: workspaceId, source: sourceChatId, chatId: reviewChatId, messages: messages.length }, 'review run started');

  const watchdog = setTimeout(() => {
    log.warn({ chatId: reviewChatId, maxRunMs }, 'review watchdog fired — aborting turn');
    runtime.agentAbort(reviewChatId).catch(() => {});
  }, maxRunMs);

  let finalMessages: any[] | undefined;
  let turnError: any = null;
  try {
    await runtime.agentSend(
      {
        chatId: reviewChatId, text: prompt, workspaceId, workspacePath: dir,
        provider: ca.provider, model: ca.model, apiKey, baseUrl: ca.baseUrl,
        contextWindow: ca.contextWindow, thinkingLevel: ca.thinkingLevel ?? 'off',
        wsBuiltinSkills,
        // No user is present, and the tool set is the review one — both follow
        // from `source`, which is also part of the session cache key.
        unattended: true, source: 'review', sourceId: sourceChatId,
        cronTitle: 'Self-improvement review',
      },
      (event: any) => {
        if (event?.type === 'agent_end') finalMessages = event.messages;
        feed.publish(event);
      },
    );
  } catch (e) {
    // Caught so the check-in below still runs; rethrown after it.
    turnError = e;
  } finally {
    clearTimeout(watchdog);
  }

  const stamp = new Date().toISOString();
  // The same landing path cron and Telegram use — deterministic check-in,
  // git-fixer on a conflict, then push. A skill written into the checkout and
  // never pushed is a skill that does not exist: the sweeper reclaims the
  // directory on its TTL.
  const result = await checkInWithFixer(
    dir, w.defaultBranch, `Shockwave self-improvement — ${stamp}`, auth,
    { provider: ca.provider, model: ca.model, apiKey, baseUrl: ca.baseUrl },
    { attempts: Number(ca.maxFixAttempts) || 3, maxMs: maxRunMs },
  );
  log[result === 'conflict' || result === 'error' ? 'error' : 'info'](
    { ws: workspaceId, source: sourceChatId, chatId: reviewChatId, checkIn: result, turnFailed: !!turnError },
    'review run finished',
  );

  if (turnError) throw turnError;

  // A turn can end badly WITHOUT throwing — pi reports it as the last assistant
  // message's stopReason ('error' from the provider, 'aborted' from the
  // watchdog, 'length' on max tokens). Surface it so the caller logs a failure
  // rather than a silent success. After the check-in, so partial work is kept.
  const last = [...(finalMessages ?? [])].reverse().find((m: any) => m?.role === 'assistant');
  if (last && last.stopReason !== 'stop') {
    throw new Error(last.errorMessage || `the run ended early (${last.stopReason}).`);
  }

  return { chatId: reviewChatId, checkIn: result };
}
