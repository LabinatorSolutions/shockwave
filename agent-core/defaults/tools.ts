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
// EVERY tool is offered to EVERY chat. Where a tool doesn't belong, the call is
// refused when it happens (`DENIED` below, enforced by `toolGate.ts`) rather
// than the tool being hidden.
//
// Hiding was the older design, and it cost two things. The agent could not say
// why it was unable to do something — a Telegram run doesn't know `open_file`
// exists, so "I can't open a tab here, but I can send you the file" was not
// available to it. And the offered set varied by source, which is the only
// reason the system prompt had to be regenerated on every resume: a chat started
// on Telegram and continued on the desktop would otherwise advertise the wrong
// list. One constant list means the prompt written when a chat is created stays
// true for the life of that chat, which is what lets it be stored once and read
// back verbatim.
//
// A host's `extraTools` must still be named here — pi filters custom tools
// against the allowlist exactly like builtins (see _refreshToolRegistry in pi's
// agent-session.js), so a host tool missing from the catalog is silently
// dropped. That is what happened to `send_message`: the companion supplied it,
// the catalog didn't name it, and the agent reported it had no way to message
// the user. agent.ts logs a warning if a host ever supplies an unnamed tool.

/** Where a turn is running from — `RunOpts.source`. */
export type ToolScope = 'desktop' | 'cron' | 'telegram' | 'review' | 'memory';

export const TOOL_SCOPES: ToolScope[] = ['desktop', 'cron', 'telegram', 'review', 'memory'];

/**
 * What each kind of run may NOT do, and the sentence the agent is given when it
 * tries. A source absent from this table denies nothing.
 *
 * Written as a denial per source rather than a scope per tool because that is
 * the shape of the actual policy: "a review run reads and curates, nothing else"
 * is one line here and eleven `only` entries spread across the catalog. It also
 * means the question a reader asks — what can't a review run do? — is answered
 * by reading one list.
 *
 * The cost of this direction, stated plainly: a tool added later is allowed
 * everywhere until someone names it here. The old explicit allowlists existed to
 * prevent exactly that, and `daily_note` proved it can happen. Adding a tool now
 * means deciding, in this file, where it does not belong.
 *
 * Review denies `write`, `edit` and `bash` because with any of them the
 * containment and read-before-write guards in `manageSkill.ts` are decorative —
 * the agent could edit a SKILL.md directly. It denies the rest because a
 * maintenance pass has no user to message, no credentialed work to do, and no
 * app window. Memory denies everything but `memory`: its whole input is the
 * conversation it was handed plus the current memory, and the current memory is
 * already in its prompt.
 *
 * `per` overrides the shared sentence for one tool, and exists because Telegram
 * is the one source denying two tools for two different reasons — the shared
 * sentence there answered `open_file` and left `send_message` reading about app
 * windows. Nothing else needs it: a review run's eleven denials really do have
 * one reason between them.
 */
export const DENIED: Partial<Record<ToolScope, { tools: string[]; reason: string; per?: Record<string, string> }>> = {
  review: {
    tools: [
      'bash', 'edit', 'write',
      'list_agent_secrets', 'get_agent_secret', 'open_file', 'send_message',
      'transcribe', 'daily_note', 'search_chats', 'memory',
    ],
    reason: 'this is a review run — it reads the conversation above and updates your skills, and holds `read`, `grep`, `find`, `ls` and `manage_skill` to do it. Nothing else is available. Work with what you have or say there is nothing to save.',
  },
  memory: {
    tools: [
      'read', 'bash', 'edit', 'write', 'grep', 'find', 'ls',
      'list_agent_secrets', 'get_agent_secret', 'open_file', 'send_message',
      'transcribe', 'daily_note', 'search_chats', 'manage_skill',
    ],
    reason: 'this is a memory run — it looks over the conversation above for facts worth keeping and holds only the `memory` tool. Everything you need is already in front of you: the conversation, and the current memory in your prompt.',
  },
  // `open_file` opens a tab in the app UI, and only a desktop chat has one.
  //
  // `send_message` is the interesting one, and it is denied here for the reason
  // it exists at all: it is for reaching a user who is NOT in the conversation —
  // a scheduled job that finished, a desktop turn with something urgent. On a
  // Telegram run the user is right there and the reply is already going to them
  // over Telegram. Calling it delivers the same words a second time, by a second
  // route, and that is exactly what it did: a message sent as text and then read
  // aloud again as a voice note, with nothing in the conversation explaining why.
  //
  // Its sentence says the reply ROUTES there, not merely that the user is
  // present, because the likeliest motive for reaching for the tool is wanting
  // this one answer spoken — and the ordinary reply already goes out under the
  // same `/voice` mode the tool would have used (`sendsText`/`speaks` in
  // api/src/telegram/webhook.ts). Told the delivery is automatic, there is
  // nothing left for the call to add.
  telegram: {
    tools: ['open_file', 'send_message'],
    reason: 'there is no app window on a Telegram run — nobody has the app open. To hand over a file, name its path in your reply.',
    per: {
      send_message: 'all your messages already route to Telegram automatically, so you do not need this tool. Just write your reply.',
    },
  },
  cron: {
    tools: ['open_file'],
    reason: 'there is no app window on a scheduled run — nobody is watching one. Use `send_message` if the user needs to see this now.',
  },
};

export interface ToolDescriptor {
  name: string;
  desc: string;
  origin: 'builtin' | 'custom';
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
  // Opens a tab in the app UI — only a desktop chat has one, so `DENIED` refuses
  // it elsewhere and tells the agent what to reach for instead.
  { name: 'open_file', origin: 'custom', desc: 'Open a file in the app UI (a new tab) so the user can see it. Use when the user asks you to open, show, or display a file. The path is workspace-relative; only files the app can display (.md, images, video, .excalidraw) can be opened.' },
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

/** The allowlist handed to pi as `tools:` — covers builtin AND custom names.
 *  Every name, every run: what a run may not USE is decided at call time. */
export function activeToolNames(): string[] {
  return TOOL_CATALOG.map((t) => t.name);
}

/**
 * Why `tool` is refused on a run from `source`, or null when it is allowed.
 *
 * The message names the tool and then explains the RUN, because that is the only
 * thing the agent doesn't already know — it made the call, so it knows which
 * tool it reached for. One sentence per source by default: the reason a review
 * run can't run `bash` is the same reason it can't run `edit`. `per` is the
 * exception for a source whose denials don't share a reason.
 */
export function deniedReason(tool: string, source: string | undefined): string | null {
  const entry = DENIED[(source || 'desktop') as ToolScope];
  if (!entry || !entry.tools.includes(tool)) return null;
  return `\`${tool}\` is not available here: ${entry.per?.[tool] ?? entry.reason}`;
}

// Render the catalog as the markdown bullet list used in the "Available tools"
// section of the helper prompt.
export function formatToolList(tools: ToolDescriptor[] = TOOL_CATALOG): string {
  return tools.map((t) => `- \`${t.name}\`: ${t.desc}`).join('\n');
}
