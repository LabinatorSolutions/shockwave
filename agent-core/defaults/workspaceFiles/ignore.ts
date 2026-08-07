// .ignore — paths the agent's search tools skip.
//
// A ripgrep convention, not a git file, and the only lever we have from outside
// pi: pi's `grep` tool spawns ripgrep with a hardcoded `--hidden`
// (`createGrepToolDefinition` in pi-coding-agent), which makes it descend into
// `.git/`. A workspace-wide search then returns binary blobs out of
// `.git/objects` — burning context and skewing every file count.
//
// ripgrep honors `.ignore` independently of `.gitignore`, which is why this is a
// second file rather than a line in that one, and why it is the standard
// convention rather than a workaround bolted into our code.

export const IGNORE_FILENAME = '.ignore';

export const DEFAULT_IGNORE = `# Search-tool ignores (ripgrep). Not a git file.
# The agent's grep searches hidden paths, so exclude git internals.
.git/
`;
