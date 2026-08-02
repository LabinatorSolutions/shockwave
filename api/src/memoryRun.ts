// One memory run: take a chat that has done enough talking, hand the agent that
// conversation, and let it write down what it learned about the user.
//
// This is `reviewRun.ts` with a different prompt and a narrower tool set — and
// they are separate files rather than one parameterised runner on purpose. They
// are two processes: different trigger, different counter, different mark,
// different instruction, different chat. The only thing they genuinely share is
// the landing sequence every server-side agent path shares (claim a checkout,
// one turn under a watchdog, `checkInWithFixer`), and that is already factored
// out into the functions both call.
//
// What it may do is deliberately tiny. `toolsForSource('memory')` is the single
// name `memory` — no read, no grep, no bash. It has nothing to look up: its
// input is the conversation it was handed, and the current memory is already in
// its system prompt, rendered from disk at the boot of this very run.

import fs from 'node:fs/promises';
import path from 'node:path';
import type { PgPool } from './db.js';
import { getDb } from './db.js';
import * as store from './store.js';
import * as feed from './feed.js';
import { prepareCheckout, type GitAuth } from './git.js';
import { checkInWithFixer } from './gitFixer.js';
import { buildMemoryPrompt } from '../../agent-core/defaults/memoryPrompt.js';
import { logger } from './log.js';

const log = logger('memory');

export interface MemoryRunResult { chatId: string; checkIn: string; }

/**
 * Look over `sourceChatId` for facts about the user, in a fresh chat of its own.
 *
 * `memoryChatId` is minted by the caller so events route from the first
 * millisecond, exactly as cron and review do it.
 */
export async function runMemory(
  pool: PgPool, key: Buffer, runtime: any,
  workspaceId: string, sourceChatId: string, memoryChatId: string,
): Promise<MemoryRunResult> {
  const db = getDb(pool);

  const workspaces = await store.listWorkspaces(db);
  const w = workspaces.find((x) => x.id === workspaceId);
  if (!w) throw new Error(`Unknown workspace ${workspaceId}`);

  const pat = await store.getSecret(db, key, 'settings', 'sync.pat');
  if (!pat) throw new Error('No sync PAT configured — cannot clone the workspace.');
  const auth: GitAuth = { pat, owner: w.repoOwner, repo: w.repoName };

  // The conversation being looked at. Read BEFORE the checkout so a chat that
  // turns out to be empty costs nothing.
  const messages = await store.getMessages(db, sourceChatId);
  if (!messages.length) throw new Error(`Chat ${sourceChatId} has no messages to read.`);
  const prompt = buildMemoryPrompt(messages as any);

  const dir = await prepareCheckout(memoryChatId, w.repoOwner, w.repoName, w.defaultBranch, pat);

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
  log.info({ ws: workspaceId, source: sourceChatId, chatId: memoryChatId, messages: messages.length }, 'memory run started');

  const watchdog = setTimeout(() => {
    log.warn({ chatId: memoryChatId, maxRunMs }, 'memory watchdog fired — aborting turn');
    runtime.agentAbort(memoryChatId).catch(() => {});
  }, maxRunMs);

  let finalMessages: any[] | undefined;
  let turnError: any = null;
  try {
    await runtime.agentSend(
      {
        chatId: memoryChatId, text: prompt, workspaceId, workspacePath: dir,
        provider: ca.provider, model: ca.model, apiKey, baseUrl: ca.baseUrl,
        contextWindow: ca.contextWindow, thinkingLevel: ca.thinkingLevel ?? 'off',
        wsBuiltinSkills,
        timezone: settings.timezone,
        // The budgets this run writes against have to be the ones the rest of
        // the app enforces, or it would consolidate to a size the next desktop
        // turn considers over the limit.
        memoryCharLimit: ca.memoryCharLimit, userCharLimit: ca.userCharLimit,
        // No user is present, and the tool set is the memory one — both follow
        // from `source`, which is also part of the session cache key.
        unattended: true, source: 'memory', sourceId: sourceChatId,
        cronTitle: 'Memory',
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
  // The same landing path cron, Telegram and review use. A memory entry written
  // into the checkout and never pushed is an entry that does not exist: the
  // sweeper reclaims the directory on its TTL.
  const result = await checkInWithFixer(
    dir, w.defaultBranch, `Shockwave memory — ${stamp}`, auth,
    { provider: ca.provider, model: ca.model, apiKey, baseUrl: ca.baseUrl },
    { attempts: Number(ca.maxFixAttempts) || 3, maxMs: maxRunMs },
  );
  log[result === 'conflict' || result === 'error' ? 'error' : 'info'](
    { ws: workspaceId, source: sourceChatId, chatId: memoryChatId, checkIn: result, turnFailed: !!turnError },
    'memory run finished',
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

  return { chatId: memoryChatId, checkIn: result };
}
