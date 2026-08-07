// The `memory` pi tool — the agent's one way to write MEMORY.md / USER.md.
//
// Built per session with the workspace and its char limits closed over, the same
// shape as `makeDailyNoteTool`: no `AgentHost` plumbing, because everything it
// needs is a path and two numbers.
//
// ── The description IS the behaviour ────────────────────────────────────────
//
// MEMORY_TOOL_DESCRIPTION is hermes-agent's `MEMORY_SCHEMA["description"]`
// (`tools/memory_tool.py`), extracted from the source by AST rather than
// retyped, and kept verbatim except for ONE substitution:
//
//   1. "use session_search for those" → "use search_chats for those". Same tool,
//      our name for it. hermes' point — that task progress and completed-work
//      logs belong in the searchable transcript, not in the budget — holds
//      exactly, because `search_chats` reads stored messages the same way.
//
// Everything else of hermes' is untouched: the labelled paragraphs (HOW / WHEN /
// IF FULL / TARGETS / SKIP), the instruction to prefer ONE batch call, the
// priority order, and the closing rule that reusable procedures are a skill and
// not a memory. Do not tidy this text — the "don't repeat it" clause and the
// consolidate-in-one-batch instruction are what stop the model reissuing the
// same write five times, which is a thing it did.
//
// ── Two ADDITIONS, and why they are here rather than in the prompt ──────────
//
// hermes carries these two rules as well, but in its SYSTEM PROMPT
// (`MEMORY_GUIDANCE`, injected when the memory tool is loaded) rather than in
// this description. We had neither, in either place.
//
//   PHRASING — a memory written as an imperative is indistinguishable, next
//   chat, from an instruction the user just gave. It sits above the
//   conversation, so it can quietly outrank what they are actually asking for.
//   Declarative phrasing is what keeps a memory a fact rather than a standing
//   order.
//
//   The staleness test, appended to SKIP — hermes names the CATEGORY (task
//   progress, completed-work logs) and then gives the test: stale in a week,
//   not a memory. A category only classifies the cases already listed; the test
//   classifies the ones nobody thought of. Without it the budget fills with
//   commit SHAs and "Phase 2 done" and pushes out the facts worth keeping.
//
// They go HERE, not in `defaults/helper.ts`, because the system prompt is
// assembled once when a chat is created and replayed verbatim for the life of
// that chat — an edit there would reach only chats created afterwards. Tool
// descriptions are rebuilt at every session boot, so a change lands on every
// chat, including ones mid-conversation.
//
// hermes' parameter descriptions come across verbatim too. `old_text` being
// REQUIRED-in-prose but optional-in-schema is deliberate and load-bearing: it
// cannot be schema-required without a top-level combinator some providers
// reject, so a client that omits it gets `missingOldText` below — the current
// entries plus a retry instruction — instead of a dead end.

import { MemoryStore, type MemoryTarget, type MemoryResult } from './memoryStore.ts';

export const MEMORY_TOOL_DESCRIPTION =
  'Save durable facts to persistent memory that survive across sessions. Memory is '
  + 'injected into every future turn, so keep entries compact and high-signal.\n\n'
  + "HOW: make ALL your changes in ONE call via an 'operations' array (each item: "
  + '{action, content?, old_text?}). The batch applies atomically and the char limit is '
  + 'checked only on the FINAL result — so a single call can remove/replace stale entries '
  + 'to free room AND add new ones, even when an add alone would overflow. The response '
  + 'reports current/limit chars and confirms completion; one batch call finishes the '
  + "update, so don't repeat it. Use the bare action/content/old_text fields only for a "
  + 'single lone change.\n\n'
  + 'WHEN: save proactively when the user states a preference, correction, or personal '
  + 'detail, or you learn a stable fact about their environment, conventions, or workflow. '
  + 'Priority: user preferences & corrections > environment facts > procedures. The best '
  + 'memory stops the user repeating themselves.\n\n'
  + 'PHRASING: write entries as declarative facts, not instructions to yourself. '
  + "'User prefers concise responses' ✓ — 'Always respond concisely' ✗. "
  + "'Project uses pytest with xdist' ✓ — 'Run tests with pytest -n 4' ✗. "
  + 'Imperative phrasing gets re-read as a directive in a later chat and can cause '
  + "repeated work or override what the user is asking for then.\n\n"
  + 'IF FULL: an add is rejected with the current entries shown. Reissue as ONE batch that '
  + 'removes or shortens enough stale entries and adds the new one together.\n\n'
  + "TARGETS: 'user' = who the user is (name, role, preferences, style). 'memory' = your "
  + 'notes (environment, conventions, tool quirks, lessons).\n\n'
  + 'SKIP: trivial/obvious info, easily re-discovered facts, raw data dumps, task progress, '
  + 'completed-work logs, temporary TODO state (use search_chats for those). Specifically: '
  + "do not record PR numbers, issue numbers, commit SHAs, 'fixed bug X', 'Phase N done', or "
  + 'file counts. If a fact will be stale in a week, it does not belong in memory. Reusable '
  + 'procedures belong in a skill, not memory.';

/** hermes' recoverable error for a targeted action that arrived without its
 *  target. A bare "old_text is required" is a dead end; the inventory plus an
 *  explicit reissue instruction is not. */
async function missingOldText(store: MemoryStore, target: MemoryTarget, action: string): Promise<MemoryResult> {
  const entries = await store.read(target);
  const limit = store.limits[target];
  const current = entries.length ? entries.join('\n§\n').length : 0;
  return {
    success: false,
    error:
      `'${action}' needs old_text -- a short unique substring of the entry `
      + `to ${action}. None was provided. Reissue the ${action} with old_text `
      + 'set to part of one of the current_entries below.',
    current_entries: entries,
    usage: `${current.toLocaleString('en-US')}/${limit.toLocaleString('en-US')}`,
  };
}

export interface MemoryToolHandle {
  tools: any[];
  /** Clear the per-turn consolidation-failure count. Called at the start of
   *  every turn, so a turn that fought the budget doesn't poison the next. */
  resetTurn(): void;
  /**
   * The blocks for the system prompt, or '' when nothing is saved yet.
   *
   * On the handle rather than read separately so the prompt and the tool are
   * looking at ONE store with one set of limits — a usage line generated from
   * different numbers than the ones the tool enforces would tell the agent it
   * had room it does not have.
   */
  render(): Promise<string>;
}

export function makeMemoryTool(
  workspacePath: string,
  limits?: { memory?: number; user?: number },
): MemoryToolHandle {
  const store = new MemoryStore(workspacePath, limits);

  const tool: any = {
    name: 'memory',
    label: 'Memory',
    description: MEMORY_TOOL_DESCRIPTION,
    promptSnippet: 'Save durable facts about the user or this workspace.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['add', 'replace', 'remove'],
          description: "The action to perform (single-op shape). Omit when using 'operations'.",
        },
        target: {
          type: 'string',
          enum: ['memory', 'user'],
          description: "Which memory store: 'memory' for personal notes, 'user' for user profile.",
        },
        content: {
          type: 'string',
          description: "The entry content. Required for 'add' and 'replace' (single-op shape).",
        },
        old_text: {
          type: 'string',
          description: "REQUIRED for 'replace' and 'remove' (single-op shape): a short unique substring identifying the existing entry to modify. Omit only for 'add'.",
        },
        operations: {
          type: 'array',
          description:
            'Batch shape: a list of operations applied atomically in one call '
            + 'against the final char budget. Preferred when making multiple changes '
            + 'or consolidating to make room. Each item is {action, content?, old_text?}.',
          items: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['add', 'replace', 'remove'] },
              content: { type: 'string', description: 'Entry content for add/replace.' },
              old_text: { type: 'string', description: 'Substring identifying the entry for replace/remove.' },
            },
            required: ['action'],
          },
        },
      },
      required: ['target'],
      additionalProperties: false,
    },
    async execute(_id: string, params: any) {
      const p = params ?? {};
      // Some strict providers fill an optional field with JSON null rather than
      // omitting it, so a null target means "not given" and takes the default.
      const target: MemoryTarget = p.target == null ? 'memory' : p.target;
      if (target !== 'memory' && target !== 'user') {
        return fail({ success: false, error: `Invalid target '${p.target}'. Use 'memory' or 'user'.` });
      }

      let result: MemoryResult;
      if (Array.isArray(p.operations) && p.operations.length) {
        result = await store.applyBatch(target, p.operations);
      } else if (p.action === 'add') {
        result = p.content
          ? await store.add(target, p.content)
          : { success: false, error: "Content is required for 'add' action." };
      } else if (p.action === 'replace') {
        if (!p.old_text) result = await missingOldText(store, target, 'replace');
        else if (!p.content) result = { success: false, error: "content is required for 'replace' action." };
        else result = await store.replace(target, p.old_text, p.content);
      } else if (p.action === 'remove') {
        result = p.old_text
          ? await store.remove(target, p.old_text)
          : await missingOldText(store, target, 'remove');
      } else if (Array.isArray(p.operations)) {
        result = { success: false, error: 'operations list is empty.' };
      } else {
        result = { success: false, error: `Unknown action '${p.action}'. Use: add, replace, remove` };
      }

      const text = JSON.stringify(result);
      return result.success
        ? { content: [{ type: 'text', text }], details: { target, action: p.action ?? 'batch' } }
        : { content: [{ type: 'text', text }], isError: true };
    },
  };

  return {
    tools: [tool],
    resetTurn: () => store.resetTurn(),
    render: () => store.renderForPrompt(),
  };
}

function fail(result: MemoryResult) {
  return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: true };
}
