// Assembles the coding-agent system prompt from its parts and re-exports the
// pieces the rest of main needs.
//
// Final prompt handed to pi as the custom system-prompt override:
//
//     <SOUL (workspace SOUL.md, else DEFAULT_SOUL)>
//
//     <SHOCKWAVE_HELPER (app mechanics + dynamic tool list)>
//
// pi then appends, on its own, at session boot (buildSystemPrompt's customPrompt
// branch in pi's `core/system-prompt.js`), in this order:
//     → project context files — each wrapped in <project_instructions path="…">
//       inside one <project_context> block. pi looks for AGENTS.md / AGENTS.MD /
//       CLAUDE.md / CLAUDE.MD per directory and takes the FIRST that exists, in
//       its own agentDir and then in every ancestor of cwd, root → cwd
//       (`loadContextFileFromDir` in pi's `core/resource-loader.js`). Nothing
//       here filters CLAUDE.md out — it simply loses to AGENTS.md in any
//       directory holding both, which is why the seeded AGENTS.md is what a
//       workspace root contributes.
//     → the enabled skills list
//     → "Current date: YYYY-MM-DD"   (date only, no time)
//     → "Current working directory: <cwd>"
//
// So we do NOT add date, cwd, skills, or AGENTS.md here — pi owns those. Note
// those four are re-derived on every boot, unlike everything above, which is
// assembled once at chat creation and read back verbatim forever.

import { buildShockwaveHelper } from './helper.js';
import { readSoul } from './soul.js';
import { TOOL_CATALOG } from './tools.js';

export { readSoul, SOUL_FILENAME, AGENTS_FILENAME, AGENTS_STUB, DEFAULT_SOUL } from './soul.js';
export { buildShockwaveHelper } from './helper.js';
export { TOOL_CATALOG, DENIED, activeToolNames, deniedReason } from './tools.js';

export interface PromptOpts {
  unattended?: boolean;
  /** Where the turn runs from (RunOpts.source). Gates the companion-only
   *  sections. It no longer scopes the tool list — every run is offered the
   *  whole catalog and refused per call (see `tools.ts`). */
  source?: string;
  /** The agent's own directory for this chat, named in the Boundaries section. */
  scratchDir?: string;
  /**
   * Accepted and no longer used by the prompt.
   *
   * It named the zone in the Scheduled-runs section so the agent wrote one-time
   * schedules in the zone the scheduler evaluates them in. That section is now
   * the `cron` tool, which is handed the timezone directly and states it per
   * call — a live value rather than one frozen into the chat.
   *
   * Kept on the type because every caller passes it and removing it is churn
   * with no behaviour behind it; drop it when something else here needs a zone.
   */
  timezone?: string;
  /**
   * The rendered MEMORY.md / USER.md blocks (`MemoryStore.renderForPrompt`).
   *
   * Passed in rather than read here because reading is async and
   * `rebuildSystemPrompt` is not — and it must stay sync, since it is the resume
   * path's one cheap operation. The caller (`bootSession`) is already async and
   * already reads the workspace, so it does the read once and hands the text to
   * both branches.
   */
  memory?: string;
  /**
   * The workspace's templates — folder + `.md` list, read at chat creation by
   * `readTemplates` (templates.ts) and frozen with the prompt. Undefined (no
   * folder configured, folder missing, or empty) means no Templates section,
   * not an error. Passed in rather than read here for the same reason as
   * `memory`: reading is async and assembly stays a single pass.
   */
  templates?: { folder: string; files: string[] };
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

// A stored prompt is used VERBATIM — there is no rebuild, and this is the only
// place a prompt is ever built.
//
// There used to be a `rebuildSystemPrompt` here that kept the SOUL and
// regenerated the helper on every resume. It existed for one reason: the tool
// list varied by source, so a chat created from Telegram and continued on the
// desktop would advertise the creator's tools while pi enforced a freshly
// computed allowlist. Every run is now offered the whole catalog and refused per
// call, so there is nothing left to correct — and a chat's instructions no
// longer change under it between one message and the next.
//
// What a particular RUN needs to know that a frozen prompt cannot say — a
// different working directory, that no user is present — belongs in that run's
// first user message, which was never frozen.

// `scratchDir` names a real directory in the Boundaries rules, `source` gates the
// companion-only sections, `memory` is the block itself. All are frozen with the
// prompt at chat creation, which is the point.
function helperFor(opts: PromptOpts): string {
  return buildShockwaveHelper({
    tools: TOOL_CATALOG,
    unattended: opts.unattended,
    source: opts.source,
    scratchDir: opts.scratchDir,
    memory: opts.memory,
    templates: opts.templates,
  });
}
