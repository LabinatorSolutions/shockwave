// AGENTS.md — the user's own per-project instructions to the agent.
//
// ── We seed it and then never touch it ──────────────────────────────────────
//
// Nothing in this codebase reads this file. **pi** discovers it
// (`loadContextFileFromDir` in its `core/resource-loader.js`) and appends the
// contents to the system prompt inside a `<project_context>` block. Our only
// involvement is putting a starter file there.
//
// It was `AGENTS_STUB` and it lived in `soul.ts`, which was wrong twice over:
// the name broke the `DEFAULT_<X>` rule every other default follows, and the
// placement filed it with SOUL as though the two were related. They are not —
// see the table below.
//
// ── How it differs from SOUL.md, which is the useful thing to know ──────────
//
//                    SOUL.md                      AGENTS.md
//   read by          us (`readSoul`)              pi
//   lands            FIRST, above everything      near the END, <project_context>
//   read when        once, at chat creation       every session boot
//   found where      workspace root only          every ancestor of cwd
//   is for           who the agent is             how this project works
//
// The lifetime row is the one that matters in practice: **editing SOUL.md does
// not reach a chat that already exists** — the prompt is frozen when the chat is
// created — while editing AGENTS.md lands on the next message of every chat.
// So this is the better home for anything a workspace expects to tune, and it is
// where per-workspace house style belongs (the daily-note conventions that came
// out of the helper prompt, for instance).
//
// Seeded EMPTY, like MEMORY.md and USER.md. It carried four lines of prose
// ("add your own instructions here") from when nothing used the file; every
// workspace then shipped that boilerplate into its own prompt forever, saying
// nothing. The file's job is to exist and be somewhere to write.
//
// ONE CONSEQUENCE, worth knowing before anyone calls it a bug: pi does not check
// whether a context file has content. An empty AGENTS.md still produces the
// wrapper —
//
//     <project_context>
//     Project-specific instructions and guidelines:
//     <project_instructions path="…/AGENTS.md">
//     </project_instructions>
//     </project_context>
//
// — about 150 chars of empty scaffolding on every chat in a workspace that has
// not written anything into it. Cheaper than the prose it replaced, and not
// something we can suppress from here: the fix would be to stop seeding the file
// at all, which costs the user the discoverable place to put instructions.

export const AGENTS_FILENAME = 'AGENTS.md';

export const DEFAULT_AGENTS = ``;
