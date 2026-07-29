// Assembles the coding-agent system prompt from its parts and re-exports the
// pieces the rest of main needs.
//
// Final prompt handed to pi as the custom system-prompt override:
//
//     <SOUL (workspace SOUL.md, else DEFAULT_SOUL)>
//
//     <SHOCKWAVE_HELPER (app mechanics + dynamic tool list)>
//
// pi then appends, on its own, at session boot:
//     → discovered AGENTS.md contents (CLAUDE.md filtered out — see codingAgent.ts)
//     → the enabled skills list
//     → "Current date: YYYY-MM-DD"   (date only, no time)
//
// So we do NOT add date, skills, or AGENTS.md here — pi owns those. This is baked
// once per session (the assembled string is part of the session cache key), so it
// never changes mid-conversation.

import { buildShockwaveHelper, HELPER_MARK } from './helper.js';
import { readSoul } from './soul.js';
import { toolsForSource } from './tools.js';

export { readSoul, SOUL_FILENAME, AGENTS_FILENAME, AGENTS_STUB, DEFAULT_SOUL } from './soul.js';
export { buildShockwaveHelper, HELPER_MARK } from './helper.js';
export { TOOL_CATALOG, formatToolList, toolsForSource, activeToolNames } from './tools.js';

export interface PromptOpts {
  unattended?: boolean;
  /** Where the turn runs from (RunOpts.source) — scopes the tool list. */
  source?: string;
}

// Build the full system prompt for the given workspace. Reads that workspace's
// SOUL.md (or the built-in default) and joins it above the Shockwave helper.
// `unattended` (a cron run) adds the unattended-override section to the helper;
// `source` decides which tools the helper advertises.
export async function assembleSystemPrompt(
  workspacePath: string | null | undefined,
  opts: PromptOpts = {},
): Promise<string> {
  const soul = await readSoul(workspacePath);
  return `${soul}\n\n${helperFor(opts)}`;
}

// Refresh a STORED prompt: keep the SOUL it was created with, rebuild the helper
// for this run. The tool list is the reason — a chat created from Telegram and
// resumed on the desktop would otherwise advertise the creator's tools, and the
// allowlist pi actually enforces is computed fresh every boot. SOUL stays frozen
// so a mid-conversation SOUL.md edit doesn't rewrite the agent's identity.
// A prompt stored before the marker existed has no seam to cut on — returned as
// is, which is what it has always done.
export function rebuildSystemPrompt(stored: string, opts: PromptOpts = {}): string {
  const at = stored.indexOf(HELPER_MARK);
  if (at < 0) return stored;
  return `${stored.slice(0, at).trimEnd()}\n\n${helperFor(opts)}`;
}

function helperFor(opts: PromptOpts): string {
  return buildShockwaveHelper({ tools: toolsForSource(opts.source), unattended: opts.unattended });
}
