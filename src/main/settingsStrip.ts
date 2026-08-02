// PURE credential-strip policy — no electron import, so `node --test` loads it
// straight off the source. Same split as `certPolicy.ts` beside `net.ts` and
// `workspaceRow.ts` beside the workspace IPC: the decision is testable, the
// wiring around it (`settingsStore.ts`) isn't.
//
// WHICH fields are credentials is declared once, in agent-core — the only code
// bundled into both this build and the companion's. See agent-core/credentials.ts.
import {
  SETTINGS_CREDENTIALS, AGENT_SECRET_CREDENTIALS,
  getPath, deletePath, setPathCopy, isSet,
} from '../../agent-core/credentials.ts';

/**
 * Strip every credential, replacing each with a "is one saved?" flag.
 *
 * Applied at the ONLY two places settings cross into the renderer — the
 * `settings:read` IPC and the `settings:changed` push. Main itself keeps the real
 * values: it needs them to run the agent, push to GitHub, and mint the voice
 * token. This is the main→renderer hop, not companion→main.
 *
 * The renderer never used the values for anything but painting them into a box, so
 * nothing loses a capability. What it loses is the ability to send one back — and
 * that was the actual hazard: it held every key and resent them on unrelated
 * edits, so any stale copy could overwrite the real thing.
 *
 * `has*` flags are what the boxes render dots from. A flag is not a secret.
 */
export function stripCredentials(settings: any): any {
  if (!settings || typeof settings !== 'object') return settings;
  let out: any = { ...settings };

  for (const c of SETTINGS_CREDENTIALS) {
    const value = getPath(out, c.path);
    if (c.wildcard) {
      // An open-ended map (provider slug -> key). The flag is a map too, so the
      // box can show dots for whichever provider is selected.
      const flags = Object.fromEntries(
        Object.entries((value ?? {}) as Record<string, unknown>)
          .filter(([, v]) => isSet(v))
          .map(([k]) => [k, true]),
      );
      out = replaceWithFlag(out, c.path, c.flag, flags);
    } else {
      out = replaceWithFlag(out, c.path, c.flag, isSet(value));
    }
  }

  if (Array.isArray(out.agentSecrets)) {
    out.agentSecrets = out.agentSecrets.map((entry: any) => {
      let next: any = { ...entry };
      for (const c of AGENT_SECRET_CREDENTIALS) {
        // accessToken/refreshToken get a flag too, though nothing renders them —
        // the point is that they leave, not that they're reported.
        next = replaceWithFlag(next, c.path, c.flag, isSet(getPath(next, c.path)));
      }
      return next;
    });
  }

  return out;
}

/**
 * Delete the credential at `path` and leave a `flag` beside where it was.
 *
 * **A flag never conjures the object that would have held it.** `setPathCopy`
 * builds missing parents, so writing `oauth.hasClientSecret` onto a static-token
 * agent secret invented an `oauth: {}` on it — and the renderer classifies by
 * `!!s.oauth`, so every pasted token rendered in the OAuth list, with a Reconnect
 * button that could only ever fail ("No OAuth connection named …") and no way to
 * reach the token dialog and actually paste the key. The empty slots
 * `ensureBuiltinSecretSlots` provisions hit it hardest: they arrive with nothing
 * BUT a name, so the phantom was all the renderer had to go on.
 *
 * A nested flag therefore applies only when its container is already there. At
 * the root (`token` -> `hasToken`) there is nothing to invent, so it always does.
 */
function replaceWithFlag(obj: any, path: string, flag: string, present: any): any {
  const out = deletePath(obj, path);
  const parts = path.split('.');
  if (parts.length > 1 && getPath(out, parts.slice(0, -1).join('.')) == null) return out;
  return setPathCopy(out, parentOf(path, flag), present);
}

/** `a.b.c` + flag `hasC` -> `a.b.hasC`. Keeps a flag beside the value it replaces. */
function parentOf(path: string, flag: string): string {
  const parts = path.split('.');
  parts[parts.length - 1] = flag;
  return parts.join('.');
}
