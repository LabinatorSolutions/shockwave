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
// ── OUTPUT MODE ──────────────────────────────────────────────────────────────
//
// `output` picks how ONE message is delivered, and the meaningful fourth state is
// ABSENT: omitted means "whatever this workspace is set to". That is what makes
// the standing preference work at all — a flag that defaulted to text would
// override the setting on every proactive message, so switching to voice would
// change ordinary replies and silently not these.
//
// **It cannot CHANGE that preference, deliberately.** This is a tool for sending
// a message; a tool that also mutates configuration is a category error, and it
// put a settings write on the end of a path reachable from any Telegram message
// or repo file. Changing the mode is `/voice` — a slash command, answered from
// the database with no turn and no agent involved, which is where a preference
// about how the bot talks to you belongs. hermes reached the same place with its
// own `/voice`.

export type SendOutput = 'text' | 'voice' | 'both';

export interface SendOptions {
  /** Unset ⇒ follow the workspace's stored preference. */
  output?: SendOutput;
}

export type SendResult = { ok: true } | { ok: false; error: string };

export function makeSendMessageTool(
  send: (text: string, opts: SendOptions) => Promise<SendResult>,
): any {
  return {
    name: 'send_message',
    label: 'Send Message',
    description:
      'Send a message to the user on Telegram. Use this to reach the user proactively — e.g. when a '
      + 'scheduled job finishes or something needs their attention. They receive it as a Telegram DM.\n\n'
      + 'Leave `output` unset to follow whatever the user has chosen for this workspace. Otherwise: '
      + '`text` sends writing only, `voice` sends a voice note only, `both` sends the voice note AND '
      + 'the text. Prefer `both` when the message carries anything worth re-reading — a path, a number, '
      + 'a list — since a voice note cannot be skimmed or searched.\n\n'
      + 'This affects ONE message. If the user asks for a lasting change ("talk to me from now on", '
      + '"stop sending voice notes"), tell them to send /voice text, /voice voice or /voice both — you '
      + 'cannot set it yourself.',
    promptSnippet: 'Message the user on Telegram (a result or an alert), spoken aloud if they want that.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The message to send.' },
        output: {
          type: 'string',
          enum: ['text', 'voice', 'both'],
          description:
            'How this message is delivered. Omit to follow the workspace setting. '
            + '`voice` is audio only; `both` is audio plus the written text.',
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
    async execute(_id: string, params: any) {
      try {
        const output = ['text', 'voice', 'both'].includes(params?.output) ? params.output as SendOutput : undefined;
        const res = await send(String(params?.text ?? ''), { output });
        if (!res?.ok) return { content: [{ type: 'text', text: res?.error || 'Could not send the message.' }], isError: true };
        return { content: [{ type: 'text', text: 'Message sent to the user on Telegram.' }] };
      } catch (e: any) {
        return { content: [{ type: 'text', text: 'Could not send the message: ' + (e?.message || e) }], isError: true };
      }
    },
  };
}
