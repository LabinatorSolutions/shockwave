// GitHub sync — REST helpers and the git spawn wrapper.
//
// Auth model: the PAT lives on the companion. For shell git we put the decrypted
// PAT in the child process env (GITHUB_PAT) and answer git's credential prompt
// with a helper passed ON THE COMMAND LINE. The PAT exists in memory only for the
// lifetime of that one git child, and nothing PAT-bearing is ever written to
// .git/config — remote URLs stay plain https://github.com/owner/repo.git.
//
// ── Why the guards below exist ──────────────────────────────────────────────
//
// The git child's environment holds the PAT, and git will happily execute things
// the WORKSPACE names — a workspace the coding agent has full write access to,
// since editing it is the agent's job. Every guard closes one of those:
//
//   .git/hooks/pre-push   git runs it on every push, with our env
//   credential.helper     read from repo config, consulted before anything else
//   core.fsmonitor        a command git runs to check the worktree
//   ext:: remote URLs     not an address, a command
//   url.<base>.insteadOf  redirects the push to a host of the workspace's
//                         choosing — closed by scoping our helper to github.com,
//                         since no `-c` can clear an insteadOf
//
// Command-line `-c` beats repository config, which is the point.
//
// There is no longer an askpass helper script. It was a file at a fixed path,
// owned by the same user the agent runs as, that git executed with the PAT in its
// environment — so the agent could rewrite it once and collect the token on every
// sync afterwards. Nothing on disk means nothing to tamper with.
//
// For REST calls (whoami, repo create, scope probes) we use fetch with a
// Bearer header. Same lifetime guarantee — PAT in memory only for the request.

import { spawn } from 'node:child_process';
import { app } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureWorkspaceFiles } from '../../agent-core/defaults/files.js';
// Folder classification + GitHub URL parsing live in a plain `.js` sibling with
// no electron import, so `node --test` can exercise them directly. Re-exported
// here because this module is the public face of everything sync-related.
import { classifyFolder, cloneUrlFor, repoMismatch } from './workspaceFolder.js';
// Absolute path, resolved before the agent's shim dir joins PATH. See gitBinary.ts.
import { gitBinary } from './gitBinary.js';

export { classifyFolder };

const GITHUB_API = 'https://api.github.com';
const API_HEADERS = (pat) => ({
  Authorization: `Bearer ${pat}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'shockwave-app',
});

// ─── REST helpers ──────────────────────────────────────────────────────────

/**
 * GET /user. Used as a PAT sanity check. Doesn't probe scopes — a token that
 * can't write to a given repo surfaces on the first push, with GitHub's own
 * message, rather than being guessed at up front.
 */
export async function verifyPat(pat) {
  if (!pat) return { ok: false, error: 'No token provided' };
  try {
    const res = await fetch(`${GITHUB_API}/user`, { headers: API_HEADERS(pat) });
    if (res.status === 401) return { ok: false, error: 'Invalid or expired token' };
    if (!res.ok) return { ok: false, error: `GitHub returned ${res.status}` };
    const data = await res.json();
    return { ok: true, login: data.login, id: data.id, name: data.name ?? null };
  } catch (err: any) {
    return { ok: false, error: `Network error: ${err.message}` };
  }
}

/**
 * GET /user/repos. Paginated list of repos the PAT can see (owner +
 * collaborator + org member). Used by the renderer to populate the
 * "link to existing repo" picker so the user can pick instead of pasting
 * a URL. Returns a flat array sorted by `pushed` so most-recently-active
 * repos surface first. Caps at 5 pages (500 repos) — the listing is for
 * a UI picker, not a complete inventory.
 */
export async function listRepos(pat) {
  if (!pat) return { ok: false, error: 'No token provided' };
  const out: any[] = [];
  const perPage = 100;
  const maxPages = 5;
  try {
    for (let page = 1; page <= maxPages; page++) {
      const url = `${GITHUB_API}/user/repos?per_page=${perPage}&page=${page}&sort=pushed&affiliation=owner,collaborator,organization_member`;
      const res = await fetch(url, { headers: API_HEADERS(pat) });
      if (res.status === 401) return { ok: false, error: 'Invalid or expired token' };
      if (!res.ok) return { ok: false, error: `GitHub returned ${res.status}` };
      const batch = await res.json();
      if (!Array.isArray(batch) || batch.length === 0) break;
      for (const r of batch) {
        out.push({
          full_name: r.full_name,
          clone_url: r.clone_url,
          private: !!r.private,
          default_branch: r.default_branch,
          pushed_at: r.pushed_at,
        });
      }
      if (batch.length < perPage) break;
    }
    return { ok: true, repos: out };
  } catch (err: any) {
    return { ok: false, error: `Network error: ${err.message}` };
  }
}

/**
 * Create a new repo under the authenticated user. Repo creation needs a wider
 * scope than read/write on existing repos (fine-grained: Administration:Write;
 * classic: `repo`); we surface the 403 cleanly so the user knows their token
 * is insufficient for create flows specifically — not all sync flows.
 */
export async function createRepo(name, pat, { private: isPrivate = true, description = '' } = {}) {
  if (!pat) return { ok: false, error: 'No token provided' };
  if (!name) return { ok: false, error: 'Repo name required' };
  try {
    const res = await fetch(`${GITHUB_API}/user/repos`, {
      method: 'POST',
      headers: { ...API_HEADERS(pat), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        description,
        private: isPrivate,
        auto_init: false,
      }),
    });
    if (res.status === 201) {
      const data = await res.json();
      return {
        ok: true,
        full_name: data.full_name,
        clone_url: data.clone_url,
        default_branch: data.default_branch,
        html_url: data.html_url,
      };
    }
    if (res.status === 403) return { ok: false, error: 'Token lacks repo-create permission (need Administration:Write or classic `repo` scope)' };
    if (res.status === 422) {
      const data = await res.json().catch(() => null);
      return { ok: false, error: data?.errors?.[0]?.message || 'Repo name already taken or invalid' };
    }
    if (res.status === 401) return { ok: false, error: 'Invalid or expired token' };
    return { ok: false, error: `GitHub returned ${res.status}` };
  } catch (err: any) {
    return { ok: false, error: `Network error: ${err.message}` };
  }
}

// ─── System check ──────────────────────────────────────────────────────────

/**
 * Check whether `git` is on PATH and return its version string. `platform`
 * is included so the renderer can pick the right install instructions.
 */
export function checkGit() {
  return new Promise<any>((resolve) => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(gitBinary(), ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err: any) {
      resolve({ ok: false, error: err.message, platform: process.platform });
      return;
    }
    child.stdout.on('data', (b) => { stdout += b.toString(); });
    child.stderr.on('data', (b) => { stderr += b.toString(); });
    child.on('error', (err) => {
      resolve({ ok: false, error: err.message, platform: process.platform });
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ ok: true, version: stdout.trim(), platform: process.platform });
      } else {
        resolve({ ok: false, error: stderr.trim() || `git --version exited ${code}`, platform: process.platform });
      }
    });
  });
}

// ─── Credential + execution guards ─────────────────────────────────────────

/** Answers git's credential prompt from the env var set on that one spawn.
 *  Passed as an argument — never written to disk, never into .git/config.
 *  Git runs `!`-prefixed helpers through a shell; Git for Windows ships its own,
 *  which is what makes ONE helper work on all three platforms where the old
 *  .sh/.cmd pair needed two. */
const CREDENTIAL_HELPER = '!f() { echo username=x-access-token; echo password=$GITHUB_PAT; }; f';

/** Where git is told to look for hooks. NOT a directory — git looks up
 *  `<this>/<hookname>`, and a path under the null device is ENOTDIR, so no hook is
 *  ever found.
 *
 *  This used to be an empty directory under userData. Empty is a state something
 *  has to keep, and the coding agent runs as this user — so it could drop a
 *  `post-checkout` (clone) or `reference-transaction` (fetch) in there and have
 *  git run it with the PAT in the environment. `--no-verify` covers `pre-push`;
 *  it does not cover those. The null device cannot be filled. */
const NO_HOOKS = process.platform === 'win32' ? 'NUL' : '/dev/null';

/** Config overrides for every PAT-carrying git call. See the header for what each
 *  one closes. The empty `credential.helper` is first because the setting is a
 *  LIST — assigning empty resets it, so a helper planted in the workspace's
 *  .git/config can't run ahead of ours.
 *
 *  The helper is then registered for github.com ONLY. A `url.<base>.insteadOf`
 *  line in the workspace's .git/config rewrites the remote URL on the way out —
 *  and no `-c` can clear it, the subsection name being the agent's to choose — so
 *  a request can leave for any host. Git asks for THAT host's credentials, and a
 *  helper scoped to github.com is never consulted. A bare helper would answer:
 *  it echoes the PAT without reading the host git hands it on stdin. */
function guardArgs() {
  return [
    '-c', 'credential.helper=',
    '-c', `credential.https://github.com.helper=${CREDENTIAL_HELPER}`,
    '-c', `core.hooksPath=${NO_HOOKS}`,
    '-c', 'core.fsmonitor=',
    '-c', 'core.sshCommand=',
    '-c', 'protocol.ext.allow=never',
  ];
}

// ─── git spawn wrapper ─────────────────────────────────────────────────────

/**
 * Spawn `git` with optional PAT injected via GIT_ASKPASS env. Returns the
 * full {ok, code, stdout, stderr} so callers can pattern-match on git's
 * exit codes and messages.
 *
 * IMPORTANT: pass timeoutMs for any network-bound command (clone/fetch/pull/
 * push) — git can hang indefinitely on a broken connection.
 */
export async function gitSpawn(cwd, args, { pat = null, timeoutMs = 60000 } = {}) {
  const env = { ...process.env };
  let argv = args;
  if (pat) {
    env.GITHUB_PAT = pat;
    // Disable git's own terminal prompting fallback — we never want a TTY
    // prompt from a backgrounded child process.
    env.GIT_TERMINAL_PROMPT = '0';
    // Belt for the hooksPath guard on the subcommands that run hooks: --no-verify
    // goes immediately after the subcommand, so two independent things would have
    // to be wrong for a planted hook to see the PAT.
    const i = args.findIndex((a) => !String(a).startsWith('-'));
    const inner = (i >= 0 && ['push', 'commit', 'merge'].includes(String(args[i])))
      ? [...args.slice(0, i + 1), '--no-verify', ...args.slice(i + 1)]
      : args;
    argv = [...guardArgs(), ...inner];
  }
  return new Promise<any>((resolve) => {
    let stdout = '';
    let stderr = '';
    let timer: any = null;
    let child;
    try {
      child = spawn(gitBinary(), argv, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err: any) {
      resolve({ ok: false, code: -1, stdout: '', stderr: err.message });
      return;
    }
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* child may have already exited */ }
      }, timeoutMs);
    }
    child.stdout.on('data', (b) => { stdout += b.toString(); });
    child.stderr.on('data', (b) => { stderr += b.toString(); });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolve({ ok: false, code: -1, stdout, stderr: err.message });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout, stderr });
    });
  });
}

// ─── Setup flows ───────────────────────────────────────────────────────────
//
// Two flows, because there are exactly two ways to get a repo: make one or pick
// one. Both OWN the folder — they create it and clone into it — which is what
// retired the old third flow (`setupLink`, "adopt a folder that already has
// files"). That flow existed only because a workspace could be a folder chosen
// before any repo was involved; now the repo comes first and the folder is its
// checkout, so there is never an existing folder to adopt.
//
// Both return the columns the `workspace` row needs. The caller inserts the row;
// nothing here writes to the DB, so a half-finished clone leaves no workspace
// behind.

/**
 * Set local git user.name / user.email for the repo. Without these, commits
 * fail with "Please tell me who you are". We use the noreply privacy email
 * derived from the user's GitHub id so commits are attributable on GitHub
 * but don't leak any real email.
 */
async function setLocalIdentity(workspacePath, login, ghId) {
  await gitSpawn(workspacePath, ['config', '--local', 'user.name', login], { timeoutMs: 5000 });
  await gitSpawn(workspacePath, ['config', '--local', 'user.email', `${ghId}+${login}@users.noreply.github.com`], { timeoutMs: 5000 });
}

/**
 * Make `workspacePath` be a checkout of `owner/repo`, whatever state it starts
 * in. ONE function because there was only ever one operation here — three call
 * sites (add from the repo picker, add a folder that's already a clone, set an
 * existing workspace up on this machine) each re-implemented clone-or-verify
 * with slightly different error strings.
 *
 *   empty     → clone it in
 *   clone     → verify it's the SAME repo and leave it alone
 *   occupied  → refuse
 *
 * Verifying rather than re-cloning matters: the folder may hold uncommitted
 * work, and a matching clone needs nothing done to it.
 *
 * No write-probe first. `probeWrite` POSTs to `git/refs`, which a fine-grained
 * token can be denied even when it holds Contents: Read and write — so probing
 * rejected tokens that clone and push perfectly well. A genuine permission
 * failure surfaces on the first push, where `isTerminalGitError` already routes
 * it to `disabled` with GitHub's own message.
 */
export async function ensureCheckout({ workspacePath, owner, repo, pat }) {
  const info = await classifyFolder(workspacePath);

  if (info.state === 'occupied') {
    return { ok: false, error: info.error ?? "That folder can't be used." };
  }

  if (info.state === 'clone') {
    const mismatch = repoMismatch(info, { repoOwner: owner, repoName: repo });
    if (mismatch) return { ok: false, error: mismatch };
  } else {
    // init + fetch + checkout rather than `git clone <url> .`, because clone
    // demands a TRULY empty directory. `classifyFolder` calls a folder holding
    // only dotfiles "empty" — deliberately, since `.DS_Store` or a failed
    // clone's leftovers shouldn't send the user off to delete invisible files —
    // so clone refused folders we'd just told the user were fine.
    const init = await gitSpawn(workspacePath, ['init', '-q'], { timeoutMs: 5000 });
    if (!init.ok) return { ok: false, error: init.stderr.trim() || 'git init failed' };

    const add = await gitSpawn(workspacePath, ['remote', 'add', 'origin', cloneUrlFor(owner, repo)], { timeoutMs: 5000 });
    if (!add.ok && !/exists/i.test(add.stderr)) {
      return { ok: false, error: add.stderr.trim() || 'could not set origin' };
    }

    const fetched = await gitSpawn(workspacePath, ['fetch', '-q', 'origin'], { pat, timeoutMs: 120000 });
    if (!fetched.ok) {
      return { ok: false, error: fetched.stderr.trim() || `git fetch exited ${fetched.code}` };
    }

    // An empty repo has no branch to check out; the row keeps its default and
    // the engine's first tick pushes the initial commit.
    const head = await gitSpawn(workspacePath, ['rev-parse', '--verify', '-q', 'origin/HEAD'], { timeoutMs: 5000 });
    const remoteBranch = head.ok
      ? (await gitSpawn(workspacePath, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { timeoutMs: 5000 })).stdout.trim().replace(/^origin\//, '')
      : '';
    if (remoteBranch) {
      const co = await gitSpawn(workspacePath, ['checkout', '-q', '-B', remoteBranch, `origin/${remoteBranch}`], { timeoutMs: 60000 });
      if (!co.ok) return { ok: false, error: co.stderr.trim() || 'could not check out the repo' };
    }
  }

  // Commits need an identity, and a folder cloned outside the app may not have
  // one set locally. Best-effort.
  const who = await verifyPat(pat);
  if (who.ok) await setLocalIdentity(workspacePath, who.login, who.id);

  return {
    ok: true,
    path: workspacePath,
    repoOwner: owner,
    repoName: repo,
    // What git actually checked out, read once here — the row owns it after
    // this, and the engine never re-derives it.
    defaultBranch: info.state === 'clone' ? info.defaultBranch : await currentBranch(workspacePath),
  };
}

/**
 * The chosen folder must be empty before we create a repo into it.
 *
 * The user picks this folder directly (the OS picker can create one on the
 * spot), so it always exists by the time we get here — there is no parent-plus-
 * name to join, and nothing to mkdir. Anything with contents is refused rather
 * than merged into: scaffolding over a populated folder is how you lose files.
 */
async function requireEmptyFolder(workspacePath) {
  const info = await classifyFolder(workspacePath);
  if (info.state === 'empty') return { ok: true, path: workspacePath };
  return {
    ok: false,
    error: info.state === 'clone'
      ? `That folder is already a clone of ${info.repoOwner}/${info.repoName}.`
      : (info.error ?? "That folder can't be used."),
  };
}

/**
 * Read the checked-out branch. Called ONCE at setup to record `defaultBranch`
 * on the row — thereafter the row is what the engine reads. Deliberately not
 * taken from the caller or the repo listing: what git actually checked out is
 * the only answer that can't be stale.
 */
async function currentBranch(workspacePath: string) {
  const res = await gitSpawn(workspacePath, ['rev-parse', '--abbrev-ref', 'HEAD'], { timeoutMs: 5000 });
  return (res.ok && res.stdout.trim()) || 'main';
}

/**
 * Create a new GitHub repo and a local checkout of it. Seeds the workspace
 * default file set; the engine's first tick commits and pushes it.
 */
export async function createWorkspaceRepo({ workspacePath, repoName, pat, private: isPrivate = true }) {
  const folder = await requireEmptyFolder(workspacePath);
  if (!folder.ok) return folder;

  const created = await createRepo(repoName, pat, { private: isPrivate });
  if (!created.ok) return created;
  const [owner, repo] = created.full_name.split('/') as [string, string];

  const init = await gitSpawn(folder.path, ['init', '-b', 'main'], { timeoutMs: 5000 });
  if (!init.ok) return { ok: false, error: init.stderr.trim() || 'git init failed' };

  // The workspace default file set (SOUL.md, AGENTS.md, .ignore, .gitignore).
  // Best-effort; the first tick commits whatever landed.
  await ensureWorkspaceFiles(folder.path);

  const add = await gitSpawn(folder.path, ['remote', 'add', 'origin', cloneUrlFor(owner, repo)], { timeoutMs: 5000 });
  if (!add.ok) return { ok: false, error: add.stderr.trim() || 'could not set origin' };

  const who = await verifyPat(pat);
  if (who.ok) await setLocalIdentity(folder.path, who.login, who.id);

  return {
    ok: true,
    path: folder.path,
    repoOwner: owner,
    repoName: repo,
    defaultBranch: await currentBranch(folder.path),
  };
}


