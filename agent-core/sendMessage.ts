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
// `output` is deliberately THREE-valued, and the third value is ABSENT. Omitted
// means "whatever this workspace is set to", which is what makes a standing
// preference work at all: a two-valued flag defaulting to text would override the
// setting on every proactive message, so switching to voice would change ordinary
// replies and silently not these.
//
// `save` is what turns one message into that standing preference. Off by default,
// because "say this one out loud" is a far more common request than "speak to me
// from now on", and of the two ways to guess wrong, the one that keeps talking is
// the one the user has to go and undo.

export type SendOutput = 'text' | 'voice' | 'both';

export interface SendOptions {
  /** Unset ⇒ follow the workspace's stored preference. */
  output?: SendOutput;
  /** Also make `output` the workspace's standing preference. */
  save?: boolean;
}

export type SendResult =
  | { ok: true; savedMode?: SendOutput; saveFailed?: boolean }
  | { ok: false; error: string };

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
      + 'a list — since a voice note cannot be skimmed or searched. Add `save: true` only when the user '
      + 'asks for a lasting change ("talk to me from now on", "stop sending voice notes"), and it '
      + 'becomes the setting for every reply after.',
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
        save: {
          type: 'boolean',
          description:
            'Make `output` the standing preference for this workspace, so every later reply follows it. '
            + 'Only when the user asked for a lasting change. Defaults to false.',
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
    async execute(_id: string, params: any) {
      try {
        const output = ['text', 'voice', 'both'].includes(params?.output) ? params.output as SendOutput : undefined;
        // `save` with no `output` names no mode to save, so it is ignored rather
        // than guessed at — saving "whatever the setting already is" is a no-op
        // dressed up as an action.
        const save = !!params?.save && !!output;

        const res = await send(String(params?.text ?? ''), { output, save });
        if (!res?.ok) return { content: [{ type: 'text', text: res?.error || 'Could not send the message.' }], isError: true };

        // Report what HAPPENED, not what was asked for. A save that quietly failed
        // is how the agent ends up promising a lasting change that lasted one
        // message, with the user finding out three replies later.
        let note = 'Message sent to the user on Telegram.';
        if (res.savedMode) note += ` Replies for this workspace are now ${res.savedMode}.`;
        else if (res.saveFailed) note += ' The preference could not be saved, so this applied to that message only.';
        return { content: [{ type: 'text', text: note }] };
      } catch (e: any) {
        return { content: [{ type: 'text', text: 'Could not send the message: ' + (e?.message || e) }], isError: true };
      }
    },
  };
}
