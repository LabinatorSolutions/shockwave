// .gitignore — paths git should not track.
//
// Deliberately minimal: this is a markdown workspace, and syncing everything is
// the point, so only OS droppings are excluded.
//
// Notably NOT `.shockwave/`. That folder carries `workspace.json` (bookmarks,
// daily-note and template config, per-workspace built-in-skill toggles) and the
// workspace's own skills — all of which SHOULD travel between machines.
//
// This is also the sharpest reason scaffolding never runs on clone or adopt:
// adding a `.gitignore` changes git's behaviour for every collaborator on a repo
// the user may not own.

export const GITIGNORE_FILENAME = '.gitignore';

export const DEFAULT_GITIGNORE = `.DS_Store
._*
Thumbs.db
`;
