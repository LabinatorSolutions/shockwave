// Prompt sections that only make sense when the turn runs ON THE COMPANION —
// a Telegram message or a scheduled run. The desktop never sees these.
//
// Why it's a separate file rather than another block in helper.ts: everything in
// helper.ts describes the app itself and is true wherever a turn runs. These
// describe a delivery channel that exists on one host. Keeping them apart is what
// stops the desktop prompt from teaching a syntax nothing on the desktop parses —
// the agent would tell the user it sent a file, and no file would arrive.
//
// `buildShockwaveHelper` includes this only for source 'telegram' | 'cron'. If you
// add a third companion-run source, add it there, not here.

/** Sources whose turns run on the companion, where file delivery exists. */
export const COMPANION_SOURCES = ['telegram', 'cron'];

export const isCompanionSource = (source?: string): boolean =>
  COMPANION_SOURCES.includes(source ?? '');

// Copied from hermes-agent's Telegram platform hint (`agent/prompt_builder.py`),
// minus its closing sentence about markdown image URLs — we don't extract those,
// and a prompt that promises delivery we don't perform is worse than silence.
//
// Deliberately short. The size limit is a real check in `client.ts` that reports
// itself to the user, and the two folders delivery reads from are the same two the
// Boundaries section already names, so neither belongs here.
export const SENDING_FILES = `# Sending the user a file

You can send media files natively: to deliver a file to the user, include MEDIA:/absolute/path/to/file in your response. Images (.png, .jpg, .webp) appear as photos, audio (.ogg) sends as voice bubbles, and videos (.mp4) play inline.`;

// The reply mode is a SETTING the user owns, and the agent has no say in it at
// all — not per message, not permanently. So this section's job is to stop the
// agent doing two wrong things: describing a reply as spoken or not (the
// delivery is automatic and it cannot see which happened), and trying to change
// the mode itself when asked to.
//
// It used to document `output` and `save` arguments on `send_message`. Both are
// gone — the tool takes the text and nothing else (`sendMessage.ts`), and its
// schema is `additionalProperties: false`, so the instructions here were not
// merely stale, they were unfollowable. Why the arguments went is written out in
// that file; the short version is that a standing preference anything can
// overrule is not a preference, and a message tool that also writes settings is
// a category error.
export const SPEAKING = `# Speaking out loud

The user can have your replies delivered as a voice note as well as text. That is a per-workspace setting they control, and it applies to every reply automatically — ordinary replies and \`send_message\` alike. You do not need to do anything for it to work, you cannot tell which form a given reply took, and you should never describe a reply as spoken or written.

You have no say in it and no argument for it. If the user asks for a change — one message aloud, or a lasting one ("read that back to me", "talk to me from now on", "stop sending voice notes") — tell them to send \`/voice text\`, \`/voice voice\` or \`/voice both\`. That command is the only thing that sets it.`;
