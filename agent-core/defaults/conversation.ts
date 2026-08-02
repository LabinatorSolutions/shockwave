// Rendering a stored conversation for a background run to read.
//
// Two runs need this — the review (skills) and the memory pass — and they are
// separate processes with separate triggers, separate prompts and separate
// chats. The one thing they share is HOW a stored conversation is handed to a
// model, so that lives here rather than in either one of them. Same split as
// `transcriptFormat.ts` beside `transcribe.ts`: the pure shaping is its own
// module and can be tested without any of the machinery around it.

/** One stored message, as `store.getMessages` returns it. */
export interface RenderableMessage {
  role: string;
  content?: string | null;
  toolName?: string | null;
  toolCalls?: string | null;
}

/**
 * Render a stored conversation as plain text.
 *
 * The transcript goes in as TEXT inside one user message rather than being
 * replayed as structured messages. knack does the same, and the reason is worth
 * keeping: replayed tool-call parts have to be valid against the tools the
 * current run holds, and a background run holds a different, smaller set. As
 * text there is nothing to validate and nothing to reconcile.
 *
 * Tool output is included. It is bounded before it ever reaches us — pi
 * truncates tool results at 2000 lines or 50KB, whichever comes first — and both
 * hermes and knack replay results in full, because "the command failed like
 * this and here is what fixed it" is most of what a skill is made of.
 *
 * Reasoning is skipped: large, and not what a skill or a memory is written from.
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

/** The conversation, then the instruction. The order is deliberate: the
 *  instruction reads last so it is what the model acts on. */
export function promptOverConversation(messages: RenderableMessage[], instruction: string): string {
  return `Here is the conversation to review:\n\n<conversation>\n${renderConversation(messages)}\n</conversation>\n\n${instruction}`;
}
