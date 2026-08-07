// USER.md — what the agent has learned about the user: role, preferences, how
// they want to be worked with.
//
// The sibling of `memory.ts`, and empty for exactly the same reason: the agent
// writes it through the `memory` tool as `§`-delimited entries, so prose in a
// stub would parse as a real entry about the user and ride in every prompt
// until something removed it.
//
// Separate module rather than sharing memory.ts because the rule for this folder
// is one module per file, and the two are genuinely separate files with separate
// char budgets (`codingAgent.memoryCharLimit` / `userCharLimit`) rendered as two
// blocks in the prompt.
//
// Same caveat about "Reset to defaults" as MEMORY.md — for this file that action
// is an erase, not a restore. See the note in `memory.ts`.

export const USER_FILENAME = 'USER.md';

/** Empty on purpose — see `memory.ts`. Not a placeholder. */
export const DEFAULT_USER = '';
