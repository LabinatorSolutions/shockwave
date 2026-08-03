// THE list of which settings fields are credentials. One declaration, three
// consumers, and it lives here because `agent-core` is the only code bundled into
// BOTH builds (the desktop's electron-vite build and the companion's esbuild —
// see api/Dockerfile).
//
// Dependency-free so `node --test` loads it directly and both TypeScript builds
// import it without ceremony, same as `keys.ts` and `linkParser.ts`. (It was plain
// `.js` for years for that first reason — the test suite runs off the source and
// Node resolves specifiers literally. Tests naming the `.ts` file is what freed it.)
//
// It used to be written out three times: the companion deciding what to encrypt,
// main deciding what to strip before the renderer, and the renderer deciding what
// not to send back. Three copies of one fact, and a mismatch is not a cosmetic
// problem — miss a field in the strip and it leaks to the screen; miss it in the
// send guard and an unrelated save deletes it. Adding a credential should be one
// edit, here.

/**
 * Credentials that live at a fixed path in the settings tree.
 *
 * `path`   — dotted location in the settings object.
 * `flag`   — the boolean the renderer gets instead of the value.
 * `wildcard` — the path ends in a map keyed by something open-ended (provider
 *              slug), so the leaf name isn't known up front.
 */
// `voiceKeys` is a map keyed by VENDOR, not by job. Speech runs in two directions
// now (listening and speaking) across three vendors, and picking the same vendor
// for both is one account with one key — a field per job would ask for it twice
// and store it twice. It replaced `transcription.apiKey` (AssemblyAI's, under a
// generic name) and `transcription.deepgramApiKey`; those two rows are renamed in
// place on the companion by the migration at the end of `api/init.sql`.
export const SETTINGS_CREDENTIALS = [
  { path: 'codingAgent.providerKeys', flag: 'hasProviderKey', wildcard: true },
  { path: 'voiceKeys', flag: 'hasVoiceKey', wildcard: true },
  { path: 'sync.pat', flag: 'hasPat' },
];

/**
 * Credential fields on an agent-secret entry, relative to the entry.
 *
 * `ownedByOAuthFlow` marks the two the interactive OAuth flow writes and nothing
 * else may author — a bulk save echoing pre-refresh state would otherwise clobber
 * a token that had just been rotated, and Google rotates the refresh token on
 * every refresh, so a lost write kills the connection permanently.
 */
export const AGENT_SECRET_CREDENTIALS = [
  { path: 'token', flag: 'hasToken' },
  { path: 'oauth.clientSecret', flag: 'hasClientSecret' },
  { path: 'oauth.accessToken', flag: 'hasAccessToken', ownedByOAuthFlow: true },
  { path: 'oauth.refreshToken', flag: 'hasRefreshToken', ownedByOAuthFlow: true },
];

/** Dotted paths of every fixed-path settings credential, wildcards expanded to a
 *  `<slug>` segment. Used by the companion to route values into `secret_value`. */
export function settingsCredentialPatterns() {
  return SETTINGS_CREDENTIALS.map((c) => (c.wildcard
    ? new RegExp(`^${c.path.replace(/\./g, '\\.')}\\.[^.]+$`)
    : new RegExp(`^${c.path.replace(/\./g, '\\.')}$`)));
}

/** Agent-secret credential field names, in the form `secret_value.field` uses. */
export function agentSecretFields() {
  return AGENT_SECRET_CREDENTIALS.map((c) => c.path);
}

/** The subset only the OAuth flow may write. */
export function oauthOwnedFields() {
  return AGENT_SECRET_CREDENTIALS.filter((c) => c.ownedByOAuthFlow).map((c) => c.path);
}

// ── path helpers, shared by the strip and the send-guard ─────────────────────

function segments(path) { return path.split('.'); }

/** Read a dotted path, or undefined. */
export function getPath(obj, path) {
  let node = obj;
  for (const s of segments(path)) {
    if (node == null || typeof node !== 'object') return undefined;
    node = node[s];
  }
  return node;
}

/** Delete a dotted path, copying each object on the way down so the input isn't
 *  mutated. Returns the (possibly new) root. */
export function deletePath(obj, path) {
  if (obj == null || typeof obj !== 'object') return obj;
  const [head, ...rest] = segments(path);
  const out = { ...obj };
  if (!rest.length) { delete out[head]; return out; }
  if (out[head] != null && typeof out[head] === 'object') {
    out[head] = deletePath(out[head], rest.join('.'));
  }
  return out;
}

/** Set a dotted path, copying on the way down. Returns the (possibly new) root. */
export function setPathCopy(obj, path, value) {
  const [head, ...rest] = segments(path);
  const out = (obj != null && typeof obj === 'object') ? { ...obj } : {};
  if (!rest.length) { out[head] = value; return out; }
  out[head] = setPathCopy(out[head], rest.join('.'), value);
  return out;
}

/** Is this value "present" — i.e. a credential worth reporting / worth sending? */
export function isSet(v) {
  return typeof v === 'string' ? v.length > 0 : v != null;
}

/**
 * Is `path` a credential the user is allowed to delete?
 *
 * Deleting needs its own route. An empty value means DELETE on the companion, but
 * the renderer holds no credential values any more, so every credential it sends
 * reads as empty — `dropEmptyCredentials` therefore strips them all, and an empty
 * box can no longer mean "remove this". Correct, and it left no way to remove one
 * at all: clearing the field did nothing and the old value stayed on the server,
 * so a leaked key could not be revoked from the app.
 *
 * The allowlist is this same declaration, so a deletable path can't drift from a
 * credential path, and `settings:deleteCredential` can't be pointed at an
 * arbitrary settings key.
 *
 * Accepts the wildcard leaf too (`codingAgent.providerKeys.anthropic`).
 */
export function isDeletableCredential(path) {
  if (typeof path !== 'string' || !path) return false;
  return SETTINGS_CREDENTIALS.some((c) => (c.wildcard
    ? path.startsWith(`${c.path}.`) && path.slice(c.path.length + 1).split('.').length === 1
    : path === c.path));
}
