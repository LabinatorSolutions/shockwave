// PURE git-remote URL policy. No child_process, no fs — plain `.js` so
// `node --test` can exercise it directly, the same split as `keys.js` (pure) vs
// `store.ts` (stateful).
//
// This exists because of one specific bug: the PAT used to be embedded in the
// remote URL. `git clone <url>` and `git remote set-url` both persist whatever
// URL they're given into `<dir>/.git/config`, and `<dir>` is the coding agent's
// own working directory for the turn — so `git remote -v` handed the agent a
// token with write access to every repo it covered, and the checkout outlived the
// run. Auth goes through GIT_ASKPASS now (see git.ts); this builds the plain URL
// and `hasEmbeddedCredentials` is the guard that keeps it plain.

/** The remote URL for a repo. NEVER carries credentials. */
export function remoteUrl(owner, repo) {
  return `https://github.com/${owner}/${repo}.git`;
}

/**
 * True if a URL carries credentials in its authority (`user:pass@host`).
 *
 * Used by the regression test over this module, and safe for a caller to assert
 * on before handing a URL to git.
 */
export function hasEmbeddedCredentials(url) {
  if (typeof url !== 'string') return false;
  // Only the authority counts — a path or query may legitimately contain '@'.
  const afterScheme = url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const authority = afterScheme.split(/[/?#]/)[0];
  return authority.includes('@');
}
