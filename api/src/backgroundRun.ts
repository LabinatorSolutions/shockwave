// One unattended run over a stored conversation: clone a checkout, hand the
// agent that conversation with an instruction, land the work.
//
// ── This is mechanism, not policy ───────────────────────────────────────────
//
// Review and memory are separate processes and stay separate — different
// trigger, counter, mark, setting, instruction, tool set and chat. None of that
// is here. What IS here is the part that was never different: getting a
// checkout, running one turn under a watchdog, and pushing the result. That is
// the same operation whichever process asked for it, in the same way that both
// already share `checkInWithFixer` without being one process.
//
// It lived in two files first, and the diff between them was four string
// literals and their comments. The cost showed up immediately: `timezone` was
// passed by one and not the other, so a review run's prompt could not name the
// user's zone. Nobody decided that — it drifted, because there were two copies
// of one thing. There is one now, so the next field cannot be passed by half
// the callers.
//
// `cronRun.ts` deliberately stays its own file. It reads its prompt from
// `cron.json` in the checkout rather than from a stored chat, disposes one-time
// jobs, and delivers files the run produced — three things neither of these
// does. It shares the landing (`checkInWithFixer`), which is the part that
// matters.

import fs from 'node:fs/promises';
import path from 'node:path';
import type { PgPool } from './db.js';
import { getDb } from './db.js';
import * as store from './store.js';
import * as feed from './feed.js';
import { prepareCheckout, type GitAuth } from './git.js';
import { checkInWithFixer } from './gitFixer.js';
import { buildReviewPrompt } from '../../agent-core/defaults/reviewPrompt.js';
import { buildMemoryPrompt } from '../../agent-core/defaults/memoryPrompt.js';
import type { RenderableMessage } from '../../agent-core/defaults/conversation.js';
import { logger } from './log.js';

/** What makes one background process itself. Everything else is shared. */
export interface BackgroundKind {
  /** `chat.source`, and the name in the log. Also picks the run's tool set
   *  (`toolsForSource` in agent-core) — which is why it must be exactly the
   *  string the catalog scopes on. */
  source: 'review' | 'memory';
  /** The chat's title, and the commit subject. */
  title: string;
  /** The stored conversation → the instruction the run receives. */
  buildPrompt(messages: RenderableMessage[]): string;
}

export const REVIEW: BackgroundKind = {
  source: 'review',
  title: 'Review',
  buildPrompt: buildReviewPrompt,
};

export const MEMORY: BackgroundKind = {
  source: 'memory',
  title: 'Memory',
  buildPrompt: buildMemoryPrompt,
};

export interface BackgroundRunResult { chatId: string; checkIn: string; }

/**
 * Run `kind` over `sourceChatId`, in a fresh chat of its own.
 *
 * `runChatId` is minted by the caller so events route from the first
 * millisecond, exactly as cron does it.
 */
export async function runBackground(
  pool: PgPool, key: Buffer, runtime: any, kind: BackgroundKind,
  workspaceId: string, sourceChatId: string, runChatId: string,
): Promise<BackgroundRunResult> {
  const log = logger(kind.source);
  const db = getDb(pool);

  const workspaces = await store.listWorkspaces(db);
  const w = workspaces.find((x) => x.id === workspaceId);
  if (!w) throw new Error(`Unknown workspace ${workspaceId}`);

  const pat = await store.getSecret(db, key, 'settings', 'sync.pat');
  if (!pat) throw new Error('No sync PAT configured — cannot clone the workspace.');
  const auth: GitAuth = { pat, owner: w.repoOwner, repo: w.repoName };

  // The conversation being examined. Read BEFORE the checkout so a chat that
  // turns out to be empty costs nothing.
  const messages = await store.getMessages(db, sourceChatId);
  if (!messages.length) throw new Error(`Chat ${sourceChatId} has no messages to read.`);
  const prompt = kind.buildPrompt(messages as any);

  const dir = await prepareCheckout(runChatId, w.repoOwner, w.repoName, w.defaultBranch, pat);

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
  log.info({ ws: workspaceId, source: sourceChatId, chatId: runChatId, messages: messages.length }, 'run started');

  const watchdog = setTimeout(() => {
    log.warn({ chatId: runChatId, maxRunMs }, 'watchdog fired — aborting turn');
    runtime.agentAbort(runChatId).catch(() => {});
  }, maxRunMs);

  let finalMessages: any[] | undefined;
  let turnError: any = null;
  try {
    await runtime.agentSend(
      {
        chatId: runChatId, text: prompt, workspaceId, workspacePath: dir,
        provider: ca.provider, model: ca.model, apiKey, baseUrl: ca.baseUrl,
        contextWindow: ca.contextWindow, thinkingLevel: ca.thinkingLevel ?? 'off',
        wsBuiltinSkills,
        timezone: settings.timezone,
        // Both kinds need these: memory writes against the budgets, and review
        // does not write memory but its prompt CARRIES it — the usage line in
        // that block is generated from these numbers.
        memoryCharLimit: ca.memoryCharLimit, userCharLimit: ca.userCharLimit,
        // No user is present, and the tool set follows from `source`, which is
        // also part of the session cache key.
        unattended: true, source: kind.source, sourceId: sourceChatId,
        cronTitle: kind.title,
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
  // The same landing path cron and Telegram use. Work written into the checkout
  // and never pushed is work that does not exist: the sweeper reclaims the
  // directory on its TTL.
  const result = await checkInWithFixer(
    dir, w.defaultBranch, `Shockwave ${kind.source} — ${stamp}`, auth,
    { provider: ca.provider, model: ca.model, apiKey, baseUrl: ca.baseUrl },
    { attempts: Number(ca.maxFixAttempts) || 3, maxMs: maxRunMs },
  );
  log[result === 'conflict' || result === 'error' ? 'error' : 'info'](
    { ws: workspaceId, source: sourceChatId, chatId: runChatId, checkIn: result, turnFailed: !!turnError },
    'run finished',
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

  return { chatId: runChatId, checkIn: result };
}
