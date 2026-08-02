// Server-side git for cron runs — plain `git` CLI, deterministic. Fresh shallow
// clone per run into a temp dir; after the turn, a separate check-in step commits
// and pushes what the agent changed; then the checkout is deleted.
//
// The PAT is NEVER in the remote URL — it goes to one child process at a time via
// GIT_ASKPASS, and the URL in .git/config stays plain. See the note above
// remoteUrl below, and gitRemote.ts.
//
// Conflict recovery via a bounded git-fixer AGENT is a separate step: this module
// is the deterministic happy path + one mechanical merge retry, and reports
// 'conflict' when that isn't enough for the caller to hand off. The fixer holds no
// credentials — it commits, and syncAndPush here does the pushing.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { WORK_BASE, POOL_READY_BASE, chatWorkDir } from './dataDirs.js';
import { remoteUrl } from './gitRemote.js';
import { logger, errStr } from './log.js';

const exec = promisify(execFile);
const log = logger('git');

export { WORK_BASE };

// Plain remote — NO credentials. `git clone <url>` and `git remote set-url` both
// persist whatever URL they're given into <dir>/.git/config, and <dir> is the
// agent's own working directory for the turn, so a PAT embedded here is a file
// the agent can simply read (`git remote -v`). That hands it write access to
// every repo the token covers, and the checkout outlives the run by
// `codingAgent.scratchTtlDays`. Auth goes through GIT_ASKPASS instead — same approach the
// desktop already uses (src/main/sync.ts) — so the PAT lives in one child
// process's environment and never touches disk.
//
// The builder is pure and unit-tested (gitRemote.ts), so the "no credentials in
// the URL" property is pinned by a test rather than by this comment.

// ── Carrying the PAT safely into a working copy the agent controls ──────────
//
// The PAT lives in ONE child process's environment, for one git call. That
// environment is readable by ANYTHING git decides to execute — and the working
// copy git runs in is the agent's own cwd for the turn, so the agent chooses
// what git finds there. Each guard below closes one of those:
//
//   .git/hooks/pre-push        git runs it on every push, with our env
//                              → core.hooksPath at /dev/null, plus --no-verify
//   credential.helper in config  consulted BEFORE any askpass
//                              → `-c credential.helper=` resets the list, then ours
//   url.<base>.insteadOf       rewrites the URL AFTER we pin remote.origin.url,
//                              so the pin alone can't keep us pointed at GitHub
//                              → the helper is registered for github.com ONLY, so
//                                a redirected request finds no helper at all
//   core.fsmonitor             names a command git runs to check the worktree
//   core.sshCommand            same, for transports we don't use but shouldn't leave open
//   remote.origin.url          can be `ext::sh -c …`, which is a command
//                              → we pass the URL on the command line, never a remote name
//
// There is no on-disk askpass helper any more. It was a script at a fixed path,
// owned by the same user the agent runs as, that git executed with the PAT in its
// environment — i.e. a file the agent could rewrite to capture the token, once,
// and have fire on every push afterwards. The credential helper below is passed
// as an argument instead, so there is nothing on disk to tamper with.
//
// `tests/gitGuards.test.js` plants a real hook and runs a real push.

/** Answers git's credential prompt from the env var set on that one call. Passed
 *  on the command line — never written to disk, never into .git/config. */
const CREDENTIAL_HELPER = '!f() { echo username=x-access-token; echo password=$GITHUB_PAT; }; f';

/** Where git is told to look for hooks. NOT a directory — every lookup git makes
 *  is `<this>/<hookname>`, and a path under a character device is ENOTDIR, so no
 *  hook is ever found.
 *
 *  This used to be an empty directory under WORK_BASE. An empty directory is only
 *  empty until something fills it, and that one sat beside the agent's own
 *  checkout owned by the same user — so the agent could drop a `post-checkout`
 *  (clone) or `reference-transaction` (fetch) in it and have git run it with the
 *  PAT in the environment. `--no-verify` covers `pre-push`; it does not cover
 *  those. /dev/null cannot be filled, so there is nothing to keep empty. */
const NO_HOOKS = '/dev/null';

/** What a network git call needs: the token, and the repo it is allowed to reach. */
export interface GitAuth { pat: string; owner: string; repo: string }

/**
 * Take a checkout the queue cloned ahead of time, if one is waiting for this
 * repo. Returns true when `dest` now holds it.
 *
 * The claim is a RENAME and nothing else — no network, no locks, no bookkeeping.
 * Rename is atomic within a filesystem, so two chats claiming at the same moment
 * cannot get the same folder: one wins, the other gets an error and takes the
 * next or falls through to a clone. That is the whole concurrency story.
 *
 * It lives here rather than with the queue's scheduler so that `prepareCheckout`
 * can call it unconditionally without importing `checkoutPool.ts`, which is
 * built on the clone and refresh below. Stocking, refreshing and cleaning are
 * that module's job; taking is this one's.
 */
export async function claimWarmCheckout(
  owner: string, repo: string, branch: string, dest: string,
): Promise<boolean> {
  const prefix = `${owner}__${repo}__${branch}__`;
  let names: string[];
  try { names = await fs.readdir(POOL_READY_BASE); } catch { return false; } // no queue yet
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    try {
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.rename(path.join(POOL_READY_BASE, name), dest);
      log.info({ dest }, 'claimed a warm checkout');
      return true;
    } catch {
      // Taken between the listing and the rename — try the next.
    }
  }
  return false;
}

/** Config overrides that must precede EVERY git call carrying the PAT.
 *
 *  Command-line `-c` beats repository config, which is the whole point — every
 *  value here is one the agent could otherwise set in `.git/config`. The empty
 *  `credential.helper` comes first because the setting is a LIST: assigning empty
 *  resets it, so a helper planted in the repo can't run ahead of ours.
 *
 *  `remote.origin.url` is pinned for the same reason. Left to the repo, it can be
 *  `ext::sh -c …`, which is a command, not an address. Pinning it here also means
 *  the refs stay `origin/<branch>` — passing a bare URL would land the result in
 *  FETCH_HEAD and quietly change what the merge below compares against.
 *
 *  The helper is registered under `credential.https://github.com.helper`, not the
 *  bare `credential.helper`, because pinning the URL is not the same as pinning
 *  where the request GOES. A `url.<base>.insteadOf` line in the repo — which no
 *  `-c` can clear, the subsection name being the agent's to choose — rewrites our
 *  pinned URL afterwards. Git then asks for THAT host's credentials, and a helper
 *  registered for github.com alone is simply not consulted. A bare helper would
 *  answer, because it echoes the PAT without ever reading the host git hands it. */
export function guards({ owner, repo }: GitAuth): string[] {
  return [
    '-c', 'credential.helper=',
    '-c', `credential.https://github.com.helper=${CREDENTIAL_HELPER}`,
    '-c', `remote.origin.url=${remoteUrl(owner, repo)}`,
    '-c', `core.hooksPath=${NO_HOOKS}`,
    '-c', 'core.fsmonitor=',
    '-c', 'core.sshCommand=',
  ];
}

/** Child env carrying the PAT for exactly one git invocation. */
export function gitEnv(pat: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GITHUB_PAT: pat,
    GIT_TERMINAL_PROMPT: '0', // never block on a TTY prompt from a background child
  };
}

async function git(cwd: string, args: string[], auth?: GitAuth): Promise<{ stdout: string; stderr: string }> {
  if (!auth) return exec('git', args, { cwd, maxBuffer: 32 * 1024 * 1024 });
  return exec('git', [...guards(auth), ...args], {
    cwd, maxBuffer: 32 * 1024 * 1024, env: gitEnv(auth.pat),
  });
}

/** Is there anything in this folder that only exists here?
 *
 *  Two questions, both local and instant: an edit nobody committed, and a commit
 *  nobody pushed. Either one means the folder is the ONLY copy of some work, and
 *  the answer is to leave it entirely alone.
 *
 *  This is answerable only because the fetch above no longer passes `--depth=1`
 *  (see prepareCheckout). With a grafted history `rev-list origin/<b>..HEAD`
 *  counts every local commit as unpushed forever, so the guard would never let a
 *  reset through and the folder would never catch up. */
async function nothingToLose(dir: string, branch: string): Promise<boolean> {
  try {
    const { stdout: dirty } = await git(dir, ['status', '--porcelain']);
    if (dirty.trim()) return false;
    const { stdout: ahead } = await git(dir, ['rev-list', '--count', `origin/${branch}..HEAD`]);
    return Number(ahead.trim()) === 0;
  } catch {
    return false; // couldn't tell → never license a wipe
  }
}

// Prepare a checkout for a run, keyed by chatId. If the dir already exists
// (a prior run of this chat), REUSE it. Otherwise a fresh shallow clone. The dir
// is kept after the run (the TTL sweeper reclaims old ones) so a re-run can
// reuse it.
//
// ── Catching up is `fetch` then a GUARDED `reset --hard` ────────────────────
//
// The fetch carries NO `--depth`. That flag belongs on the initial clone, where
// it is the whole saving; on a fetch into an existing checkout it saves nothing
// (a fetch only ever transfers objects we don't have — measured at 3 for a
// one-file change in a 200-file repo) and it re-grafts the remote branch as a
// disconnected root. That is not a subtle cost: with it, git refuses every
// subsequent merge as "unrelated histories", so the checkout silently never
// caught up and every push after an outside change was rejected. See
//
// With a connected history, "is there anything to lose?" has a real answer, so
// `reset --hard` is safe AND is the operation we want — one round trip, no merge
// to half-succeed, an exact match with the remote:
//
//   clean, already current   → reset is a no-op
//   clean, behind            → lands exactly on the remote
//   local unpushed commits   → guard refuses, folder untouched
//   dirty tree               → guard refuses, folder untouched
//
// The guard is what makes this different from the `reset --hard` + `clean -fd`
// that was removed here earlier. THAT one was unconditional, and it deleted work
// that had not reached GitHub yet — a turn's changes are only safe once pushed,
// and the push happens after the agent has already replied, so a second Telegram
// message landing in that window started a run whose first act wiped the
// previous turn. The objection recorded at the time was that ancestry is
// unresolvable on a shallow clone so the question can be answered wrong. That
// was true of the code, not of git: it was unresolvable *because* the fetch
// threw the link away.
//
// Nothing the guard declines to fold in is stranded: the turn's own `git add -A`
// sweeps it into the next commit, and checkIn reconciles with the remote at the
// end.
//
// The accepted cost is two agents briefly sharing one folder. That is messy — a
// confusing commit, or git refusing a second concurrent operation — and both are
// loud and recoverable, which a deleted file is not. gitFixer's prompt tells the
// fixer to expect it.
export async function prepareCheckout(
  chatId: string,
  owner: string, repo: string, branch: string, pat: string,
): Promise<string> {
  const dir = chatWorkDir(chatId);
  const auth: GitAuth = { pat, owner, repo };
  let hasGit = await fs.access(path.join(dir, '.git')).then(() => true).catch(() => false);

  // No folder yet — take a warm one if the queue has it. EVERY caller gets this:
  // there is one way to obtain a checkout, not a fast path for some callers and
  // a slow one for others, because two behaviours behind one call is a thing
  // somebody has to remember.
  //
  // Purely an optimisation, and it changes nothing downstream: a claimed folder
  // is a checkout of this repo, so it drops into the reuse path below and gets
  // the same fetch and the same guard as any other. Empty queue, disabled queue,
  // wrong repo, lost rename race — `hasGit` stays false and the clone runs,
  // exactly as before the queue existed.
  if (!hasGit) {
    hasGit = await claimWarmCheckout(owner, repo, branch, dir).catch(() => false);
  }

  if (hasGit) {
    // Reuse — normalize the remote (an older checkout may still carry a
    // credential-bearing URL in .git/config).
    await git(dir, ['remote', 'set-url', 'origin', remoteUrl(owner, repo)]).catch(() => {});
    // A hook planted on a previous run survives reset --hard and clean -fd —
    // neither touches .git — so it would fire on the next push. The hooksPath
    // guard already neuters it; removing it means it isn't sitting there waiting
    // for a call that forgets the guard.
    await fs.rm(path.join(dir, '.git', 'hooks'), { recursive: true, force: true }).catch(() => {});
    // NO --depth here. See the note above — it is what broke every reused
    // checkout, and it saves nothing on a fetch.
    await git(dir, ['fetch', 'origin', branch], auth);
    if (await nothingToLose(dir, branch)) {
      await git(dir, ['reset', '--hard', `origin/${branch}`]);
    } else {
      log.info({ dir, branch }, 'checkout holds unpushed work — leaving it as-is');
    }
    return dir;
  }

  await cloneFresh(dir, owner, repo, branch, pat);
  return dir;
}

/** A brand-new shallow checkout at `dir`, ready to be worked in.
 *
 *  Shared with the warm-checkout queue (`checkoutPool.ts`), which needs a folder
 *  indistinguishable from one prepareCheckout made — including the commit
 *  identity, which only ever got set on the clone path. A queued folder missing
 *  it would fail at `git commit` after the agent had already replied. */
export async function cloneFresh(
  dir: string, owner: string, repo: string, branch: string, pat: string,
): Promise<void> {
  const auth: GitAuth = { pat, owner, repo };
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(path.dirname(dir), { recursive: true });
  // --depth=1 belongs HERE and only here: on the initial clone it is the whole
  // saving. On a later fetch it severs history — see prepareCheckout.
  await exec('git', [...guards(auth), 'clone', '--depth=1', '--branch', branch, remoteUrl(owner, repo), dir], {
    maxBuffer: 32 * 1024 * 1024,
    env: gitEnv(pat),
  });
  await git(dir, ['config', 'user.name', 'Shockwave Cron']);
  await git(dir, ['config', 'user.email', 'cron@shockwave.local']);
}

/** Bring a checkout that is KNOWN to hold nothing of its own exactly up to the
 *  remote. Unguarded on purpose — the queue's folders have never been worked in,
 *  so there is nothing to weigh. Anything a user or agent has touched goes
 *  through prepareCheckout instead, which asks first. */
export async function refreshPristine(
  dir: string, owner: string, repo: string, branch: string, pat: string,
): Promise<void> {
  const auth: GitAuth = { pat, owner, repo };
  await git(dir, ['fetch', 'origin', branch], auth);
  await git(dir, ['reset', '--hard', `origin/${branch}`]);
}

// 'conflict' means the tree holds unresolved markers — something the git-fixer
// can actually work on. 'diverged' means the merge could not START (no common
// history, or it would clobber local changes): nothing is conflicted, so the
// fixer has nothing to resolve, its "clean tree, no markers" check passes on
// arrival, and it reports success while the same push fails again. One status
// for both is how that hid — see checkInWithFixer, which hands off only on
// 'conflict'.
export type CheckInResult = 'clean' | 'pushed' | 'conflict' | 'diverged' | 'error';

/** Did the work reach GitHub? The ONE place that decides, so adding a failure
 *  status can't miss a caller. Every call site used to spell out
 *  `=== 'conflict' || === 'error'`, which is a list that has to be edited in
 *  three files every time the set grows — and a missed one reads a failure as a
 *  success and says nothing. */
export function landed(r: CheckInResult): boolean {
  return r === 'clean' || r === 'pushed';
}

// Deterministic check-in. add -A; nothing staged → clean. Else commit, fetch,
// merge if the remote moved, push. One mechanical merge retry on non-fast-forward.
// Returns 'conflict' when a merge conflict remains (caller hands to the git-fixer).
export async function checkIn(dir: string, branch: string, message: string, auth: GitAuth): Promise<CheckInResult> {
  try {
    await git(dir, ['add', '-A']);
    const { stdout: status } = await git(dir, ['status', '--porcelain']);
    if (!status.trim()) return 'clean';
    // No token on the commit, so a pre-commit hook gets nothing worth having —
    // but --no-verify anyway, because a hook that can rewrite the tree between
    // `add -A` and the commit changes what we are about to push.
    await git(dir, ['commit', '--no-verify', '-m', message]);
    return await syncAndPush(dir, branch, auth);
  } catch (e: any) {
    // The status is all the caller gets — the WHY lives here or nowhere.
    log.error({ dir, branch, err: errStr(e) }, 'check-in failed');
    return 'error';
  }
}

// How many times syncAndPush will re-fetch and re-push when the remote moves
// underneath it. Each retry closes the same gap: we fetched, someone else pushed,
// our push was rejected as non-fast-forward, so we fetch again — now holding
// their commit — and push. Nothing else is retried; every other error throws.
const PUSH_ATTEMPTS = 3;

// Fetch, merge if the remote moved, push. Mechanical retries on non-fast-forward.
// Split out of checkIn because the git-fixer path needs it on its own: the fixer
// resolves and commits with NO credentials, and the push is done here afterwards,
// deterministically.
export async function syncAndPush(dir: string, branch: string, auth: GitAuth): Promise<CheckInResult> {
  try {
    for (let attempt = 0; attempt < PUSH_ATTEMPTS; attempt++) {
      try {
        await git(dir, ['fetch', 'origin', branch], auth);
        const { stdout: behind } = await git(dir, ['rev-list', '--count', `HEAD..origin/${branch}`]);
        if (Number(behind.trim()) > 0) {
          try {
            await git(dir, ['merge', '--no-edit', '--no-verify', `origin/${branch}`]);
          } catch (e: any) {
            // Unresolved conflict markers left in the tree → hand off.
            const { stdout: unmerged } = await git(dir, ['diff', '--name-only', '--diff-filter=U']);
            if (unmerged.trim()) {
              log.warn({ dir, branch, files: unmerged.trim().split('\n') }, 'merge conflict — handing off');
              return 'conflict';
            }
            // The merge never started. We are behind and cannot fold the remote
            // in, so the push below is guaranteed to be rejected — it used to be
            // attempted anyway ("pushing anyway"), burning the retry loop and
            // then reporting 'conflict', which sent a git-fixer run at a tree
            // with nothing wrong in it. Report it as itself instead.
            log.error({ dir, branch, err: errStr(e) }, 'merge could not start — local and remote have diverged');
            return 'diverged';
          }
        }
        // --no-verify belts the hooksPath guard: two independent things would both
        // have to be wrong for a planted pre-push hook to see the token.
        await git(dir, ['push', '--no-verify', 'origin', `HEAD:${branch}`], auth);
        return 'pushed';
      } catch (e: any) {
        // Non-fast-forward (someone pushed between fetch and push) → retry once.
        if (/non-fast-forward|fetch first|rejected/i.test(String(e?.stderr || e))) {
          log.warn({ dir, branch, attempt: attempt + 1 }, 'push rejected (remote moved) — retrying');
          continue;
        }
        throw e;
      }
    }
    log.warn({ dir, branch, attempts: PUSH_ATTEMPTS }, 'push attempts exhausted — reporting conflict');
    return 'conflict';
  } catch (e: any) {
    log.error({ dir, branch, err: errStr(e) }, 'sync-and-push failed');
    return 'error';
  }
}

export async function cleanup(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => { /* best-effort */ });
}
