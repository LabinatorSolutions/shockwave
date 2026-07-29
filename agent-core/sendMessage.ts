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

export type SendResult = { ok: true } | { ok: false; error: string };

export function makeSendMessageTool(send: (text: string) => Promise<SendResult>): any {
  return {
    name: 'send_message',
    label: 'Send Message',
    description: 'Send a message to the user on Telegram. Use this to reach the user proactively — e.g. when a scheduled job finishes or something needs their attention. They receive it as a Telegram DM.',
    promptSnippet: 'Message the user on Telegram (a result or an alert).',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: 'The message to send.' } },
      required: ['text'],
      additionalProperties: false,
    },
    async execute(_id: string, params: any) {
      try {
        const res = await send(String(params?.text ?? ''));
        if (res?.ok) return { content: [{ type: 'text', text: 'Message sent to the user on Telegram.' }] };
        return { content: [{ type: 'text', text: res?.error || 'Could not send the message.' }], isError: true };
      } catch (e: any) {
        return { content: [{ type: 'text', text: 'Could not send the message: ' + (e?.message || e) }], isError: true };
      }
    },
  };
}
