// WHICH fields are credentials is declared once, in agent-core — see
// agent-core/credentials.ts. Duplicating it here is how a mismatch leaks a key to
// the screen or deletes one on save.
import {
  SETTINGS_CREDENTIALS, AGENT_SECRET_CREDENTIALS,
  getPath, deletePath, setPathCopy, isSet,
} from '../../agent-core/credentials.ts';

// PURE patch-diffing for settings saves. No React, no window, so
// `node --test` can exercise it directly — same split as linkResolver.ts.
//
// Settings are stored one row per leaf key. Per-field setters necessarily build
// whole sub-objects (`{...current.sync, pullIntervalSeconds}`), which means they
// read every sibling — including credentials — out of the local cache and hand
// them back to the store. Sending that verbatim republishes the cached copy of
// `sync.pat` on every slider nudge: needless re-encryption at best, and a
// stale-cache overwrite at worst.
//
// Diffing against the cache means an untouched field compares equal and is never
// sent. The cache stops being a SOURCE of writes — only a field the user
// actually edited leaves the renderer.

export function isPlainObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Collections reconcile as a whole in the store (membership is the point, and
// they route to entity tables), so callers pass them through undiffed.
export const COLLECTION_KEYS = ['workspaces', 'agentSecrets'];

// Top-level keys main owns. The renderer holds hydrated copies (they arrive on
// read) but must never author them.
export const MAIN_OWNED_KEYS = ['windowBounds'];

// Open-ended MAPS whose keys can be added AND removed. They must travel whole so
// the store can reconcile removals: a per-leaf diff only walks what's present,
// so a deleted entry is simply never mentioned and its row survives — which for
// providerKeys meant a deleted API key stayed encrypted in the DB and
// reappeared on the next read.
//
// Everything else in settings has fixed keys (appearance, sync, …) or
// reconciles as a collection (workspaces, agentSecrets).
export const MAP_KEYS = ['codingAgent.providerKeys', 'voiceKeys'];

/**
 * Remove empty credentials from a patch before it is sent.
 *
 * The renderer no longer RECEIVES credential values (main strips them), so every
 * credential it holds reads as ''. An empty value means DELETE on the server, so
 * without this guard the first unrelated save would wipe the real one — a sync
 * interval change would take the GitHub token with it.
 *
 * Deleting a credential is therefore not something the renderer can do by
 * accident, and not something it can do by omission either. It needs an explicit
 * action, which is the right shape for destroying a credential.
 */
export function dropEmptyCredentials(patch) {
  if (!patch || typeof patch !== 'object') return patch;
  let out = { ...patch };

  for (const c of SETTINGS_CREDENTIALS) {
    // buildPatch emits a credential either nested (`{sync:{pat}}`) or as a dotted
    // key (`{'codingAgent.providerKeys':…}` — MAP_KEYS travel dotted). Treat the
    // dotted key as just another path so there's one code path, not two.
    const dotted = Object.prototype.hasOwnProperty.call(out, c.path);
    const read = () => (dotted ? out[c.path] : getPath(out, c.path));
    const drop = () => {
      if (!dotted) return deletePath(out, c.path);
      const o = { ...out }; delete o[c.path]; return o;
    };
    const keep = (v) => (dotted ? { ...out, [c.path]: v } : setPathCopy(out, c.path, v));

    const value = read();
    if (value === undefined) continue;

    if (c.wildcard) {
      // Send only slugs that carry a key; drop the map entirely if none do.
      const kept = Object.fromEntries(Object.entries(value ?? {}).filter(([, v]) => isSet(v)));
      out = Object.keys(kept).length ? keep(kept) : drop();
    } else if (!isSet(value)) {
      out = drop();
    }
  }

  if (Array.isArray(out.agentSecrets)) {
    out.agentSecrets = out.agentSecrets.map((entry) => {
      let next = { ...entry };
      for (const c of AGENT_SECRET_CREDENTIALS) {
        // Absent means "leave what's stored", so only something actually typed is
        // sent and an unrelated edit can't blank a credential. The OAuth-owned
        // pair is never sent from here at all — the OAuth flow owns those.
        if (c.ownedByOAuthFlow || !isSet(getPath(next, c.path))) next = deletePath(next, c.path);
      }
      return next;
    });
  }

  return out;
}

/**
 * Walks `next` against `prev`, writing dotted leaf keys that differ into `out`.
 * Arrays and scalars are leaves (compared structurally); plain objects recurse.
 */
export function changedLeaves(prefix, next, prev, out) {
  // Maps travel whole (see MAP_KEYS) — compared structurally so an unchanged one
  // still costs nothing, but sent intact so removals are visible to the store.
  if (MAP_KEYS.includes(prefix)) {
    if (JSON.stringify(next) !== JSON.stringify(prev)) out[prefix] = next;
    return;
  }
  if (!isPlainObj(next)) {
    if (JSON.stringify(next) !== JSON.stringify(prev)) out[prefix] = next;
    return;
  }
  for (const [k, v] of Object.entries(next)) {
    changedLeaves(prefix ? `${prefix}.${k}` : k, v, isPlainObj(prev) ? prev[k] : undefined, out);
  }
}

/**
 * Full patch → the minimal set of dotted leaf keys to write.
 * Drops main-owned keys, passes collections through whole, diffs the rest.
 */
export function buildPatch(next, prev) {
  const out = {};
  for (const [k, v] of Object.entries(next ?? {})) {
    if (MAIN_OWNED_KEYS.includes(k)) continue;
    if (COLLECTION_KEYS.includes(k)) { out[k] = v; continue; }
    changedLeaves(k, v, (prev ?? {})[k], out);
  }
  return out;
}
