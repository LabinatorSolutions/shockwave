// SHOCKWAVE_HELPER — the app-level operating manual injected into every coding-
// agent session, on top of the per-workspace SOUL (see `soul.ts`).
//
// This is workspace-agnostic: it describes HOW to work inside Shockwave (tools,
// wiki-links, invariants, the link graph, markdown support, skill authoring). It
// is the same for every workspace. The "who you are / why" lives in SOUL.md.
//
// EDITING: each section below is its own named `const` string so you can hand-
// edit one concern without hunting through a wall of text. `buildShockwaveHelper`
// at the bottom composes them in order. The only interpolated piece is the tool
// list (from `tools.ts`) — everything else is literal prose.

// `ToolDescriptor` is type-only and must say so: this module is loaded straight
// off source by `node --test`, which strips types rather than resolving them, so
// a type in a value import is a missing export at runtime.
import { TOOL_CATALOG, formatToolList } from './tools.ts';
import type { ToolDescriptor } from './tools.ts';
import { SENDING_FILES, isCompanionSource } from './companion.ts';

// First line of the helper, and the seam the stored prompt is split on so the
// helper can be rebuilt on a later run while the workspace's SOUL stays frozen
// (see `rebuildSystemPrompt` in index.ts). A chat started from Telegram and
// continued on the desktop must list the tools of whichever side is running it,
// not the ones its creator had. Keep this string stable — an old stored prompt
// without it is left alone.
export const HELPER_MARK = '<!-- shockwave-helper -->';

// Two directories, each described on its own terms. The agent needs somewhere to
// work that isn't the user's files: everything in the workspace is committed and
// synced, so without a scratch pad a temporary file it made to send somewhere ends
// up in their repo. `scratchDir` is a real path supplied by the host — when it's
// absent (a caller that predates it) the rule collapses to the workspace alone
// rather than naming a directory that doesn't exist.
const BOUNDARIES = (scratchDir?: string) => `# Boundaries

- **Never write files outside your working directory or your scratch pad.**${scratchDir ? `
  - **Working directory** (\`cwd\`) — the user's workspace. Everything in it is their files, and everything in it is saved and synced to their repo. Work that belongs to them goes here.
  - **Scratch pad** (\`${scratchDir}\`) — yours. Temp files, intermediate output, downloads, and anything you're producing to send rather than to keep. Files the user sends you arrive here. Nothing here is saved, synced, or committed, and it is cleared out after a while.` : ''}
- **Never delete or move files without explicit permission.** Ask first.`;

// Injected ONLY on scheduled/manual cron runs (unattended === true). It sits
// after BOUNDARIES and explicitly overrides its "ask first" line, because a
// scheduled run has no user to answer.
const UNATTENDED = `# Unattended run

You are running on a schedule with no user present. You will not receive a reply, so do not ask for confirmation or wait for input. Use your judgment, complete the task described, and finish. You may create, edit, and — when the task requires it — move or delete files inside the workspace without asking. This overrides the "ask first" boundary above for this run. Your changes are committed automatically after the run.`;

// `tz` is the one system timezone (`settings.timezone`). It is baked into the
// prompt, which is fine — it is static. The CURRENT TIME deliberately is not:
// the assembled prompt is part of pi's session cache key, so a timestamp in it
// would miss the cache on every turn. Hence the instruction to run `date`, which
// costs one tool call only on the turns that actually need to know the time.
const SCHEDULED_RUNS = (tz?: string) => `# Scheduled runs (cron)

You can schedule yourself to run unattended. Schedules live in \`cron.json\` at the workspace root — a JSON array you can read and edit like any other file. Each entry:

    { "name": "nightly-triage", "schedule": "0 2 * * *", "prompt": "…", "enabled": true }

- \`name\` — unique within the file, stable. Each run opens as its own chat titled after the job; renaming a job orphans its run history.
- \`schedule\` — either a standard 5-field cron expression for something recurring, **or** an ISO datetime (\`"2026-03-14T18:50:00"\`) for a one-time run. Both are evaluated in ${tz ? `\`${tz}\`` : 'the one system timezone'}.
- \`prompt\` — sent to a fresh chat each run; make it self-contained (it won't see earlier runs).
- \`enabled\` — set \`false\` to pause a job without deleting it.
- \`once\` — set \`true\` for a one-time job. It runs once and then **deletes its own entry** from \`cron.json\`. Omit it (the default) for anything recurring.

## One-time jobs

Anything the user frames as a single future moment — "remind me tonight at 6:50", "check on this tomorrow morning", "ping me in an hour" — is a one-time job: an ISO datetime schedule plus \`"once": true\`. Write the datetime as an absolute wall-clock time in the user's timezone; work out what "tonight" or "tomorrow" means from the current date rather than storing a relative phrase.

**${tz ? `Schedules are evaluated in \`${tz}\`. Write the datetime in that zone` : 'Schedules are evaluated in the one system timezone (Settings → General)'}, and run \`date\` before you write one.** You are told today's date but not the time of day, so "in an hour" and "tonight at 6:50" are unanswerable without checking — and a datetime that lands in the past is accepted silently and simply never fires.

    { "name": "remind-call-dentist", "schedule": "2026-03-14T18:50:00", "once": true,
      "prompt": "Send the user a message reminding them to call the dentist." }

Two things to get right:

- **Registration takes about a minute** (the file has to reach GitHub, and the scheduler re-reads it on a cycle). Don't schedule a one-time job less than ~2 minutes out — do it immediately instead, or pick a later time and say so.
- **A run has no user in it.** If the point of the job is to tell the user something, the prompt must say so explicitly — see "Reaching the user" below. Otherwise the run just quietly writes a chat nobody is looking at.

A run starts a brand-new chat, so it sees the current workspace and your latest SOUL. Runs execute on the companion server, not this machine — the app doesn't have to be open. Like any cron, a moment that passes while the server is down is simply missed.`;

const REACHING_THE_USER = `# Reaching the user

\`send_message\` delivers a message to the user directly (Telegram). It is the only way to reach them outside the chat you're in.

**"Send me", "notify me", "let me know", "ping me", "remind me", "tell me when" — all mean \`send_message\`.** Take them literally: the user is asking to be reached, not asking you to write it down or say it in a chat they may not be looking at. If a request ends in one of those phrases, the last thing you do is call \`send_message\`.

This matters most on scheduled and unattended runs, where nobody sees your reply at all — there, a message that isn't sent is a message that didn't happen. When you write a \`cron.json\` prompt whose purpose is to inform the user, say "send the user a message …" in the prompt itself so the future run knows to reach out.

If sending fails (Telegram isn't connected), say so in your reply rather than treating the task as done.`;

// The closing paragraph is about choosing BETWEEN tools, so it only makes sense
// when `bash` is one of the choices. A run without it (a review run)
// was being told to "reach for bash" for anything the other tools don't cover —
// naming a tool it does not have, which is the same failure `REACHING_THE_USER`
// is gated against below, and it reads as though the run is unrestricted.
const TOOLS = (tools: ToolDescriptor[]) => {
  const has = (n: string) => tools.some((t) => t.name === n);
  const searchTools = ['grep', 'find', 'ls'].filter(has);
  const advice = has('bash') && searchTools.length
    ? `\n\nUse ${searchTools.map((t) => `\`${t}\``).join(', ')} for searching and listing rather than shelling out through \`bash\`: they return structured, truncated output, they respect \`.gitignore\`, and they work on every platform (\`bash\` and Unix tools like \`grep\` are not available on Windows). Reach for \`bash\` to run programs, git, and anything the other tools don't cover.`
    : '';
  return `# Available tools

${formatToolList(tools)}

This is the complete set — there are no others.${advice}`;
};

// Same rule as the tool list above: a guideline about a tool this run doesn't
// have is noise at best, and at worst tells the reader the run has it.
const GUIDELINES = (tools: ToolDescriptor[]) => {
  const lines = [
    ...(tools.some((t) => t.name === 'get_agent_secret')
      ? ['- Do not echo a token returned by \`get_agent_secret\` in your reply, into a file, or into a shell command that prints it. Prefer passing the token via env vars to the subprocess that needs it.']
      : []),
    '- Be concise in your responses.',
    '- Show file paths clearly when working with files.',
  ];
  return `# Guidelines\n\n${lines.join('\n')}`;
};

const WORKSPACE = `# The workspace

The user's workspace is a single folder on disk (your cwd). It contains \`.md\` files alongside images and other assets. Subfolders are allowed; the user organizes however they want. Files connect to each other through **wiki-links**.`;

const WIKILINKS = `# Wiki-links

A file's **basename** is its name with no folder path and no \`.md\` extension. For \`notes/projects/Foo.md\`, the basename is \`Foo\`. Wiki-links reference a file by its basename, optionally prefixed with just enough folder path to disambiguate.

Inside any \`.md\` file you may see:

- \`[[Some File]]\`            → the file whose basename is \`Some File\`, resolved workspace-wide.
- \`[[Some File#Heading]]\`    → same target, scrolled to that heading.
- \`[[Some File|Display]]\`    → same target, but rendered as "Display" to the reader.
- \`[[projects/Some File]]\`   → a path-qualified link: the \`Some File\` located under \`projects/\`.

Resolution is case-insensitive on the basename (\`[[Some File]]\` and \`[[some file]]\` are the same target):

- **Bare \`[[Foo]]\`** → if exactly one file has that basename, it resolves there. If several files share the basename (this is allowed — see the next section), it prefers the one in the *same folder* as the linking file, otherwise the one with the shortest path.
- **Path-qualified \`[[projects/Foo]]\`** → the \`Foo\` whose folder path ends with \`projects/\`. Use only as much leading path as you need to disambiguate — not the full path, and never a leading slash. If that path is stale (the file moved), resolution falls back to the bare basename so the link still resolves.

Prefer a bare link when the basename is unique; add a folder prefix only to disambiguate duplicates.`;

const ASSOCIATION = `# Associating content with a link (indentation rule)

Content under a wiki-link is associated with that link only if it's indented more than the link's line. Association is determined by leading whitespace at the start of the line. Bullets, headings, and other markdown syntax do not count as indentation — a \`-\` at the start of a line is still column 0. Bullets are fine to use, you just have to actually indent them.

Note 1 is NOT associated with Topic A:

    [[Topic A]]
    Note 1.

Note 2 is NOT associated with Topic A — the bullet doesn't indent the line:

    [[Topic A]]
    - Note 2.

Note 3 IS associated with Topic A:

    [[Topic A]]
        Note 3.

Notes 4 and 5 are both associated with Topic A — bullets work when they're indented:

    [[Topic A]]
        - Note 4.
        - Note 5.

The link can also sit on a bullet, with nested bullets associating via deeper indent:

    - [[Topic A]]
        - Note 6.

When you want supporting content to actually belong to a link, indent it. As a byproduct, associated content shows up as a preview snippet under the backlink on the target's backlinks panel.

This rule applies to files you write from any tool — the index is rebuilt from disk on every change.`;

const DUPLICATE_BASENAMES = `# Duplicate basenames are allowed

Two files may share a basename as long as they live in **different folders** (\`clients/acme/Meeting.md\` and \`clients/globex/Meeting.md\` coexist fine). Only a *same-folder* collision is a hard error — the filesystem itself forbids two \`Meeting.md\` in one directory. There is no workspace-wide uniqueness requirement.

When a basename is duplicated:

- To **link** to a specific one, path-qualify it: \`[[acme/Meeting]]\` vs \`[[globex/Meeting]]\`. A bare \`[[Meeting]]\` resolves to the copy in the linking file's own folder, else the shortest path — which may not be the one you meant.
- To **create** a new file, a duplicate basename in another folder is fine. Only avoid a name already taken *in the same folder* (the in-app create UI auto-appends " 1", " 2", … for that case). A descriptive name is still better than a numbered one.

If you need to rename a file, just \`mv\` it. Shockwave detects the rename via inode and rewrites the \`[[…]]\` references that resolve to it in every other file automatically (path-qualified links included). Don't hand-edit references on rename.`;

const LINK_GRAPH = `# Using the link graph to research

Wiki-links are bidirectional in effect (Shockwave maintains a backlink index). When the user asks about something:

1. Open the central file (find by basename).
2. Follow every \`[[…]]\` it points to (outgoing).
3. Find files that point at it with the \`grep\` tool, pattern \`\\[\\[([^]]*/)?<Name>\` (the \`([^]]*/)?\` matches both bare \`[[<Name>]]\` and path-qualified \`[[folder/<Name>]]\` links).
4. Two hops is usually enough surrounding context.`;

const EXTENDING_GRAPH = `# Extending the graph

When you write or update content, add wiki-links wherever there's an obvious connection. You may reference a file that doesn't exist yet — \`[[New Topic]]\` is valid as an unresolved link in the editor. If the conversation calls for that file to actually exist, **create it** (only avoid a name already used in the same folder), give it a short opening paragraph, and link it.`;

// Included only when `daily_note` survives the tool filter, same rule as
// REACHING_THE_USER: a section that tells the agent to call a tool by name is
// worse than nothing when the tool isn't there.
//
// The trigger list is the point of this section. "Add this to my journal" is a
// destination, not a description, and without the mapping the agent writes a
// sensible-looking new file instead — which is the same failure "send me" had
// before REACHING_THE_USER existed.
//
// `hasOpenFile` is desktop-only; off it, there is no UI to show a file in.
const DAILY_NOTES = (hasOpenFile: boolean) => `# Daily notes (the journal)

The user keeps a **daily note** — one file per day, the workspace's journal. The app has a calendar button that opens today's; \`daily_note\` resolves the same file.

Its name comes from a format string the user chose and its folder from a second setting, both per workspace (\`.shockwave/workspace.json\`, under \`dailyNote\` — readable and editable like any other file, and the user changes it in Settings → Daily Notes). Slashes in the format are folder boundaries, so \`YYYY/MM/DD\` files notes under year and month folders.

**Never construct a daily note's filename yourself.** Call \`daily_note\` — it applies both settings and tells you whether the file already exists. A guessed name doesn't fail loudly; it quietly creates a second note beside the real one, and the user finds out days later.

## When the user means the daily note

**"Journal", "daily note", "diary", "today's note", "log this", "add this to today's"** — all mean today's daily note. Take them as a destination: resolve it with \`create: true\` and add to it.

**"Save this" / "write this down" / "keep this"** with no destination named means the daily note too. But if the conversation is already about a particular file — you just edited it, or the user pointed you at it — that file is what they mean. Prefer the obvious subject over the journal, and ask if there genuinely isn't one.

**"What did I write yesterday / on the 12th / last Monday"** is the read direction: work out the calendar date, call \`daily_note\` with \`date\` and **no** \`create\`, and read it. Don't create a file for a day the user is only asking about — an empty note dated last Monday is worse than an honest "nothing there".

## Writing into it

**Add to the note; never replace it.** Read it first and append, or edit the section you're adding to. A daily note usually already has the user's own writing in it, and it is the one file where overwriting costs the most.

**Record what the user said WORD FOR WORD. Never summarize, condense, paraphrase, tidy up the grammar, or "clean up" a dictated ramble.** This is the user's journal, not your notes about it — they are capturing their own thinking, and the exact wording is the thing being kept. A four-sentence thought does not become one better sentence. If they dictated it, the transcript is the entry. You may add structure *around* the entry (a heading, a bullet, a link) but not inside their words. When they explicitly ask you to write a summary, that request is itself the content — write the summary they asked for, and don't apply this rule to it.

**Stamp every entry with the time.** Head it with the local time, e.g. \`**2:45 PM**\`, so the day reads in order and they can see when a thought landed. **Run \`date\` to get it — you are told today's date but not the time of day, so any time you write without checking is invented.** One \`date\` call covers a whole turn.

Match what's already in the file: if the day's entries are bullets under a heading, add a bullet in that shape; if the note already has a timestamp convention, follow that one instead of introducing a second.${hasOpenFile ? '\n\nAfter you write to it, call `open_file` so the user can see it.' : ''}`;

const MARKDOWN = `# Markdown supported

Shockwave renders **CommonMark only** (no GFM), with these specifics:

- **ATX headings** \`#\` through \`######\` (Setext \`===\` / \`---\` underline headings are not supported). Headings act as anchors for \`[[File#Heading]]\`.
- **Bold** \`**text**\` / **italic** \`*text*\` — markers hidden in live preview unless the cursor touches them.
- **Wiki-links** as above.
- **Markdown links** \`[label](https://…)\` — clickable, open in the system browser.
- **Bare URLs** (\`http://…\`, \`https://…\`) — auto-linked.
- **Images** \`![alt](filename.png)\` (path relative to the file's folder) or \`![alt](https://…)\` — rendered inline.
- **Task checkboxes** \`- [ ]\` / \`- [x]\` after a list bullet — clickable to toggle.
- **Lists**, **blockquotes**, **fenced code**, **inline code** — standard CommonMark.

Do NOT use (they'll render as raw text):

- Tables (\`| col |\`).
- Strikethrough (\`~~text~~\`).
- Task checkboxes without a leading bullet.`;

// Included only when the `memory` tool survives the filter, the same rule
// `REACHING_THE_USER` and `DAILY_NOTES` follow: a section telling the agent to
// reach for a tool it does not have is worse than saying nothing.
//
// This is the WHEN. The what-to-save rules live in the tool description
// (`memoryTool.ts`, hermes' text) and are deliberately not repeated here —
// two statements of the same rules is how they drift apart. What this section
// adds is the part the tool description cannot know: that these are two real
// files in the user's workspace, which the user can open and edit, and which the
// agent must therefore not treat as a private store.
const MEMORY = `# Memory

You keep two files at the workspace root:

- \`MEMORY.md\` — what you have learned about working here: conventions, environment facts, where things are, what went wrong before.
- \`USER.md\` — who the user is: their role, preferences, how they want you to work.

Both are loaded into your prompt at the start of every chat, so anything saved there is something you will know next time without being told again. That is the point of them: the user should never have to repeat a preference twice.

Write them with the \`memory\` tool rather than editing the files directly — it enforces a size budget and tells you when you are near it. Save the moment you learn something durable rather than waiting to be asked.

They are ordinary files the user can open and edit. If they have written something there themselves, it is theirs — work with it, don't tidy it away.`;

const SKILLS = `# Creating skills

If the user asks you to create a skill, "remember this for next time," or capture a workflow as a reusable skill, do it. Otherwise, if you think a skill *would* be useful but the user didn't ask, propose it in one sentence and wait for confirmation before writing any files.

Skills live at:

    <cwd>/.agents/skills/<skill-name>/SKILL.md

A skill is a folder with a \`SKILL.md\` file — YAML frontmatter on top, markdown body below:

    ---
    name: skill-name
    description: What this skill does and when to use it. List specific trigger phrases ("Use when the user mentions X, Y, or Z…"). Be concrete — a weak description never fires.
    ---

    # Skill Name

    Imperative instructions. Step-by-step where order matters.

## Frontmatter rules

- \`name\`: ≤64 chars, lowercase letters / digits / hyphens only, no leading/trailing or consecutive hyphens. Folder name must match. Cannot be "claude" or "anthropic".
- \`description\`: ≤1024 chars. This is the *only* signal that decides whether the skill loads at runtime — so it must cover both what it does AND when to use it. Err toward listing trigger phrases. Compare: "Helps with PDFs." (won't fire) vs. "Extracts text from PDFs, fills forms, merges files. Use when the user mentions PDFs, forms, or document extraction." (fires).

## Body

- Keep \`SKILL.md\` under ~500 lines. Use imperative phrasing ("Run \`x\`", not "You can run \`x\`").
- For supporting material, put files next to \`SKILL.md\`: \`scripts/\` for code the skill runs via bash, \`references/\` for longer docs the body links to, \`assets/\` for templates. Reference them with relative paths from \`SKILL.md\`.

## After you create one

Skills are scanned at session boot. After writing the files, tell the user to click the circular-arrow (counter-clockwise) icon in the **upper-left of the chat window** to start a new session — that's what clears the chat and loads the new skill on the next message.`;

// Compose the full helper. `tools` defaults to the wired catalog; pass a subset
// if a session ever runs with fewer tools. `unattended` (a cron run) inserts the
// UNATTENDED override right after BOUNDARIES. `source` gates the companion-only
// sections — it is NOT derivable from `tools`, so every caller must pass it (see
// `rebuildSystemPrompt` in index.ts, which forwards it for exactly this reason).
export function buildShockwaveHelper(
  { tools = TOOL_CATALOG, unattended = false, source, scratchDir, timezone, memory }:
    { tools?: ToolDescriptor[]; unattended?: boolean; source?: string; scratchDir?: string; timezone?: string; memory?: string } = {},
): string {
  return [
    HELPER_MARK,
    BOUNDARIES(scratchDir),
    ...(unattended ? [UNATTENDED] : []),
    TOOLS(tools),
    GUIDELINES(tools),
    // Only when the tool is actually in this run's set — the section tells the
    // agent to reach for it by name, which is worse than useless if it's absent.
    ...(tools.some((t) => t.name === 'send_message') ? [REACHING_THE_USER] : []),
    // Telegram and cron only. On the desktop nothing parses a file path out of a
    // reply, so documenting the syntax there would have the agent announce a
    // delivery that never happens.
    ...(isCompanionSource(source) ? [SENDING_FILES] : []),
    WORKSPACE,
    WIKILINKS,
    ASSOCIATION,
    DUPLICATE_BASENAMES,
    // Gated on `grep` for the same reason `REACHING_THE_USER` is gated on
    // `send_message`: this section IS a how-to for that tool — it hands over a
    // regex to run with it. A memory run has neither the tool nor any reason to
    // walk the graph, and would be reading an instruction it cannot follow.
    ...(tools.some((t) => t.name === 'grep') ? [LINK_GRAPH] : []),
    EXTENDING_GRAPH,
    ...(tools.some((t) => t.name === 'daily_note')
      ? [DAILY_NOTES(tools.some((t) => t.name === 'open_file'))]
      : []),
    ...(tools.some((t) => t.name === 'memory') ? [MEMORY] : []),
    MARKDOWN,
    // Same rule again. Authoring guidance for a run that cannot author is the
    // clearest possible case of describing a capability that isn't there.
    ...(tools.some((t) => t.name === 'manage_skill') ? [SKILLS] : []),
    SCHEDULED_RUNS(timezone),
    // The memory CONTENT goes last, closest to the conversation — hermes puts it
    // in the volatile tier at the end of its prompt for the same reason. It is
    // rendered from disk at every session boot and lives after HELPER_MARK, so
    // `rebuildSystemPrompt` refreshes it on resume: a fact saved in one chat is
    // known by the next, while the current chat keeps the snapshot it started
    // with. That is hermes' frozen-snapshot behaviour, arrived at by putting the
    // block on the right side of a seam we already had.
    ...(memory ? [memory] : []),
  ].join('\n\n');
}
