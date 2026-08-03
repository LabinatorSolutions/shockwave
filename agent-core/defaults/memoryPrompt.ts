// The instruction a memory run receives.
//
// ── Provenance ──────────────────────────────────────────────────────────────
//
// MEMORY_REVIEW_PROMPT is hermes-agent's `_MEMORY_REVIEW_PROMPT`
// (`agent/background_review.py`), extracted from the source by AST rather than
// retyped, and kept VERBATIM — character for character, with no substitutions
// at all. It names exactly one thing outside itself, "the memory tool", and
// ours is called `memory`, so there was nothing to adapt.
//
// That is the whole file, and it is deliberately short. hermes' memory prompt
// asks two questions and stops; the length is in the tool description, which is
// where the rules about what to save, what to skip and how to consolidate
// actually live (see `memoryTool.ts`). Do not grow this text — anything added
// here would be a second, competing statement of rules the tool already carries.
//
// Note what it does NOT do: it carries no bias to action. The skill prompt says
// "be ACTIVE — most sessions produce at least one skill update"; this one offers
// 'Nothing to save.' as a plain option. That asymmetry is hermes' and it is
// right — a conversation that revealed nothing about the user should record
// nothing about the user, whereas a session that did real work almost always
// taught something. It is also why the two runs must stay separate: pointing the
// skills instruction at a chat that only talked is how an agent invents a skill
// about nothing.

import { backgroundInstruction, type BackgroundContext } from './conversation.ts';

export const MEMORY_REVIEW_PROMPT = `Review the conversation above and consider saving to memory if appropriate.

Focus on:
1. Has the user revealed things about themselves — their persona, desires, preferences, or personal details worth remembering?
2. Has the user expressed expectations about how you should behave, their work style, or ways they want you to operate?

If something stands out, save it using the memory tool. If nothing is worth saving, just say 'Nothing to save.' and stop.`;

/** The full prompt for a memory run: the conversation, then the instruction. */
/** The message a memory run receives. The conversation is not in it — the run
 *  resumes the real session, so it is already above this. */
export function buildMemoryPrompt(ctx: BackgroundContext): string {
  return backgroundInstruction(ctx, MEMORY_REVIEW_PROMPT);
}

export type { BackgroundContext };
