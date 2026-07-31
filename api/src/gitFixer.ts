// The git-fixer agent. When the deterministic check-in hits a merge conflict or
// a push it can't clear, this bounded LLM tool-loop takes over: a single run_git
// tool, a strict conflict-resolution prompt, a hard step cap, and — critically —
// INDEPENDENT verification (we never trust the model's claim; we re-check the
// repo). Modeled on knack's gitFix, on pi instead of the AI SDK. This is a
// SEPARATE agent from the one that ran the turn.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { createAgentSession, AuthStorage, ModelRegistry, SessionManager, DefaultResourceLoader } from '@earendil-works/pi-coding-agent';
import { resolveModel } from '../../agent-core/agent.js';
import { checkIn, syncAndPush, type CheckInResult, type GitAuth } from './git.js';

const exec = promisify(execFile);
const MAX_STEPS = 12; // seatbelt: give up if it can't finish in this many tool calls

export interface FixModel { provider: string; model: string; apiKey: string; baseUrl?: string }

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
  dir: string, branch: string, message: string, auth: GitAuth, m: FixModel,
): Promise<CheckInResult> {
  const result = await checkIn(dir, branch, message, auth);
  if (result !== 'conflict') return result;
  // The deterministic merge left markers → hand to the fixer, which resolves and
  // commits with NO credentials of its own. The push is ours, after it verifies.
  const fixed = await gitFix(dir, branch, m);
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

// Returns true only if, after the loop, the working tree is genuinely clean and
// carries no leftover conflict markers. Pushing is deliberately NOT this
// function's job: the fixer drives a model-controlled shell, so handing it the
// PAT (in the env, or embedded in the remote) would put the credential back
// inside the one process most exposed to whatever the conflicting content says.
// The caller pushes afterwards with git.ts's syncAndPush.
export async function gitFix(dir: string, branch: string, m: FixModel): Promise<boolean> {
  try {
    const built = await buildModel(m);
    if (!built) return verify(dir, branch);

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
      `and commit what is there. Stop as soon as \`git status\` is clean. Do not run commands unrelated to this goal.`;
    const resourceLoader = new DefaultResourceLoader({ cwd: dir, agentDir, systemPromptOverride: () => system });
    await resourceLoader.reload();

    const { session } = await createAgentSession({
      cwd: dir, agentDir, model: built.model, authStorage: built.authStorage, modelRegistry: built.modelRegistry,
      sessionManager, resourceLoader, customTools: [runGit], tools: ['run_git'],
    });

    let steps = 0;
    const unsub = session.subscribe((e: any) => {
      if (e?.type === 'tool_execution_start') { steps++; if (steps >= MAX_STEPS) { try { session.abort(); } catch { /* */ } } }
    });
    try { await session.prompt(`Recover branch "${branch}": resolve any conflicts and commit, leaving a clean working tree. Do not push. Start by inspecting the current state.`); } catch { /* */ }
    try { unsub(); } catch { /* */ }
    try { session.dispose(); } catch { /* */ }
  } catch { /* fall through to verification */ }

  return verify(dir, branch);
}

// Trust nothing the model said — confirm the tree is clean and no conflict
// markers survived. The "nothing unpushed" check is gone with the push itself:
// the caller does that step and reports its own result.
async function verify(dir: string, _branch: string): Promise<boolean> {
  const status = await sh(dir, 'git status --porcelain');
  if (status.stdout.trim().length > 0) return false;
  const markers = await sh(dir, "git grep -lE '^(<<<<<<<|=======|>>>>>>>)' -- . 2>/dev/null | head -1 || true");
  return markers.stdout.trim().length === 0;
}
