// SHOCKWAVE_HELPER — the app-level operating manual injected into every coding-
// agent session, on top of the per-workspace SOUL (see `workspaceFiles/soul.ts`).
//
// This is workspace-agnostic: it describes HOW to work inside Shockwave (tools,
// wiki-links, invariants, the link graph, markdown support, skill authoring). It
// is the same for every workspace. The "who you are / why" lives in SOUL.md.
//
// EDITING: each section below is its own named `const` string so you can hand-
// edit one concern without hunting through a wall of text. `buildShockwaveHelper`
// at the bottom composes them in order. Almost all of it is literal prose — the
// only interpolated values are the scratch-pad path and the workspace's template
// list. It does NOT restate what any tool does; see the block above GUIDELINES.

// `ToolDescriptor` is type-only and must say so: this module is loaded straight
// off source by `node --test`, which strips types rather than resolving them, so
// a type in a value import is a missing export at runtime.
import { TOOL_CATALOG } from './tools.ts';
import type { ToolDescriptor } from './tools.ts';
import { SENDING_FILES, isCompanionSource } from './companion.ts';

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

// ── `SCHEDULED_RUNS` moved into the `cron` tool ────────────────────────────
//
// It was 2,608 chars and the largest section in this file: the cron.json schema,
// the field list, cron-vs-datetime syntax, one-time jobs, the ~1 minute
// registration delay, and the warning that a run has no user in it. All of it is
// needed only while writing a schedule, and none of it was enforced — the prompt
// warned that a past datetime "is accepted silently and simply never fires",
// which is the tell: prose was standing in for a check.
//
// It is now `agent-core/cronTool.ts`, where the rules are enforced rather than
// described, and where an edit reaches chats that already exist. The timezone
// interpolation went with it: `process.env.TZ` is set from the same setting in
// every host, so `date` already answers in the user's zone and the tool names it
// per call.
//
// Same rule as `REACHING_THE_USER`, `DAILY_NOTES` and `# Creating skills` below:
// what a single tool is for belongs with that tool.

// ── `REACHING_THE_USER` moved into the tool, not deleted ────────────────────
//
// It was 909 chars explaining what `send_message` is for: that it is the only
// way to reach the user outside the current chat, that "send me / notify me /
// ping me / remind me / tell me when" all mean CALL IT rather than write it
// down, and that on an unattended run a message not sent is a message that did
// not happen. Every word of that is about one tool, so it now lives in that
// tool's description (`agent-core/sendMessage.ts`), where the model reads it at
// the call site and where an edit reaches chats that already exist — this file
// is frozen into a chat when the chat is created and cannot be revised for it.
//
// Nothing was dropped except one sentence that was never about this tool: the
// advice to write "send the user a message …" into a `cron.json` prompt. That
// belongs to writing cron jobs, and the `cron` tool's description says it.

// ── There is no "Available tools" section, and adding one back is a regression ─
//
// There was one. It listed every catalog entry with a one-line description of
// our own and closed with "This is the complete set — there are no others."
//
// The model already has that list. Every tool pi runs — its own builtins and the
// ones we register as `customTools` — is sent to the provider as a tool
// definition carrying its name, its full description and its parameter schema.
// A prose list beside it is a SECOND copy of facts that already arrive, and the
// two are maintained by different hands: ours was a sentence per tool, pi's
// `grep` description carries the truncation limits and every argument.
//
// It had already drifted, which is what settled it. The catalog's `send_message`
// line documented an `output` argument — text / voice / both — for months after
// the tool stopped accepting one, so on every Telegram chat the prompt taught an
// argument the schema rejected. Nothing failed; the model simply read one thing
// and could only do another.
//
// hermes reached the same place: it never enumerates its tools, and where it
// writes about them it points AT the schema ("the `kanban_*` tools in your
// schema") rather than restating it.
//
// What did NOT survive in the tool definitions is the advice about choosing
// BETWEEN tools, which is ours and appears in no vendor's description — pi's own
// `bash` snippet actually recommends the opposite ("Execute bash commands (ls,
// grep, find, etc.)"). That moved into GUIDELINES below, where the rest of our
// cross-cutting rules already live.

// ── `# Guidelines` is gone. It was three unrelated rules in one box ────────
//
// Secret handling, which tool to search with, and how to format a reply have
// nothing in common — "Guidelines" was where a rule went when it fitted nowhere
// else, which is how it collected a fourth ("Be concise in your responses") that
// DEFAULT_SOUL already said in the one file a workspace can edit.
//
// Two of the three became real sections below. The third — "Show file paths
// clearly when working with files" — is a formatting preference like the
// concision line, and went with it.
//
// It also carried three gates that could never be false, because
// `assembleSystemPrompt` always passes the whole catalog: has(`get_agent_secret`),
// has(`bash`) plus a search tool, and which of grep/find/ls to name. Meanwhile
// the one statement that genuinely varied — that bash and the Unix tools are
// missing on Windows — was NOT gated, so it printed on every Mac, and on every
// Telegram and cron run, which are Linux and can never be Windows. Gating the
// wrong things and not the one thing that varies is the shape worth remembering.

const SECRETS = `# Secrets

Never echo a token from \`get_agent_secret\`. Pass it as an env var.`;

// ── The platform, and why it carries a warning ─────────────────────────────
//
// Read from `process.platform` WHERE THE CHAT IS CREATED — the user's machine on
// the desktop, always Linux on the companion. The prompt is then frozen for the
// life of that chat.
//
// So this line can become wrong rather than merely stale: a chat started on a
// Mac and later continued from Telegram runs on Linux, still holding "started on
// macOS". Hence "could change later; check if it matters" — the agent is told the
// value is a starting point rather than a fact about the machine it is on right
// now. What it must NOT do is plan for a move that will usually never happen.
//
// `bash` on Windows is the reason any of this is here: pi's `bash` tool shells
// out, and Windows has neither it nor the Unix tools, so a command that works
// everywhere else fails there with nothing in the prompt to explain why.
const OPERATING_SYSTEM = (platform: string) => {
  const win = platform === 'win32';
  const name = win ? 'Windows' : platform === 'darwin' ? 'macOS' : 'Linux';
  return `# Operating system

Chat started on **${name}** — ${win ? 'no \`bash\`, no Unix tools' : '\`bash\` and Unix tools available'}. Could change later; check if it matters.

Use \`grep\`, \`find\`, \`ls\` for searching${win ? '. Shell commands must be Windows.' : ', not \`bash\`. Use \`bash\` for programs and git.'}`;
};

const WIKILINKS = `# Wiki-links

A file's **basename** is its name with no folder path and no \`.md\` extension — for \`notes/projects/Foo.md\`, the basename is \`Foo\`. Wiki-links reference a file by basename, optionally prefixed with just enough folder path to disambiguate. Resolution is case-insensitive.

- \`[[Some File]]\`            → the file whose basename is \`Some File\`.
- \`[[Some File#Heading]]\`    → same target, scrolled to that heading.
- \`[[Some File|Display]]\`    → same target, rendered as "Display".
- \`[[projects/Some File]]\`   → path-qualified: the \`Some File\` under \`projects/\`.

Two files can share a basename in different folders — creating one is fine. A bare \`[[Meeting]]\` then resolves to the copy in the linking file's own folder, else the shortest path, which may not be the one you meant. Path-qualify to be sure: \`[[acme/Meeting]]\`.

To rename a file, just \`mv\` it. Shockwave detects the rename by inode and rewrites the \`[[…]]\` references that resolve to it in every other file, path-qualified ones included. **Don't hand-edit references on rename.**

Content indented under a link, or a list directly beneath it with no blank line between, is associated with that link and shows as a preview under the backlink.

## Finding what links to a file

To find files linking to \`<Name>\`, \`grep\` for \`\\[\\[([^]]*/)?<Name>\` rather than the plain string \`[[<Name>]]\` — that plain form misses every link written as \`[[<Name>#heading]]\`, \`[[<Name>|alias]]\`, or with a folder prefix, which is most of them.

**Treat the hits as candidates, not answers.** A wiki-link resolves by the linking file's own folder, which no pattern can see, so when several files share this basename some matches belong to one of the others. Check where each hit lives before counting it.

## Adding links as you write

Add wiki-links wherever there's an obvious connection. \`[[New Topic]]\` is valid before the file exists; create it if the conversation calls for it.`;

// `DUPLICATE_BASENAMES` and `ASSOCIATION` were both folded into `WIKILINKS`.
// Three sections, one subject: how a wiki-link behaves. Duplicates stated the
// resolution tiebreaker a second time in slightly different words (the old
// WIKILINKS even ended by pointing at "the next section"), and association is
// the same syntax from the other end — what a link pulls IN rather than where
// it points.
//
// Dropped in the merge: the note that the in-app create UI auto-appends " 1" /
// " 2" on a same-folder collision. That describes what happens when a PERSON
// creates a file and is nothing the agent does or can act on.
//
// ── The association rules changed under the prompt once ────────────────────
//
// That subsection used to say a bullet never counts as indentation ("a `-` at
// the start of a line is still column 0"), with a worked example proving it. It
// has been FALSE since `collectContext` (`src/renderer/linkIndex.ts`) grew its
// second clause: a LIST ITEM at the link's own indent IS associated, provided no
// blank line separates them. The prompt went on teaching the old rule, with an
// example asserting the opposite of what the parser does — so anyone following
// it indented content that needed no indenting, and would have read a
// correctly-associated file as unassociated.
//
// Six examples became three, covering the three ANSWERS rather than restating
// one: the line that does not attach, the list that does, and the blank line
// that breaks it. That last case is the only real gotcha and nothing documented
// it before.
//
// Checked by running the examples through `parseLinks` itself, not by reading
// `collectContext` and reasoning about it (`tests/helperPrompt.test.js`). If
// that function changes again, this text has to change with it — and the same
// rule lives in `src/main/linkParser.ts`, which parity-tests against the
// renderer's copy.

// `LINK_GRAPH` and `EXTENDING_GRAPH` are folded into `WIKILINKS` too — every
// section about links is now that one section, with `##` subheads. Finding what
// points at a file and adding links as you write are both things you do WITH the
// syntax the section already teaches, so splitting them made the reader assemble
// one subject from four headings.
//
// What the finding subsection says is measured, not guessed. A 2026-07-30
// benchmark (synthetic workspaces at 10K/50K/100K files, ground truth from this
// repo's own parser and resolver): the plain string `[[Name]]` finds 22% of real
// backlinks — it misses every `#heading`, `|alias` and folder-prefixed form —
// while the full regex has 100% recall but precision around 1/k, k being the
// number of files sharing that basename (58% at k=2, 1.1% at k=70). The
// precision half is NOT fixable by any regex, because resolution depends on the
// LINKING file's own folder and grep cannot see it. Hence "candidates, not
// answers".
//
// Deleting it outright would be worse than keeping it small: `grep` is a tool
// the agent already has, so with no guidance it reaches for the plain string —
// the 22% option. It goes entirely once an indexed backlinks tool exists (294
// tokens against 55,949, exact).

// ── There is no `DAILY_NOTES` section, and it is not coming back ────────────
//
// It was 3,175 chars — the largest section in the prompt — and most of it was
// one person's journaling method: record verbatim, stamp every entry with the
// time, append rather than replace, match the file's existing convention. That
// is a convention, not app behaviour. Shipping it in the system prompt imposed
// it on every workspace, including the ones that never open a daily note.
//
// The app's actual business here is: resolve the right filename, and don't let
// the agent guess one. Both live in `daily_note`'s own definition
// (`agent-core/dailyNoteTool.ts`) — the description carries "always use this
// instead of guessing a filename … a guess silently creates a second note
// alongside the real one", and the RESULT text carries "read it before writing,
// and add to it rather than replacing what is there" at the exact moment it
// applies. The trigger words are in the description's first line too ("the
// user's daily note (journal / diary)").
//
// A workspace that wants a house style for its journal states it in its own
// `AGENTS.md`, which pi appends to the prompt. That is the surface for
// per-workspace instruction; this file is not.

// The workspace's templates — folder and file list read at chat creation
// (`readTemplates` in templates.ts) and frozen with the prompt, same snapshot
// behaviour as the memory blocks. Skipped entirely when the workspace has none.
//
// The list IS the section. It used to carry three more sentences — what kind of
// file each covers, that you should seed from one, that nothing substitutes
// placeholders so copy it verbatim. A file list plus "check these" says all of
// it: the agent can read a template and see for itself what is in it, and
// "copy it" is what using a template means.
const TEMPLATES = (t: { folder: string; files: string[] }) => `# File Templates

In \`${t.folder}/\`. Check them when creating a new file.

${t.files.map((f) => `- \`${f}\``).join('\n')}`;

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
// A TRIGGER MAPPING, not a description of the tool — `search_chats` already
// describes its three call shapes in its own definition, and that is how to use
// it, not when to reach for it. Same gap `REACHING_THE_USER` and `DAILY_NOTES`
// were written to close, and the same shape of fix: the user names a
// DESTINATION ("what did we decide") and without the mapping the agent answers
// from what's in front of it.
//
// This one fails the most quietly of the three. "Send me" not sending is
// visible; a note landing in the wrong file is visible; an agent that simply
// doesn't remember a conversation you both had reads as normal behaviour.
// `EARLIER_CHATS` lived here for about a day and moved into `search_chats`'s
// own description (`agent-core/chatSearch.ts`). It was written as a section on
// the reasoning that a tool description covers HOW to call a tool and the prompt
// covers WHEN — which turned out to be a distinction without a difference. The
// model reads both, the tool description is the one it reads at the call site,
// and it is the one an edit can still reach for a chat already underway.
//
// Same move as `REACHING_THE_USER` above, and `DAILY_NOTES` and
// `# Creating skills` below. The rule they all follow: what a single tool is FOR
// belongs with that tool. What stays in this file is what no single tool owns.

const MEMORY = `# Memory

You keep two files at the workspace root:

- \`MEMORY.md\` — what you have learned about working here: conventions, environment facts, where things are, what went wrong before.
- \`USER.md\` — who the user is: their role, preferences, how they want you to work.

Both are loaded into your prompt at the start of every chat, so anything saved there is something you will know next time without being told again. That is the point of them: the user should never have to repeat a preference twice.

Write them with the \`memory\` tool rather than editing the files directly — it enforces a size budget and tells you when you are near it. Save the moment you learn something durable rather than waiting to be asked.

They are ordinary files the user can open and edit. If they have written something there themselves, it is theirs — work with it, don't tidy it away.`;

// ── USING skills. hermes' `## Skills (mandatory)` header, copied ────────────
//
// This is the header hermes puts directly above its skill index
// (`build_skills_system_prompt` in `agent/prompt_builder.py`). We had NOTHING
// equivalent: pi appends its own `<available_skills>` list after our prompt,
// introduced by one soft line — "use the read tool to load a skill's file when
// the task matches its description" — and that was the whole instruction.
//
// The gap that closes is the one a capable model creates by itself: it reads
// "code-review skill", concludes it already knows how to review code, skips the
// file, and misses the conventions the skill existed to carry. hermes' answer is
// the last clause — the skill defines how it is done HERE — and that is the
// sentence doing the work.
//
// It matters more here than there: review runs write skills unattended, so we
// spend model time generating skills the agent was barely told to read.
//
// Copied verbatim except where hermes names something we don't have:
//   - `skill_view(name)` → `read`. pi loads a skill with the read tool.
//   - Dropped the paragraph about loading the `hermes-agent` skill for questions
//     about hermes itself. No such skill.
//   - Dropped `<available_skills>` and the index — pi emits its own list, after
//     this, from the paths `skillLibrary.ts` resolves at boot.
const USING_SKILLS = `# Skills (mandatory)

Before replying, scan your available skills (listed below). If a skill matches or is even partially relevant to your task, you MUST load it with \`read\` and follow its instructions. Err on the side of loading — it is always better to have context you don't need than to miss critical steps, pitfalls, or established workflows. Skills contain specialized knowledge — API endpoints, tool-specific commands, and proven workflows that outperform general-purpose approaches. Load the skill even if you think you could handle the task with basic tools.

Skills also encode the user's preferred approach, conventions, and quality standards for tasks like code review, planning, and testing — load them even for tasks you already know how to do, because the skill defines how it should be done here.

If a skill has issues, fix it with \`manage_skill\` (action \`patch\`). If a skill you loaded was missing steps, had wrong commands, or needed pitfalls you discovered, update it before finishing.

Only proceed without loading a skill if genuinely none are relevant to the task.`;

// ── WHEN to save one. hermes' `SKILLS_GUIDANCE`, copied ─────────────────────
//
// hermes carries this in its system prompt; we had the same content only in
// `MANAGE_SKILL_DESCRIPTION`. Mirroring hermes means it lives in both places,
// and the two say the same thing on purpose — this is the trigger, the tool
// description is the how.
//
// Copied verbatim except:
//   - `skill_manage` → `manage_skill`, our name for the same tool.
//   - Dropped hermes' `## Skill Safety Rule` (its four `[SKILL_PRUNED]` points).
//     That is a protocol for recovering skills lost to hermes' context
//     compaction; pi does not prune skills and has no such marker, so the whole
//     block would describe a state that cannot occur.
//
// The offer-and-confirm rule that used to sit in our own version of this is not
// dropped — it moves to `MANAGE_SKILL_DESCRIPTION`, which is where hermes keeps
// it ("After difficult/iterative tasks, offer to save as a skill… Confirm with
// user before creating").
const SAVING_SKILLS = `# Saving what you learn as a skill

After completing a complex task (5+ tool calls), fixing a tricky error, or discovering a non-trivial workflow, save the approach as a skill with \`manage_skill\` so you can reuse it next time.

When using a skill and finding it outdated, incomplete, or wrong, patch it immediately with \`manage_skill\` (action \`patch\`) — don't wait to be asked. Skills that aren't maintained become liabilities.

Skills live at \`<cwd>/.agents/skills/<skill-name>/SKILL.md\`. They are scanned at session boot, so after writing one, tell the user to click the circular-arrow (counter-clockwise) icon in the **upper-left of the chat window** — that clears the chat and loads the new skill on the next message.`;

// Compose the full helper. `tools` defaults to the wired catalog; pass a subset
// if a session ever runs with fewer tools. `unattended` (a cron run) inserts the
// UNATTENDED override right after BOUNDARIES. `source` gates the companion-only
// sections — it is NOT derivable from `tools`, so every caller must pass it (see
// `rebuildSystemPrompt` in index.ts, which forwards it for exactly this reason).
export function buildShockwaveHelper(
  { tools = TOOL_CATALOG, unattended = false, source, scratchDir, memory, templates, platform = process.platform }:
    { tools?: ToolDescriptor[]; unattended?: boolean; source?: string; scratchDir?: string; memory?: string; templates?: { folder: string; files: string[] }; platform?: string } = {},
): string {
  return [
    BOUNDARIES(scratchDir),
    ...(unattended ? [UNATTENDED] : []),
    // No tool list here — the model receives every tool's real definition from
    // pi. See the block above SECRETS for why a prose copy was removed.
    OPERATING_SYSTEM(platform),
    SECRETS,
    // Telegram and cron only. On the desktop nothing parses a file path out of a
    // reply, so documenting the syntax there would have the agent announce a
    // delivery that never happens.
    ...(isCompanionSource(source) ? [SENDING_FILES] : []),
    WIKILINKS,
    // Gated on `grep` for the same reason `REACHING_THE_USER` is gated on
    // `send_message`: this section IS a how-to for that tool — it hands over a
    // regex to run with it. A memory run has neither the tool nor any reason to
    // walk the graph, and would be reading an instruction it cannot follow.
    ...(tools.some((t) => t.name === 'memory') ? [MEMORY] : []),
    // Skipped entirely when the workspace has no templates (folder unset,
    // missing, or holding no .md files) — a heading over nothing reads as an
    // instruction to go looking for it.
    ...(templates && templates.folder && templates.files.length ? [TEMPLATES(templates)] : []),
    MARKDOWN,
    // Same rule again. Authoring guidance for a run that cannot author is the
    // clearest possible case of describing a capability that isn't there.
    // Using skills is gated on `read`, not `manage_skill` — a run that can load
    // a skill should be told to, whether or not it may write one. Saving is
    // gated on the tool that saves.
    ...(tools.some((t) => t.name === 'read') ? [USING_SKILLS] : []),
    ...(tools.some((t) => t.name === 'manage_skill') ? [SAVING_SKILLS] : []),
    // The memory CONTENT goes last, closest to the conversation — hermes puts it
    // in the volatile tier at the end of its prompt for the same reason. It is
    // rendered from disk once, when the chat is created, and frozen with the
    // rest of the prompt: a chat keeps the memory it started with, and the next
    // chat gets whatever is current. That is hermes' frozen-snapshot behaviour,
    // and here it falls out of the prompt being written once rather than needing
    // a seam to regenerate past.
    ...(memory ? [memory] : []),
  ].join('\n\n');
}
