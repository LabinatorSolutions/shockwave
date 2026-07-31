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
