// The git-fixer agent. When the deterministic check-in hits a merge conflict or
// a push it can't clear, this LLM tool-loop takes over: a single run_git tool, a
// strict conflict-resolution prompt, and — critically — INDEPENDENT verification
// (we never trust the model's claim; we re-check the repo). Modeled on knack's
// gitFix, on pi instead of the AI SDK. This is a SEPARATE agent from the one that
// ran the turn.
//
// It runs AFTER the turn has replied, so nothing user-facing waits on it. That is
// why it is allowed to take its time — see gitFix below.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { createAgentSession, AuthStorage, ModelRegistry, SessionManager, DefaultResourceLoader } from '@earendil-works/pi-coding-agent';
import { resolveModel } from '../../agent-core/agent.js';
import { checkIn, syncAndPush, type CheckInResult, type GitAuth } from './git.js';

const exec = promisify(execFile);

export interface FixModel { provider: string; model: string; apiKey: string; baseUrl?: string }

/** How hard the fixer is allowed to try. Both come from settings at the call
 *  site; these are the point-of-use fallbacks (the companion stores no defaults).
 *  `maxMs` bounds the WHOLE loop, not each attempt — so "max run minutes" means
 *  what it says however many attempts it takes. */
export interface FixLimits { attempts?: number; maxMs?: number }
const DEFAULT_ATTEMPTS = 3;
const DEFAULT_MAX_MS = 30 * 60_000;

// The ONE way a companion agent run checks its work in. Every server-side agent
// path calls THIS, never git.ts's checkIn directly — cron and Telegram are the
// same operation with different triggers, and work that fails to land is the
// same loss whoever asked for it.
//
// Telegram used to call checkIn alone and discard the result. So a conflict left
// the turn's work committed-but-unpushed in the run's checkout, said nothing,
// and the NEXT message's prepareCheckout reset --hard'd it away — the failure
// and the evidence disappearing together. Two call sites, one of them missing
// half the policy, is exactly the shape that hides for months.
export async function checkInWithFixer(
  dir: string, branch: string, message: string, auth: GitAuth, m: FixModel, limits: FixLimits = {},
): Promise<CheckInResult> {
  const result = await checkIn(dir, branch, message, auth);
  if (result !== 'conflict') return result;
  // The deterministic merge left markers → hand to the fixer, which resolves and
  // commits with NO credentials of its own. The push is ours, after it verifies.
  const fixed = await gitFix(dir, branch, m, limits);
  return fixed ? await syncAndPush(dir, branch, auth) : 'conflict';
}

async function sh(dir: string, cmd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const r = await exec('bash', ['-c', `cd '${dir}' && ${cmd}`], { maxBuffer: 32 * 1024 * 1024 });
    return { stdout: r.stdout, stderr: r.stderr, exitCode: 0 };
  } catch (e: any) {
    return { stdout: e?.stdout ?? '', stderr: e?.stderr ?? String(e), exitCode: e?.code ?? 1 };
  }
}

async function buildModel(m: FixModel) {
  const authStorage = AuthStorage.inMemory();
  const modelRegistry = ModelRegistry.create(authStorage);
  let model: any;
  if (m.provider === 'openai-compatible') {
    modelRegistry.registerProvider('openai-compatible', {
      baseUrl: m.baseUrl, apiKey: m.apiKey || 'local', api: 'openai-completions',
      models: [{ id: m.model, name: m.model, reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 16384 }],
    });
    model = modelRegistry.find('openai-compatible', m.model);
  } else {
    authStorage.setRuntimeApiKey(m.provider, m.apiKey);
    model = await resolveModel(m.provider, m.model);
  }
  return model ? { model, authStorage, modelRegistry } : null;
}

// Run the fixer until the tree verifies clean, or we run out of attempts or time.
//
// ── Why retrying works ──────────────────────────────────────────────────────
// The FOLDER persists between attempts; only the agent's memory doesn't. So
// attempt 2 is not a repeat of attempt 1 — it opens a repo where whatever
// attempt 1 resolved is already resolved and committed, and carries on from
// there. Three conflicted files, two attempts: the first clears A and B, the
// second sees only C.
//
// The other reason verification fails is the concurrency this now permits: a
// second turn writing into the same folder while the fixer works. There the
// fixer was right and the tree simply moved afterwards — the next attempt just
// commits what appeared. (The prompt below tells it to expect exactly that.)
//
// ── Why the bound is time, not tool calls ───────────────────────────────────
// This used to abort the session at 12 tool calls. Resolving ONE conflicted file
// costs roughly seven, so the cap mostly severed legitimate work partway and
// called it a failure. The fixer runs after the turn has already replied, so
// nothing is waiting on it and there is no reason to hurry it. `maxMs` covers the
// only real hazard — a model looping forever on an unattended server — and it
// bounds the WHOLE loop, so the number means what it says regardless of attempts.
//
// Pushing is deliberately NOT this function's job: the fixer drives a
// model-controlled shell, so handing it the PAT (in the env, or embedded in the
// remote) would put the credential back inside the one process most exposed to
// whatever the conflicting content says. The caller pushes afterwards with
// git.ts's syncAndPush.
export async function gitFix(dir: string, branch: string, m: FixModel, limits: FixLimits = {}): Promise<boolean> {
  const attempts = Math.max(1, Number(limits.attempts) || DEFAULT_ATTEMPTS);
  const deadline = Date.now() + Math.max(1, Number(limits.maxMs) || DEFAULT_MAX_MS);

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await runFixerSession(dir, branch, m, remaining);
    // Never trust what the model said it did — re-read the repo. This also
    // re-runs after a session that failed to start at all, so a tree that was
    // already clean still reports success.
    if (await verify(dir)) return true;
  }
  return false;
}

// One fixer session, start to finish. Returns nothing — the caller verifies
// against the repo rather than against any claim made in here.
async function runFixerSession(dir: string, branch: string, m: FixModel, budgetMs: number): Promise<void> {
  try {
    const built = await buildModel(m);
    if (!built) return;

    const runGit: any = {
      name: 'run_git',
      label: 'Run Git',
      description: 'Run a shell command in the repo working directory. Returns stdout, stderr, and exitCode. Use for all git and file operations.',
      parameters: { type: 'object', properties: { cmd: { type: 'string', description: 'Shell command, e.g. `git status`.' } }, required: ['cmd'], additionalProperties: false },
      async execute(_id: string, params: any) {
        const r = await sh(dir, String(params?.cmd ?? ''));
        return { content: [{ type: 'text', text: JSON.stringify({ stdout: r.stdout.slice(0, 8000), stderr: r.stderr.slice(0, 4000), exitCode: r.exitCode }) }] };
      },
    };

    const stamp = Date.now();
    const agentDir = path.join(os.tmpdir(), 'shockwave-gitfix', String(stamp));
    const sessionManager = SessionManager.create(dir, path.join(agentDir, 'sessions'), { id: `gitfix-${stamp}` });
    const system =
      `You are recovering a git repository at your working directory. Your only goal: get the branch "${branch}" ` +
      `committed with a clean working tree. You have NO network credentials — do not fetch, pull or push; ` +
      `those are done for you after you finish, so a command that reaches the network will just fail. ` +
      `Use the run_git tool to inspect and act. Strategy: run \`git status\` first; ` +
      `resolve merge conflicts by editing files to keep both intents (remove all <<<<<<< ======= >>>>>>> markers) ` +
      `then stage and commit; abort hopelessly broken merges/rebases with \`git merge --abort\`/\`git rebase --abort\` ` +
      `and commit what is there. Stop as soon as \`git status\` is clean. Do not run commands unrelated to this goal. ` +
      // Another turn may now be running in this same folder — prepareCheckout no
      // longer wipes a folder holding unpushed work, so a second message can land
      // mid-repair. Without this the fixer meets files it has no account of and
      // treats them as damage: reverting them, or stopping short.
      `Another agent may be working in this same folder at the same time. It is rare, but files can appear or ` +
      `change while you are resolving — that is expected, it is not an error, and it is not something you caused. ` +
      `Fold them in and keep going until the tree is clean.`;
    const resourceLoader = new DefaultResourceLoader({ cwd: dir, agentDir, systemPromptOverride: () => system });
    await resourceLoader.reload();

    const { session } = await createAgentSession({
      cwd: dir, agentDir, model: built.model, authStorage: built.authStorage, modelRegistry: built.modelRegistry,
      sessionManager, resourceLoader, customTools: [runGit], tools: ['run_git'],
    });

    // The only bound on the session. Same mechanism the old step cap used —
    // session.abort() — driven by a clock instead of a tool-call counter.
    const watchdog = setTimeout(() => { try { session.abort(); } catch { /* */ } }, budgetMs);
    try { await session.prompt(`Recover branch "${branch}": resolve any conflicts and commit, leaving a clean working tree. Do not push. Start by inspecting the current state.`); } catch { /* */ }
    clearTimeout(watchdog);
    try { session.dispose(); } catch { /* */ }
  } catch { /* the caller verifies against the repo either way */ }
}

// Trust nothing the model said — confirm the tree is clean and no conflict
// markers survived. The "nothing unpushed" check is gone with the push itself:
// the caller does that step and reports its own result.
async function verify(dir: string): Promise<boolean> {
  const status = await sh(dir, 'git status --porcelain');
  if (status.stdout.trim().length > 0) return false;
  const markers = await sh(dir, "git grep -lE '^(<<<<<<<|=======|>>>>>>>)' -- . 2>/dev/null | head -1 || true");
  return markers.stdout.trim().length === 0;
}
