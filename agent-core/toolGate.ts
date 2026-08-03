// Refusing a tool call that doesn't belong on this kind of run.
//
// Every run is offered the whole catalog (see `defaults/tools.ts`). This is the
// half that makes that safe: pi fires `tool_call` before a tool executes, and a
// handler returning `{ block: true, reason }` stops it and hands `reason` to the
// model as that tool's result. Nothing else is prepended — the sentence we write
// is the whole thing the agent reads.
//
// ── Why an extension and not a wrapper ──────────────────────────────────────
//
// pi documents two ways to gate a tool. One is to register a tool with a
// built-in's name, which replaces it; the shipped `tool-override.ts` example
// names access control as a use case, and our own `read` override in
// `skillTool.ts` works that way. The other is this event.
//
// The event wins here for one reason: it is origin-blind. `bash`, `edit` and
// `write` are pi's, `manage_skill` and `memory` are ours, and the handler sees
// them all the same way — by name. Doing it by override would mean seven
// wrappers, each reproducing its built-in's exact result shape (pi's docs are
// explicit that the `details` type must match, since the UI and session logic
// depend on it) for no behaviour of our own.
//
// Registered inline, as a factory rather than a file: pi loads path-based
// extensions through jiti, which would mean shipping a TypeScript file and
// compiling it at runtime inside a packaged app. A factory is just called
// (`loadExtensionFromFactory` in pi's loader), so there is nothing to resolve
// and the desktop build has nothing to unpack.
//
// Verified end to end against a real session before this shipped: with `bash`
// declared and denied, the command's side effect never happened — the file it
// was told to create did not appear — and the model reported the reason back in
// its own words.

import { deniedReason } from './defaults/tools.ts';

/**
 * The inline extension pi registers for one session, bound to that run's source.
 *
 * Bound at build time rather than read per call because a session belongs to one
 * source for its whole life — `source` is part of the session cache key, so a
 * chat continued from another side gets a new session and therefore a new gate.
 */
export function makeToolGate(source: string | undefined) {
  return {
    name: 'shockwave-tool-gate',
    factory: (pi: any) => {
      pi.on('tool_call', (event: any) => {
        const reason = deniedReason(event?.toolName, source);
        return reason ? { block: true, reason } : undefined;
      });
    },
  };
}
