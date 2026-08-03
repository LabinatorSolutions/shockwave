// How the agent's Telegram replies come back, and the two questions every
// delivery path asks of that.
//
// PURE POLICY — no disk, no store. The value itself lives on the companion, in
// `workspace.voice_reply`, because `/voice` is a slash command: those are
// answered straight from that database with no checkout prepared, and a file in
// the checkout would have made changing a preference cost a clone. It also means
// the setting is not a git-synced file the agent has to read-modify-write, and
// not something a run's commit has to carry back.
//
// Dependency-free, so `node --test` loads it directly and both builds import it
// without ceremony — same as `credentials.ts` and `voiceProviders.ts`.

/**
 * - `'text'`  — text only. The default.
 * - `'voice'` — a voice note only. Nothing to skim, so it is opt-in knowingly.
 * - `'both'`  — a voice note AND the text.
 */
export type VoiceReply = 'text' | 'voice' | 'both';

/** Text unless asked otherwise. Speaking costs money on every reply, so it is
 *  never what you get by doing nothing. */
export const DEFAULT_VOICE_REPLY: VoiceReply = 'text';

export const VOICE_REPLY_MODES: VoiceReply[] = ['text', 'voice', 'both'];

/** What each mode is called where a person reads it. */
export const VOICE_REPLY_LABELS: Record<VoiceReply, string> = {
  text: 'text only',
  voice: 'voice only',
  both: 'voice and text',
};

/** Anything that isn't one of the three reads as the default. The column is plain
 *  text and more than one writer can reach it, so normalize on the way in AND out
 *  rather than trusting whoever wrote last. */
export function normalizeVoiceReply(value: unknown): VoiceReply {
  return value === 'voice' || value === 'both' ? value : DEFAULT_VOICE_REPLY;
}

/** Is this a mode at all? `/voice bogus` should say so rather than silently
 *  setting text. */
export function isVoiceReply(value: unknown): value is VoiceReply {
  return VOICE_REPLY_MODES.includes(value as VoiceReply);
}

/** Does this mode send the written text? False only for voice-only. */
export const sendsText = (mode: VoiceReply): boolean => mode !== 'voice';
/** Does this mode speak? */
export const speaks = (mode: VoiceReply): boolean => mode !== 'text';
