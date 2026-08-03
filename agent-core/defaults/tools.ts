// Single source of truth for the agent's tool set.
//
// `TOOL_CATALOG` is BOTH the allowlist passed to pi (`tools:` in
// createAgentSession) and the list rendered into the prompt's "Available tools"
// section. One list, so the prompt can't claim a tool pi doesn't have — or miss
// one it does.
//
// That drift was real: the catalog listed 7 while pi ran 8. pi discovers
// extensions by SCANNING <userDataDir>/pi-agent/extensions/ (unconditional —
// see discoverAndLoadExtensions in pi's loader), so a `resolve_link` extension
// file written by a build we'd since deleted the source for kept registering
// itself. The allowlist is what bounds the set now: a stray extension can still
// load, but its tool is filtered out unless it's named here.
//
// `origin` says where each tool comes from:
//   'builtin' → pi's own (createAllToolDefinitions instantiates all 7; the
//               allowlist selects. pi's own default is only read/bash/edit/write)
//   'custom'  → ours, passed in-process as `customTools` (the token tools from
//               agent-core, plus whatever the host adds via `extraTools`)
//
// `only` scopes a tool to where a turn is RUNNING FROM (RunOpts.source):
// 'desktop' (a chat in the app), 'cron' (a scheduled run), 'telegram' (a DM).
// Omit it and the tool is available everywhere — that's the default, and most
// tools want it. `only` exists because a tool can be meaningless off its home:
// `open_file` opens a tab in the app UI, and there is no UI on a cron run.
//
// The catalog is filtered by source at session boot (`toolsForSource`), and the
// SAME filtered list feeds the prompt text and pi's allowlist, so the two can't
// disagree. A host's `extraTools` must be named here too — pi filters custom
// tools against the allowlist exactly like builtins (see _refreshToolRegistry in
// pi's agent-session.js), so a host tool missing from the catalog is silently
// dropped. That is what happened to `send_message`: the companion supplied it,
// the catalog didn't name it, and the agent reported it had no way to message
// the user. agent.ts logs a warning if a host ever supplies an unnamed tool.

/** Where a turn is running from — `RunOpts.source`. */
export type ToolScope = 'desktop' | 'cron' | 'telegram' | 'review' | 'memory';

export const TOOL_SCOPES: ToolScope[] = ['desktop', 'cron', 'telegram', 'review', 'memory'];

// A review run gets an EXPLICIT list, not the catalog minus a few
// exclusions. That direction matters: with an exclusion list, every tool added
// later lands in the one run nobody is watching unless someone remembers to
// exclude it. `daily_note` proved the point — it was added while this was being
// designed and would have arrived silently.
//
// It investigates and it curates: read/grep/find/ls to look around, and
// `manage_skill` to write. Deliberately absent are `write`, `edit` and `bash` —
// with any of those the containment and read-before-write guards in
// `manageSkill.ts` are decorative, since the agent could edit a SKILL.md
// directly. hermes restricts its review fork the same way and for the same
// reason. Also absent: `send_message` (maintenance is not news), the secret
// tools (no credentialed work), `transcribe`, `open_file`, `daily_note`,
// `search_chats`.
const REVIEW_TOOLS = ['read', 'grep', 'find', 'ls', 'manage_skill'];

// A memory run gets ONE tool, for the same reason the review list is explicit
// and for one more: it has nothing to look up. Its whole input is the
// conversation it was handed and the current memory, and the current memory is
// already in its prompt — rendered from disk at the boot of that very run. There
// is no file it could usefully read, so giving it `read`/`grep` would widen the
// one run nobody is watching in exchange for nothing.
//
// hermes restricts its memory fork the same way (`review_toolsets` is the memory
// toolset alone when only the memory trigger fired).
const MEMORY_TOOLS = ['memory'];

export interface ToolDescriptor {
  name: string;
  desc: string;
  origin: 'builtin' | 'custom';
  /** Sources this tool is offered to. Absent = all of them. */
  only?: ToolScope[];
}

export const TOOL_CATALOG: ToolDescriptor[] = [
  { name: 'read', origin: 'builtin', desc: 'Read file contents.' },
  { name: 'bash', origin: 'builtin', desc: 'Execute bash commands. Use for running programs and git — prefer grep/find/ls for searching.' },
  { name: 'edit', origin: 'builtin', desc: 'Make precise file edits with exact text replacement, including multiple disjoint edits in one call.' },
  { name: 'write', origin: 'builtin', desc: 'Create or overwrite files.' },
  { name: 'grep', origin: 'builtin', desc: 'Search file contents for a pattern (regex or literal), with optional glob filter and context lines. Respects .gitignore. Use this instead of shelling out to grep.' },
  { name: 'find', origin: 'builtin', desc: 'Find files by glob pattern (e.g. `**/*.md`). Respects .gitignore.' },
  { name: 'ls', origin: 'builtin', desc: 'List directory contents.' },
  { name: 'list_agent_secrets', origin: 'custom', desc: 'List available API tokens by name and purpose.' },
  { name: 'get_agent_secret', origin: 'custom', desc: 'Read one API token by name.' },
  // Opens a tab in the app UI — only a desktop chat has one.
  { name: 'open_file', origin: 'custom', only: ['desktop'], desc: 'Open a file in the app UI (a new tab) so the user can see it. Use when the user asks you to open, show, or display a file. The path is workspace-relative; only files the app can display (.md, images, video, .excalidraw) can be opened.' },
  // Every source: a desktop chat can DM the user too (it routes through the
  // companion, which holds the bot token).
  { name: 'send_message', origin: 'custom', desc: "Send the user a message on Telegram. Use to reach them proactively — a finished job, or something that needs their attention. `output` picks how that one message is delivered — `text`, `voice` (audio only), or `both`." },
  // Speech to text. Every source: a recording in the workspace is as likely to
  // need reading on the desktop as one sent over Telegram.
  { name: 'transcribe', origin: 'custom', desc: 'Transcribe an audio or video file into text with timestamps and speaker labels. Writes a transcript file and returns its path. Use whenever you need to know what was said in a recording.' },
  // Every source: "add this to my journal" is as likely over Telegram as in the
  // app, and a scheduled run that writes a daily summary needs it too.
  { name: 'daily_note', origin: 'custom', desc: "Find the user's daily note (journal) for a date — today by default — and create it from their template if asked. Returns the workspace-relative path. Use this instead of guessing a filename: the name and folder come from per-workspace settings." },
  // The agent's memory of earlier conversations in this workspace.
  { name: 'search_chats', origin: 'custom', desc: 'Search earlier chats in this workspace — what the user told you before, what was decided, what you already tried. Pass `query` to search, `chatId` + `around` to read more of one, or nothing to list recent chats. Results carry dates; prefer recent ones when they disagree.' },
  // Every source. The memory pass exists because an agent forgets to save
  // unprompted, not because saving is a background-only act — "remember that I
  // hate long replies" has to work the moment it is said, in the chat where it
  // was said. hermes puts its memory tool in the ordinary toolset for exactly
  // this reason and treats the background pass as the safety net.
  { name: 'memory', origin: 'custom', desc: "Save a durable fact about the user (`user`) or about working in this workspace (`memory`). Use it the moment you learn a preference, a correction, or a stable fact — don't wait to be asked. Actions: add, replace, remove, or an `operations` batch applied atomically." },
  // Every source, like hermes: one validated way to author a skill, whoever is
  // asking. The guards inside it differ by caller, not the tool.
  { name: 'manage_skill', origin: 'custom', desc: 'Create or update one of your own skills — validated before it is written, so use it rather than editing a SKILL.md by hand. Actions: create, patch (preferred for fixes), edit, write_file, remove_file. Skills the user provided and the ones built into the app are read-only to you.' },
];

/** The catalog as offered to a turn running from `source`. */
export function toolsForSource(source: string | undefined): ToolDescriptor[] {
  const s = (source || 'desktop') as ToolScope;
  // The two background runs take explicit lists rather than the
  // catalog-minus-`only` filter, so a newly added tool is excluded by default.
  // See REVIEW_TOOLS / MEMORY_TOOLS.
  if (s === 'review') return TOOL_CATALOG.filter((t) => REVIEW_TOOLS.includes(t.name));
  if (s === 'memory') return TOOL_CATALOG.filter((t) => MEMORY_TOOLS.includes(t.name));
  return TOOL_CATALOG.filter((t) => !t.only || t.only.includes(s));
}

/** The allowlist handed to pi as `tools:` — covers builtin AND custom names. */
export function activeToolNames(source: string | undefined): string[] {
  return toolsForSource(source).map((t) => t.name);
}

// Render the catalog as the markdown bullet list used in the "Available tools"
// section of the helper prompt.
export function formatToolList(tools: ToolDescriptor[] = TOOL_CATALOG): string {
  return tools.map((t) => `- \`${t.name}\`: ${t.desc}`).join('\n');
}
