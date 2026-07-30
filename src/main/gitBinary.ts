// Where `git` actually is, decided ONCE and never by name lookup again.
//
// Spawning `git` by bare name asks the OS to search PATH and run the first match.
// main prepends `<userData>/pi-agent/bin` to its own PATH at startup (cliTools.ts,
// so the agent's bash inherits the bundled CLI shims) — and that directory is
// writable by the agent, which runs as the same user. A file named `git` dropped
// there is what main would then execute, with GITHUB_PAT in its environment.
//
// So: resolve once, at startup, BEFORE that directory joins PATH, and spawn the
// absolute path from then on. `resolveGitBinary` must therefore be called from
// `whenReady` ahead of `prependPath`; `gitBinary()` returns the cached answer.
//
// Honest limit: this closes the directory the app itself creates and puts first.
// It cannot help if `git` was already hijacked somewhere else on PATH before the
// app started — on macOS /usr/local/bin and /opt/homebrew/bin are user-writable
// too. Nothing short of an absolute path pinned by the user closes that, and a
// planted `git` there compromises the user's own shell as well, which is a wider
// problem than this module. What it does buy: the one directory that exists
// because of us, is writable by the agent by design, and is searched FIRST.

import { spawnSync } from 'node:child_process';

// Falls back to the bare name, i.e. today's behaviour, if resolution fails —
// sync working matters more than this hardening, and a failure here means we
// couldn't find git at all.
let resolved = 'git';

/** Locate git and cache it. Call once, before anything mutates PATH. */
export function resolveGitBinary(): string {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  try {
    const r = spawnSync(finder, ['git'], { encoding: 'utf8' });
    const first = String(r.stdout || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    if (first) resolved = first;
  } catch { /* keep the bare name */ }
  return resolved;
}

/** The absolute path resolved at startup, or 'git' if that never happened. */
export function gitBinary(): string {
  return resolved;
}
