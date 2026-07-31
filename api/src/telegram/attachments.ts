// Saving a file the user sent. Everything about WHAT the file is — its type, its
// name on disk, whether it can be inlined, and the note the agent reads — lives
// in the pure `attachmentPolicy.js` beside this. All that is left here is the
// write itself, and the containment check that goes with it.

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { chatFilesDir } from '../dataDirs.js';
import { describeAttachment } from './attachmentPolicy.js';

export { MAX_INBOUND_BYTES, composeMessage } from './attachmentPolicy.js';

export type MediaKind = 'image' | 'video' | 'audio' | 'document';

export interface CachedAttachment {
  /** Absolute path in the chat's staging dir. */
  path: string;
  mimeType: string;
  kind: MediaKind;
  /** Human-readable name for the note — the original filename where we have one. */
  displayName: string;
  /** Contents, for small text files. The note says so when this is set. */
  inlineText?: string;
}

/**
 * Write one attachment into the chat's staging dir — outside the git checkout, so
 * nothing reaches the workspace until the agent is asked to put it there.
 *
 * Returns null when bytes claiming to be an image clearly aren't; see
 * `describeAttachment` for why every other type is accepted.
 */
export async function cacheAttachment(
  chatId: string,
  data: Buffer,
  opts: { filename?: string; mimeType?: string; defaultKind?: MediaKind } = {},
): Promise<CachedAttachment | null> {
  const described = describeAttachment(data, { ...opts, unique: crypto.randomBytes(6).toString('hex') });
  if (!described) return null;

  const dir = chatFilesDir(chatId);
  await fs.mkdir(dir, { recursive: true });
  const target = path.join(dir, described.fileName);

  // `safeName` already stripped path separators, so this can only trip if that
  // changes — which is exactly when you want to find out. It is the check that
  // keeps a crafted filename inside the staging dir.
  if (path.resolve(target) !== path.join(path.resolve(dir), path.basename(target))) {
    throw new Error('rejected attachment filename');
  }

  await fs.writeFile(target, data);

  return {
    path: target,
    mimeType: described.mimeType,
    kind: described.kind as MediaKind,
    displayName: described.displayName,
    ...(described.inlineText !== undefined ? { inlineText: described.inlineText } : {}),
  };
}
