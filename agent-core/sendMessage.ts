// The `send_message` tool — the agent DMs the user on Telegram.
//
// Both hosts get the SAME tool (one name, one description, one schema) so a chat
// behaves identically whether the turn runs on the desktop or on the companion.
// Only the delivery differs, and that's the injected `send`: the companion calls
// sendTelegramMessage in-process, the desktop POSTs /telegram/send. The bot token
// is companion-only, so the desktop never holds a credential for this.
//
// Same shape as the agent-token tools (agentTokens.ts): a factory closed over the
// host's I/O, never a module-global.
//
// ── HOW IT IS DELIVERED IS NOT THE AGENT'S CHOICE ────────────────────────────
//
// Text or voice is decided by the WORKSPACE, set with `/voice`, and this tool
// takes no say in it. There is no per-message override and there is deliberately
// no argument for one.
//
// It had one. The agent passed `both` on a workspace set to `text`, and the user
// got a voice note they had switched off — which is the whole failure: a standing
// preference that anything else can overrule is not a preference, it is a
// default, and the person who set it has no way to tell which they have. An
// override is also unfalsifiable from the outside: the setting says one thing,
// the messages do another, and nothing in between is wrong enough to look at.
//
// The argument existed on the theory that the agent knows when a message carries
// something worth re-reading. It might — but the user already answered that
// question for every message when they chose the mode, and a model weighing it
// per message can only diverge from the answer they gave.
//
// It cannot CHANGE the preference either, for a separate reason: a tool that
// sends a message and also mutates configuration is a category error, and it put
// a settings write on the end of a path reachable from any Telegram message or
// repo file. Changing the mode is `/voice` — a slash command, answered from the
// database with no turn and no agent involved. hermes reached the same place.

export type SendOutput = 'text' | 'voice' | 'both';

export interface SendOptions {
  /**
   * How this message is delivered, for the callers that legitimately know: the
   * reaction read-back speaks, and cron delivers what the job asked for.
   *
   * **Never set from the tool.** The agent has no argument for it — see above.
   * Unset ⇒ the workspace's stored preference, which is the normal path.
   */
  output?: SendOutput;
}

export type SendResult = { ok: true } | { ok: false; error: string };

export function makeSendMessageTool(
  send: (text: string, opts: SendOptions) => Promise<SendResult>,
): any {
  return {
    name: 'send_message',
    label: 'Send Message',
    // This description absorbed the prompt's `# Reaching the user` section, which
    // is now deleted. Same move as skills and daily notes: what a tool is FOR
    // belongs with the tool, where it is read at the call site and where an edit
    // reaches chats that already exist — the system prompt is frozen when a chat
    // is created and cannot be revised for it afterwards.
    //
    // Two sentences: what it is, and when to reach for it. The trigger list is
    // the load-bearing half — those phrases name a DESTINATION, not a
    // description, and without the mapping the agent writes the answer down or
    // says it into a chat nobody is reading.
    //
    // It reached 1,249 chars before being cut to this. What went, and why none
    // of it was doing work:
    //
    //   - A paragraph on the /voice setting. The agent cannot read it, cannot
    //     set it, and cannot see which form a reply took. The schema has ONE
    //     parameter, so there is no way to act on any of that — a rule needs
    //     something the model could otherwise do wrong.
    //   - "If it fails, say so rather than treating the task as done." A failed
    //     send already returns `isError: true` carrying the reason. The result
    //     says it; the description repeating it adds nothing.
    //   - Justification prose — "take them literally", "a message not sent is a
    //     message that did not happen". That is an argument for the rule, aimed
    //     at whoever is reading the source. The rule is the part that ships.
    description:
      'Send the user a Telegram DM — the only way to reach them outside this chat.\n\n'
      + '"Send me", "notify me", "let me know", "ping me", "remind me", "tell me when" all mean CALL '
      + 'THIS, not write it down.',
    promptSnippet: 'Message the user on Telegram (a result or an alert), spoken aloud if they want that.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The message to send.' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    async execute(_id: string, params: any) {
      try {
        // No `output`: the workspace's preference is read at the delivery end, so
        // there is nothing here to pass and nothing to get wrong.
        const res = await send(String(params?.text ?? ''), {});
        if (!res?.ok) return { content: [{ type: 'text', text: res?.error || 'Could not send the message.' }], isError: true };
        return { content: [{ type: 'text', text: 'Message sent to the user on Telegram.' }] };
      } catch (e: any) {
        return { content: [{ type: 'text', text: 'Could not send the message: ' + (e?.message || e) }], isError: true };
      }
    },
  };
}
