// Pulling the user's images out of a pi message.
//
// pi holds a message's parts as `content: [{type:'text'}, {type:'image'}, …]`.
// `textOf` in `agent.ts` keeps only the text parts, which is correct for
// `message.content` (that column feeds the search tsvector — base64 in there
// would bury every real match). So this is the ONLY thing carrying images to
// storage, and if it ever returns nothing the chat silently stops rendering
// pictures with no error anywhere. That's the regression this exists to pin.
//
// Both hosts reach it identically: the desktop hands images to pi in
// `agentSend`, the companion does the same for Telegram, and both end up in the
// same `content` array. One function covers both clients.
//
// Plain `.js` so `node --test` loads it directly and both TypeScript builds
// import it without ceremony — same arrangement as `mediaTags.ts` and
// `credentials.ts` beside it.

/**
 * The image parts of a pi message, in the shape a `ChatRow` carries.
 *
 * Returns undefined (not []) when there are none, so a row for a plain text
 * message serializes without an empty array on every message in every turn.
 *
 * A part with no `data` is dropped rather than stored empty: an attachment row
 * whose bytes are zero-length renders as a broken image forever, which is worse
 * than the message simply not claiming to have one.
 */
export function imagesOf(content) {
  if (!Array.isArray(content)) return undefined;
  const imgs: Array<{ mimeType: string; data: string }> = [];
  for (const c of content) {
    if (!c || c.type !== 'image') continue;
    if (typeof c.data !== 'string' || !c.data) continue;
    imgs.push({ mimeType: String(c.mimeType || 'application/octet-stream'), data: c.data });
  }
  return imgs.length ? imgs : undefined;
}
