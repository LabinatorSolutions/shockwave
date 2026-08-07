// MEMORY.md — what the agent has learned about working in this workspace.
//
// ── EMPTY IS THE CONTENT, and it is load-bearing ────────────────────────────
//
// `DEFAULT_MEMORY` is the empty string on purpose, and this constant exists so
// that fact has somewhere to be stated. It used to be a bare `''` inline in the
// manifest, which reads as nobody having got around to writing a stub.
//
// The file is written by the agent through the `memory` tool, which appends
// `§`-delimited entries (`agent-core/memoryStore.ts`). Prose in a stub would
// PARSE AS THE AGENT'S FIRST MEMORY — a real entry, carried into every prompt
// from then on, until something noticed and removed it. Zero bytes reads as an
// empty store everywhere (`parseEntries('')` is `[]`).
//
// Seeding it at all is only so the file shows up in the workspace as somewhere
// the agent writes.
//
// ── The cost of being in the manifest ───────────────────────────────────────
//
// "Reset to defaults" blanks every file in the manifest, and for this one that
// is an ERASE rather than a restore — everything the agent has learned, gone.
// The renderer's confirmation names MEMORY.md and USER.md specifically for that
// reason (`src/renderer/settings/`), and the per-file restore menu gives them
// their own wording. If a third memory file ever joins, it belongs in that list
// too, or the dialog will promise a restore and perform a deletion.

export const MEMORY_FILENAME = 'MEMORY.md';

/** Empty on purpose — see the note above. Not a placeholder. */
export const DEFAULT_MEMORY = '';
