// Saving a file the user sent over Telegram.
//
// Everything about WHAT the file is — its type, its name on disk, whether it can
// be inlined, the note the agent reads, and the write itself — lives in
// `agent-core/attachmentPolicy.ts`, shared with the desktop composer, which takes
// files from the user the same way. All that is left here is naming the
// directory: which chat's staging dir this one belongs in.

import { chatFilesDir } from '../dataDirs.js';
import { writeAttachment, type MediaKind, type StoredAttachment } from '../../../agent-core/attachmentPolicy.js';

export { MAX_INBOUND_BYTES, composeMessage } from '../../../agent-core/attachmentPolicy.js';
export type { MediaKind } from '../../../agent-core/attachmentPolicy.js';

export type CachedAttachment = StoredAttachment;

/**
 * Write one attachment into the chat's staging dir — outside the git checkout, so
 * nothing reaches the workspace until the agent is asked to put it there.
 *
 * Returns null when bytes claiming to be an image clearly aren't.
 */
export async function cacheAttachment(
  chatId: string,
  data: Buffer,
  opts: { filename?: string; mimeType?: string; defaultKind?: MediaKind } = {},
): Promise<CachedAttachment | null> {
  return writeAttachment(chatFilesDir(chatId), data, opts);
}
