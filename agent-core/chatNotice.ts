// The notice Telegram sends when you pick a chat back up after a gap: the chats
// that moved while you were away, numbered so `/chat <n>` works straight off it.
//
// It lives in agent-core because BOTH builds read it — the companion decides
// whether to send one and how many to list, and the desktop's Telegram settings
// page renders the values actually in effect. A second copy of these numbers is
// how the page comes to say 24 hours while the bot waits 48. Same reason
// `credentials.ts` is here.

export interface ChatNotice {
  /** Send the notice at all. Unset ⇒ on. */
  enabled?: boolean;
  /** How old the chat you're returning to has to be before it's worth saying
   *  anything. Unset ⇒ 24. Zero is legal and means every resumed chat gets one —
   *  that is a different thing from off, which is `enabled: false`. */
  afterHours?: number;
  /** How many of the newer chats to list. Unset ⇒ 3. */
  limit?: number;
}

export const CHAT_NOTICE_DEFAULTS: Required<ChatNotice> = { enabled: true, afterHours: 24, limit: 3 };

/**
 * Fill in whatever the settings row left unset, and refuse values that would
 * make the message nonsense — a negative window, a list of nothing.
 *
 * The numbers arrive from a text input by way of a JSON column, so the type
 * check earns its place: `afterHours: "24"` would otherwise sail through and
 * compare as a string against a millisecond difference.
 */
export function resolveChatNotice(n?: ChatNotice | null): Required<ChatNotice> {
  const num = (v: unknown, dflt: number, min: number, max: number) => (
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : dflt
  );
  return {
    enabled: n?.enabled ?? CHAT_NOTICE_DEFAULTS.enabled,
    afterHours: num(n?.afterHours, CHAT_NOTICE_DEFAULTS.afterHours, 0, 24 * 365),
    // Capped at the same 10 the `/chats` "Recent" section shows: the notice is a
    // shortcut into that list, so it can never offer a number the list doesn't.
    limit: num(n?.limit, CHAT_NOTICE_DEFAULTS.limit, 1, 10),
  };
}
