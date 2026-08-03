// The renderer-facing shape of a workspace (see `WorkspaceEntry` in
// src/shared/settings.ts).
//
// ONE projection, and it is the one that runs — `settingsStore.overlayLocal`
// calls it for every workspace on every read. It used to be an inline copy over
// there with this module imported by nothing but its own test: the shape the UI
// actually received was untested, and the tested one was fiction. A field added
// to the wrong copy simply never arrived, which is how `voiceReply` reached the
// settings page as undefined.
//
// A workspace is assembled from TWO sources and this is where they meet:
//   - identity, from the companion — id, name, repo, and the reply mode
//   - machine-local, from userData — where it is checked out here, and whether
//     it syncs on THIS machine
//
// No electron import, so `node --test` can pin the things here that are easy to
// get silently backwards.

/**
 * `syncEnabled` is passed THROUGH, not derived.
 *
 * It used to be `!row.syncDisabled`, from a `sync_disabled` column on the
 * companion (0 or absent = syncing, so a zero row meant normal behaviour). **That
 * column is gone** — the toggle is machine-local now and `getWorkspaceLocal`
 * already answers in the positive — so negating here inverts every Sync switch
 * with nothing failing. Absent still means syncing, which is what a workspace
 * nobody has touched should do.
 *
 * `voiceReply` is normalized rather than trusted: it is plain text on the
 * companion and two things write it (the bot's `/voice`, the settings page), so
 * an unrecognized value must read as the default instead of reaching the UI as a
 * mode nothing renders.
 */
export function projectWorkspaceRow(row) {
  return {
    id: row.id,
    name: row.name,
    path: row.path ?? null,
    repo: `${row.repoOwner}/${row.repoName}`,
    syncEnabled: row.syncEnabled !== false,
    voiceReply: row.voiceReply === 'voice' || row.voiceReply === 'both' ? row.voiceReply : 'text',
  };
}
