// The instruction a review run receives, and how the conversation it
// reviews is rendered for it.
//
// ── Provenance ──────────────────────────────────────────────────────────────
//
// SKILL_REVIEW_PROMPT is hermes-agent's `_SKILL_REVIEW_PROMPT`
// (`agent/background_review.py`), extracted from the source by AST rather than
// retyped, and kept verbatim except for EIGHT substitutions across six places.
// Every one is a name or a system that does not exist in this app — verified by
// diffing this text against the extracted original:
//
//   1. "loaded via /skill-name or you read via skill_view" → "skills you read
//      this run". pi has no skill_view: it lists each skill's location in the
//      prompt and the agent loads it with `read`.
//   2. "only if it is curator-managed" → "only if it lives in .agents/skills/".
//      Ownership here is a directory, not a telemetry record.
//   3. "(via skills_list + skill_view)" → the prompt already lists them.
//   4. "…are FIRST-CLASS skill signals, not just memory signals" → the trailing
//      clause is dropped. There is no memory store to contrast with.
//   5. The memory-vs-skills sentence under "User-preference embedding" is
//      dropped, for the same reason. (4 and 5 are the same substitution made in
//      two places — the prompt mentions memory twice.)
//   6. The curator handoff → "say so in your reply". There is no curator.
//   7. Five protected categories + `hermes curator adopt` → our two protected
//      roots.
//   8. "cannot use Y from execute_code" → "…from bash". `execute_code` is not a
//      tool here.
//
// Everything else is untouched, deliberately: the ACTIVE framing, the four
// signals, the four-step preference order, the support-file kinds, all five
// do-NOT-capture bullets, the setup-state rule, and the closing paragraph. The
// fifth bullet ("Unresolved failures") postdates knack's port of the same
// prompt, which is one reason this was taken from hermes directly.
//
// Do not tidy this text. Its shape is the result of a long tail of fixes — the
// bias to action, the ban on writing up dead ends as if they worked, and the
// list of things that harden into refusals the agent later cites against itself.

export const SKILL_REVIEW_PROMPT = `Review the conversation above and update the skill library. Be ACTIVE — most sessions produce at least one skill update, even if small. A pass that does nothing is a missed learning opportunity, not a neutral outcome.

Target shape of the library: CLASS-LEVEL skills, each with a rich SKILL.md and a \`references/\` directory for session-specific detail. Not a long flat list of narrow one-session-one-skill entries. This shapes HOW you update, not WHETHER you update.

Signals to look for (any one of these warrants action):
  • User corrected your style, tone, format, legibility, or verbosity. Frustration signals like 'stop doing X', 'this is too verbose', 'don't format like this', 'why are you explaining', 'just give me the answer', 'you always do Y and I hate it', or an explicit 'remember this' are FIRST-CLASS skill signals. Update the relevant skill(s) to embed the preference so the next session starts already knowing.
  • User corrected your workflow, approach, or sequence of steps. Encode the correction as a pitfall or explicit step in the skill that governs that class of task.
  • Non-trivial technique, fix, workaround, debugging path, or tool-usage pattern emerged that a future session would benefit from. Capture it.
  • A skill that got loaded or consulted this session turned out to be wrong, missing a step, or outdated. Patch it NOW.

Preference order — prefer the earliest action that fits, but do pick one when a signal above fired:
  1. UPDATE A SKILL YOU READ THIS RUN. Look back through the conversation for skills you read. If any of them covers the territory of the new learning, PATCH that one first. It is the skill that was in play, so it's the right one to extend — but only if it lives in \`.agents/skills/\`. Skills anywhere else are off-limits to you no matter how relevant (see Protected skills below); for those, fall through to the next option.
  2. UPDATE AN EXISTING UMBRELLA. The available skills are listed in your prompt with their locations; read one to check. If no skill you read fits but an existing class-level skill does, patch it. Add a subsection, a pitfall, or broaden a trigger.
  3. ADD A SUPPORT FILE under an existing umbrella. Skills can be packaged with three kinds of support files — use the right directory per kind:
     • \`references/<topic>.md\` — session-specific detail (error transcripts, reproduction recipes, provider quirks) AND condensed knowledge banks: quoted research, API docs, external authoritative excerpts, or domain notes you found while working on the problem. Write it concise and for the value of the task, not as a full mirror of upstream docs.
     • \`templates/<name>.<ext>\` — starter files meant to be copied and modified (boilerplate configs, scaffolding, a known-good example the agent can \`reproduce with modifications\`).
     • \`scripts/<name>.<ext>\` — statically re-runnable actions the skill can invoke directly (verification scripts, fixture generators, deterministic probes, anything the agent should run rather than hand-type each time).
     Add support files via skill_manage action=write_file with file_path starting 'references/', 'templates/', or 'scripts/'. The umbrella's SKILL.md should gain a one-line pointer to any new support file so future agents know it exists.
  4. CREATE A NEW CLASS-LEVEL UMBRELLA SKILL when no existing skill covers the class. The name MUST be at the class level. The name MUST NOT be a specific PR number, error string, feature codename, library-alone name, or 'fix-X / debug-Y / audit-Z-today' session artifact. If the proposed name only makes sense for today's task, it's wrong — fall back to (1), (2), or (3).

User-preference embedding (important): when the user expressed a style/format/workflow preference, the update belongs in the SKILL.md body. Skills capture 'how to do this class of task for this user'. When they complain about how you handled a task, the skill that governs that task needs to carry the lesson.

If you notice two existing skills that overlap, say so in your reply.

Protected skills (DO NOT edit these):
  • Built-in skills shipped with the app. They are not in this workspace and you cannot reach them.
  • Uploaded skills under \`.shockwave/skills/\`. The user put those there; they are theirs, not yours. This includes skills you read this run: being in play does not make one yours to edit. If such a skill is wrong or outdated, say so in your reply — do not try to patch it.
If the only skills that need updating are protected, say
'Nothing to save.' and stop.

Do NOT capture (these become persistent self-imposed constraints that bite you later when the environment changes):
  • Environment-dependent failures: missing binaries, fresh-install errors, post-migration path mismatches, 'command not found', unconfigured credentials, uninstalled packages. The user can fix these — they are not durable rules.
  • Negative claims about tools or features ('browser tools do not work', 'X tool is broken', 'cannot use Y from bash'). These harden into refusals the agent cites against itself for months after the actual problem was fixed.
  • Session-specific transient errors that resolved before the conversation ended. If retrying worked, the lesson is the retry pattern, not the original failure.
  • One-off task narratives. A user asking 'summarize today's market' or 'analyze this PR' is not a class of work that warrants a skill.

  • Unresolved failures: if the session ended WITHOUT actually finding a working method — you tried several things, none worked, and told the user to check manually — do NOT write those attempts up as a 'reliable workflow' or 'recommended approach'. That presents an untested sequence of failures as validated guidance a future session will trust and repeat. Either say 'Nothing to save', or, only if you are independently confident of a real working alternative (not something you are merely guessing might work), capture ONLY that alternative — never the dead ends, and never dressed up as best practice.

If a tool failed because of setup state, capture the FIX (install command, config step, env var to set) under an existing setup or troubleshooting skill — never 'this tool does not work' as a standalone constraint.

'Nothing to save.' is a real option but should NOT be the default. If the session ran smoothly with no corrections and produced no new technique, just say 'Nothing to save.' and stop. Otherwise, act.`;

/** One stored message, as `store.getMessages` returns it. */
export interface RenderableMessage {
  role: string;
  content?: string | null;
  toolName?: string | null;
  toolCalls?: string | null;
}

/**
 * Render a stored conversation as plain text for the run to read.
 *
 * The transcript goes in as TEXT inside one user message rather than being
 * replayed as structured messages. knack does the same, and the reason is worth
 * keeping: replayed tool-call parts have to be valid against the tools the
 * current run holds, and a review run holds a different, smaller set. As text
 * there is nothing to validate and nothing to reconcile.
 *
 * Tool output is included. It is bounded before it ever reaches us — pi
 * truncates tool results at 2000 lines or 50KB, whichever comes first — and both
 * hermes and knack replay results in full, because "the command failed like
 * this and here is what fixed it" is most of what a skill is made of.
 *
 * Reasoning is skipped: large, and not what a skill is written from.
 */
export function renderConversation(messages: RenderableMessage[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    const text = (m.content ?? '').trim();
    if (m.role === 'user') {
      if (text) lines.push(`USER: ${text}`);
    } else if (m.role === 'assistant') {
      // The names of the tools it decided to call, in order. The arguments live
      // on the row as JSON; the call is what shows the approach.
      let calls: string[] = [];
      try {
        const parsed = m.toolCalls ? JSON.parse(m.toolCalls) : null;
        if (Array.isArray(parsed)) {
          calls = parsed.map((c: any) => c?.name || c?.function?.name || 'tool').filter(Boolean);
        }
      } catch { /* unparseable tool_calls must not lose the message's text */ }
      if (calls.length) lines.push(`ASSISTANT [called ${calls.join(', ')}]`);
      if (text) lines.push(`ASSISTANT: ${text}`);
    } else if (m.role === 'tool') {
      lines.push(`TOOL ${m.toolName ?? 'result'}: ${text}`);
    }
  }
  return lines.join('\n');
}

/** The full prompt for a review run: the conversation, then the instruction. */
export function buildReviewPrompt(messages: RenderableMessage[]): string {
  return `Here is the conversation to review:\n\n<conversation>\n${renderConversation(messages)}\n</conversation>\n\n${SKILL_REVIEW_PROMPT}`;
}
