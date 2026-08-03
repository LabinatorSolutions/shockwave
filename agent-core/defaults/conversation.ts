// The message a background run receives on top of the conversation it resumes.
//
// Two runs need this — review (skills) and memory — and they are separate
// processes with separate triggers, prompts and chats. What they share is the
// SHAPE of that message, so it lives here rather than in either one.
//
// ── Why there is no conversation in here any more ───────────────────────────
//
// This module used to render a stored conversation into text and paste it inside
// the user message, because a background run started as a fresh chat with no
// history of its own. That version dropped the tool ARGUMENTS — it emitted
// `ASSISTANT [called bash]` and then the output of that command, so the run read
// what a command printed without ever seeing the command. It dropped the
// reasoning and the images too.
//
// A background run now clones the source chat's row, conversation and all, and
// resumes it (`cloneChatForBackground` in the companion's store). So the
// conversation is present as real messages, complete, and this file is down to
// the one thing that genuinely has to be said in words.
//
// ── What the run cannot know from a frozen prompt ───────────────────────────
//
// The cloned system prompt was written for the SOURCE chat. It names that chat's
// working directory, and it was assembled for a run with a user present. Both are
// wrong here, and neither can be fixed by editing the prompt — that would
// reintroduce the rebuilding this design removed. So they are stated here, in the
// one part of the request that was never frozen.

export interface BackgroundContext {
  /** This run's checkout. The prompt above names the SOURCE chat's directory,
   *  which does not exist here. */
  workspacePath: string;
}

/**
 * The context note, then the instruction.
 *
 * Order is deliberate and matches hermes: the instruction reads last, so it is
 * what the model acts on. The note before it is orientation, not a task.
 */
export function backgroundInstruction(ctx: BackgroundContext, instruction: string): string {
  return `[This is a maintenance turn on a conversation you have already had. Everything above is that conversation, exactly as it happened.

Two things have changed since then, and the instructions above this conversation still describe how it was: you are now working in a fresh checkout at ${ctx.workspacePath} — use that path, not any directory named earlier — and nobody is present. There is no one to ask, no one to confirm with, and nothing you say will be read by a person. Decide and act, or say there is nothing to do.]

${instruction}`;
}
