=========================================================================
THE SHOCKWAVE SYSTEM PROMPT — map and working list
Current as of 2026-08-06. All sizes are measured from rendered output,
not source-file length: comments in those files never reach the model.
=========================================================================


-------------------------------------------------------------------------
DONE SO FAR
-------------------------------------------------------------------------

Twelve changes, all uncommitted. Reasoning for each is in DECISION LOG below.

  * Deleted "# Available tools" (-2,908 chars)
    The model already gets every tool's real name, description and schema
    from pi. Our prose copy was thinner, and it had drifted — it documented
    a send_message argument that no longer existed.

  * Deleted "# Creating skills" (-1,934 chars)
    hermes keeps file-format guidance in the tool description. We had it in
    both places, contradicting itself on when to create a skill.

  * Deleted "# Daily notes" (-3,175 chars, the largest section)
    Most of it was one workspace's journaling style — capture verbatim,
    timestamp entries, append not replace — imposed on every user including
    those who never open a daily note.

  * Merged "# Duplicate basenames" into "# Wiki-links"
    Two sections answering one question, stating the resolution tiebreaker
    twice in slightly different words.

  * Added "# Skills (mandatory)" (+1,087 chars, copied from hermes)
    We had nothing telling the agent to load its skills — only pi's soft
    "read it when the task matches." Matters here because review runs write
    skills unattended.

  * Added "# Saving what you learn as a skill" (+721 chars, from hermes)

  * Gave search_chats a "when to reach for it" mapping — added as a prompt
    section, then moved into the tool description the same day once the
    pattern below became clear. search_chats was the only tool with no
    trigger guidance anywhere: the agent knew how to call it, nothing told
    it when.

  * Rewrote "# Associating content with a link" (1,221 -> 614 chars)
    It was teaching a rule the parser stopped following. See below — this
    is the most important find of the session.

  * Gutted the link-graph section (983 -> 538 chars), renamed
    "# Finding what links to a file"
    It was a five-step research procedure whose one app-specific step
    instructed a backlink method benchmarked at ~26% correct on duplicated
    basenames, with nothing saying so. Down to the two facts that stop the
    agent doing something worse. Goes entirely once real link tools exist.

  * Deleted "# Reaching the user" (-909 chars), folded into send_message's
    description. Every word of it was about one tool: that it is the only
    way to reach the user outside the current chat, that "send me / notify
    me / ping me / remind me" mean CALL IT, and that on an unattended run a
    message not sent is a message that did not happen.

  * Deleted "# Earlier chats" (-434 chars), folded into search_chats'
    description, for the same reason.

  * Two rules into MEMORY_TOOL_DESCRIPTION, and daily_note's create now
    defaults to true. Both reach EXISTING chats, unlike prompt edits.

  * Fixed "# Speaking out loud"
    Was instructing send_message with output/save arguments the tool rejects.

NET SIZE: desktop helper went 246 -> 146 lines, 19,088 -> 10,751 chars.
That is 44% smaller, with two capabilities the agent was never told about
and two sections that were actively wrong.

GATES: 578/578 tests pass (23 added), both typecheck gates clean, lint 0
errors.


THE PATTERN UNDERNEATH ALL OF IT
--------------------------------

Five sections left this file for a tool description: "# Reaching the user"
-> send_message, "# Earlier chats" -> search_chats, "# Daily notes" ->
daily_note, "# Creating skills" -> manage_skill, and the memory rules ->
the memory tool. One rule explains all five:

    WHAT A SINGLE TOOL IS FOR BELONGS WITH THAT TOOL.

Two reasons, and the second is the structural one. The model reads a tool
description at the call site, right where it is deciding. And the system
prompt is FROZEN INTO A CHAT when that chat is created — a fix there only
reaches chats started afterwards, while a tool description is rebuilt at
every session boot and so lands on conversations already in flight.

What stays in helper.ts is what no single tool owns.

An earlier attempt at a line between them — the tool description covers HOW
to call it, the prompt covers WHEN to reach for it — did not survive
contact. "# Earlier chats" was written that way in the morning and moved
into search_chats by the afternoon. The model reads both; only one of them
is at the call site, and only one of them can still be fixed for a chat
already underway.

The corollary showed up twice as a bug: when the same guidance lives in
both places they drift, and nothing tells you. The tool list documented a
send_message argument that no longer existed. "# Creating skills" told the
agent to propose and wait while the tool description told it to create.

The move has its own failure mode, which is why tests/toolGuidance.test.js
now exists: deleting a section is one edit and adding it to a description
is another, nothing links them, and a later tidy-up that trims a
description back to a list of arguments takes the guidance out of BOTH
places with nothing failing. That file pins the TRIGGERS — the phrases a
user actually says — because those are what make a tool get used at all,
and what a well-meaning edit is most likely to cut as chatty.


-------------------------------------------------------------------------
THE ONE THAT MATTERS MOST — the association rule was false
-------------------------------------------------------------------------

"# Associating content with a link" told the agent that a bullet never
counts as indentation ("a `-` at the start of a line is still column 0"),
and carried a worked example proving it:

    [[Topic A]]
    - Note 2.        <- prompt said NOT associated

That has been false since collectContext (src/renderer/linkIndex.ts:77)
grew a second clause: a list item at the link's own indent IS associated,
as long as no blank line separates them. Verified by running all six of the
prompt's examples through parseLinks — five were right, that one was wrong.

Anyone following the prompt indented content that did not need indenting,
and would have read a correctly-associated file as unassociated.

Two behaviours nothing documented at all: a numbered item (1.) counts the
same as a bullet, and a BLANK LINE ends the association. That blank-line
rule is now the only real gotcha and it was completely absent.

The actual rule, both clauses: content belongs to a link if it is indented
deeper than the link's line, OR it is a list item at the same indent with
no blank line in between.

Six examples became three, covering the three answers rather than restating
one. Three tests now execute those claims against the real parser, so the
section cannot silently go stale again — that was the failure mode, and
prose about another module's behaviour is exactly what rots.


-------------------------------------------------------------------------
NEXT UP — not yet reviewed
-------------------------------------------------------------------------

Nine of seventeen sections have been read on their merits. EVERY ONE turned
up a real problem, so the remaining eight should not be assumed fine.
Largest first, since size is a rough proxy for how much can be wrong.

  unbounded   <project_context> (pi's). Inlines each AGENTS.md whole, no
              truncation. The only piece with no ceiling. Called fine for now.

  2,608       "# Scheduled runs (cron)". Now the largest section we own by a
              wide margin. Includes the one-time-job rules. Parked by
              request.

  1,538       "# Wiki-links". Just merged and trimmed, but not read line by
              line for correctness the way the association rule was.

   940        "# Markdown supported"

   613        "# Boundaries"

   558        "# Guidelines". Gained the bash-vs-search advice; not otherwise
              read.

   508        SOUL (DEFAULT_SOUL). Only applies to workspaces with no SOUL.md
              of their own.

   439        "# Unattended run"

   397        "# Extending the graph"

  ~318        "# Templates"

   260        "# Sending the user a file"

   249        "# The workspace"

CLOSED, NOT DEFERRED: hermes' PARALLEL_TOOL_CALL_GUIDANCE and
TASK_COMPLETION_GUIDANCE. Neither targets a failure seen here.

WORTH KNOWING FOR LATER: a 2026-07-30 benchmark found grep finds backlinks
at 100% recall but precision around 1/k, where k is the number of files
sharing a basename. An indexed lookup was 294 tokens against 55,949. The
fix is a backlinks tool, which does not exist yet; until it does, grep is
all the agent has and the section now says so plainly.


=========================================================================
REFERENCE — the full stack, in order
=========================================================================

HOW IT IS BUILT
---------------

Two layers with different lifetimes.

PART 1 IS OURS. assembleSystemPrompt() (agent-core/defaults/index.ts:66)
runs once, when a chat is created, and the result is stored on the chat
row. Every later boot replays it verbatim (agent-core/agent.ts:392). A chat
with no stored prompt refuses to continue rather than quietly starting
under different instructions.

PART 2 IS PI'S. Re-derived on every session boot, so it does change under a
chat over its life.

assembleSystemPrompt is literally `${soul}\n\n${helper}`.

Because we pass a systemPromptOverride, pi's own built-in prompt is
replaced entirely — its preamble, tool list and guidelines appear nowhere.

THIS IS WHY TOOL DESCRIPTIONS BEAT PROMPT SECTIONS for anything you expect
to tune: the prompt is frozen per chat, tool definitions are rebuilt every
boot. Three of this session's edits went that way for exactly that reason.


PART 1 — OURS, FROZEN AT CHAT CREATION
--------------------------------------

agent-core/defaults/soul.ts

   1. DEFAULT_SOUL (:21) — 7 lines, 508 chars, always present.
      Who you are, why, tone. A workspace's own SOUL.md REPLACES this
      entirely (readSoul, :39) — nothing is merged. It is the first thing
      in the prompt, above every section below, so a clause here can
      override any of them.

agent-core/defaults/helper.ts — composed by buildShockwaveHelper() at :375,
joined with blank lines, in this order:

   2. BOUNDARIES (:28) — 6 lines, 613 chars, always.
      Drops to 4 lines / 162 chars when the host supplies no scratchDir.
   3. UNATTENDED (:38) — 3 lines, 439 chars, unattended runs only.
   4. GUIDELINES (:122) — 6 lines, 558 chars, always.
   5. SENDING_FILES (companion.ts:26) — 3 lines, 260 chars, Telegram/cron.
   6. SPEAKING (companion.ts:43) — 5 lines, 690 chars, Telegram/cron, and
      additionally requires send_message.
   7. WORKSPACE (:138) — 3 lines, 249 chars, always.
   8. WIKILINKS (:142) — 14 lines, 1,538 chars, always.
   9. ASSOCIATION (:177) — 25 lines, 614 chars, always.
  10. LINK_GRAPH (:236) — 5 lines, 538 chars, holds grep.
  11. EXTENDING_GRAPH (:242) — 3 lines, 397 chars, always.
  12. MEMORY (:329) — 12 lines, 866 chars, holds memory.
  13. TEMPLATES (:271) — 6 lines plus one per file, ~318 chars, only when
      the workspace has templates.
  14. MARKDOWN (:279) — 18 lines, 940 chars, always.
  15. USING_SKILLS (:365) — 9 lines, 1,087 chars, holds read.
  16. SAVING_SKILLS (:393) — 7 lines, 721 chars, holds manage_skill.
  17. SCHEDULED_RUNS (:47) — 27 lines, 2,608 chars, always.

agent-core/memoryStore.ts

  18. renderBlock via renderForPrompt (:131, :260) — 3 lines plus content.
      Goes LAST, closest to the conversation. One block per file, MEMORY.md
      then USER.md, each with a bar, a header carrying the usage
      percentage, another bar, then one line per entry. An empty file
      contributes nothing rather than an empty heading. Capped at 2,200 +
      1,375 chars by settings, so ~3,575 max. Rendered at chat creation and
      frozen: a chat keeps the memory it started with.

agent-core/defaults/tools.ts contributes NO PROSE. TOOL_CATALOG (16
entries) is the allowlist handed to pi; DENIED is the per-source refusal
table read at call time. Neither reaches the prompt.


TOTALS FOR PART 1
-----------------

  Desktop chat, no templates, no memory ....... 170 lines, 12,557 chars
  Cron or Telegram run (adds 3, 6, 7) ......... 184 lines, 13,952 chars
  Desktop with 3 templates .................... 180 lines, 12,877 chars
  Plus a full memory block .................... +6 to ~+40 lines,
                                                up to +3,575 chars

(That is the helper plus the 7-line SOUL and the blank line between them.
The helper alone is 162 lines / 12,047 chars on a desktop chat.)


PART 2 — PI'S, RE-DERIVED EVERY BOOT
------------------------------------

node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js,
function buildSystemPrompt, the customPrompt branch, lines 19-41:

  19. appendSystemPrompt (:21) — ZERO. We never pass one. Dead slot.
  20. <project_context> block (:25-32) — 5 lines of scaffolding, 2 per
      file, plus each file's full contents.
  21. Skills list (:35) — about 2 lines per enabled skill.
  22. "Current date: YYYY-MM-DD" (:39) — 1 line, date only, no time.
  23. "Current working directory: <cwd>" (:40) — 1 line.

#20 CAN DWARF EVERYTHING ELSE. It inlines each context file whole,
untruncated. Discovery is loadContextFileFromDir (resource-loader.js:30):
it tries AGENTS.md, AGENTS.MD, CLAUDE.md, CLAUDE.MD per directory, first
hit wins, checking pi's own agentDir and then every ancestor of cwd,
walking root to cwd. Nothing filters CLAUDE.md out — it simply loses to
AGENTS.md in any directory holding both.

#21 IS WHERE "# Skills (mandatory)" POINTS. Our section sits above this
list, the same position hermes puts its header.

#22 IS DATE-ONLY ON PURPOSE. The prompt is part of pi's session cache key,
so a timestamp would miss the cache every turn. That is why SCHEDULED_RUNS
tells the agent to run `date` when it needs the time of day.


ADJACENT — reaches the model, not part of the system prompt
-----------------------------------------------------------

  agent-core/defaults/conversation.ts:41 — backgroundInstruction(), the
  first USER message on a review or memory run.

  agent-core/defaults/reviewPrompt.ts:39 — SKILL_REVIEW_PROMPT.

  agent-core/defaults/memoryPrompt.ts:28 — MEMORY_REVIEW_PROMPT.

  agent-core/memoryTool.ts:34 — MEMORY_TOOL_DESCRIPTION, the what-to-save
  rules.

  agent-core/skillTool.ts:52 — MANAGE_SKILL_DESCRIPTION, all skill
  authoring guidance.

  agent-core/dailyNoteTool.ts:141 — the daily_note description, now the
  only explanation of what a daily note is.

  Every tool's own description — the only place a tool is described.


WHAT ACTUALLY VARIES
--------------------

Most "present when" notes read as conditional but are not. helperFor hands
buildShockwaveHelper the WHOLE TOOL_CATALOG (index.ts:94), so 5, 11, 13,
14, 17 and 18 are always in.

The real variables are only these five:

  1. unattended — section 3
  2. Telegram or cron — sections 6 and 7
  3. workspace has templates — section 15
  4. memory files non-empty — section 20
  5. scratchDir supplied — one bullet inside section 2

The gating machinery still works on a subset and is pinned that way
(tests/helperPrompt.test.js); nothing calls it that way today.


=========================================================================
DECISION LOG
=========================================================================

THE TOOL LIST IS GONE
---------------------

"# Available tools" carried all 16 catalog entries with our own one-line
descriptions, closing with "This is the complete set." 2,908 chars on every
chat.

Removed because pi sends the model every tool's real name, description and
parameter schema as a tool definition. Our copy was thinner — pi's grep
description carries the truncation limits and every argument, ours was a
sentence — and, being separately maintained, it had drifted: the
send_message entry advertised an `output` argument for months after the
tool stopped accepting one. Nothing failed anywhere. hermes never
enumerates its tools either; it points AT the schema.

ToolDescriptor.desc and formatToolList went with it. A tool is now
documented in exactly one place: its own definition.

The one thing not in any tool definition — which tool to prefer when
several would do, since pi's bash snippet pushes the other way ("Execute
bash commands (ls, grep, find, etc.)") — moved to "# Guidelines".


THE ASSOCIATION RULE WAS FALSE
------------------------------

Covered in full above. The short version: the section stated a rule the
parser stopped following, with a worked example proving the wrong thing,
and nobody noticed because nothing checked. Three tests now run the
prompt's own claims through parseLinks.

Worth generalising: this is the only section whose content is a factual
claim about code elsewhere. If another one is added, it needs the same
treatment.


THE LINK-GRAPH SECTION TOLD THE AGENT TO USE A ~26%-CORRECT METHOD
------------------------------------------------------------------

It was a five-step research procedure. Four steps — open the central file,
follow its outgoing links, two hops is usually enough — are ordinary
competent behaviour that needs no instruction. The one step that WAS
specific to this app said to find backlinks by grepping.

A benchmark on 2026-07-30 (synthetic workspaces at 10K/50K/100K files,
ground truth from this repo's own parser and resolver) measured what that
actually gets you. The plain string `[[Name]]` finds 22% of real backlinks
— it misses every #heading, |alias and folder-prefixed form. The full-form
regex has 100% recall but precision around 1/k, where k is the number of
files sharing the basename: 58% at k=2, 1.1% at k=70.

The precision half is NOT FIXABLE BY ANY REGEX — resolution depends on the
LINKING FILE'S OWN FOLDER, which grep cannot see. And the section directly
above now tells the agent duplicate basenames are normal, so the case where
this breaks is one we actively encourage.

Cut to two sentences and renamed "# Finding what links to a file". Deleting
it outright would be worse than keeping it small: grep is a tool the agent
already has, so with no guidance it reaches for the plain string, the 22%
option. What is left buys the 100%-recall pattern and the warning that the
hits are candidates, not answers.

This section goes entirely once real link tools exist. The right fix is an
indexed backlinks lookup — 294 tokens against 55,949, and exact.


SKILLS NOW MIRROR HERMES' LAYER SPLIT
-------------------------------------

hermes puts the load directive and save trigger in the system prompt, and
ALL file-format guidance in the tool description. We had the inverse:
nothing about loading, and 1,934 chars teaching frontmatter.

"# Skills (mandatory)" (1,087 chars) is hermes' index header, copied.
Partial relevance is enough, err toward loading, "load them even for tasks
you already know how to do, because the skill defines how it should be done
here." pi's own line permits exactly the failure this closes: a capable
model deciding it already knows how, skipping the file, missing the
conventions. Deviations: skill_view(name) became read; dropped the
hermes-agent-skill paragraph.

"# Saving what you learn as a skill" (721 chars) is hermes'
SKILLS_GUIDANCE, copied. Dropped its Skill Safety Rule — four points on
recovering skills lost to hermes' context compaction, which pi does not do.

MANAGE_SKILL_DESCRIPTION is hermes' SKILL_MANAGE_SCHEMA, copied.
Deviations: our path; no delete action, so the absorbed_into paragraph goes
whole; skill_view() became read; dropped the 57-char truncation rule
(hermes truncates its index, pi emits descriptions whole); dropped pinned
skills and the curator. KEPT our read-only-roots sentence, which has no
hermes equivalent and exists because pi silently lets the agent shadow a
user's skill by name.

"# Creating skills" was deleted. It CONTRADICTED the tool description on
the only decision both addressed: the prompt said propose and wait, the
tool said create when a complex task succeeded. Settled on
offer-and-confirm, stated once, where hermes states it.


"# DAILY NOTES" DELETED, AND create NOW DEFAULTS TO TRUE
--------------------------------------------------------

At 3,175 chars it was the largest section in the prompt, and most of it was
one workspace's journaling method — record verbatim, stamp every entry with
the time, append rather than replace, match the file's existing convention.
That is a house style, not app behaviour, and the system prompt imposed it
on every workspace including the ones that never open a daily note. A
workspace wanting a house style states it in its own AGENTS.md, which pi
appends anyway.

What the app IS entitled to say now lives in daily_note's description,
expanded to carry it alone: what a daily note is (one file per day, the
same file the calendar button opens), how the name is computed from two
settings and must never be guessed, the trigger words that mean THIS FILE
rather than a new one, and the read direction. Deliberately not there: how
entries should be written. The append rule survives too, in the tool's
RESULT text — "read it before writing, and add to it rather than replacing
what is there" — delivered at the moment it applies rather than frozen into
every chat.

create flipped to default TRUE in the same pass. The old default made
writing a two-call operation, and an agent told to "call again with create:
true" can instead reach for write and make the file itself, silently
skipping the user's template. The failure the old default prevented — "what
did I write last Monday" leaving an empty note dated last Monday — is real
but rarer and VISIBLE; a note that never got its template is neither.
Opting out is create: false, tested with === false so a null from a strict
provider still creates.


WIKI-LINKS AND DUPLICATE BASENAMES MERGED
-----------------------------------------

Two sections answering one question — how a link finds its file — stating
the resolution tiebreaker twice in slightly different words. The old
"# Wiki-links" even ended by pointing at "the next section."

Dropped in the merge: the note that the in-app create UI auto-appends " 1"
/ " 2" on a same-folder collision. That describes what happens when a
PERSON creates a file and is nothing the agent does or can act on.


search_chats GOT A TRIGGER MAPPING
----------------------------------

search_chats was the only tool with nothing anywhere telling the agent WHEN
to reach for it — its description covered how to call it and that was all.
The failure is the quietest of its kind: nothing errors, no wrong file
appears, the agent just does not remember a conversation you both had, and
that reads as normal rather than as a bug.

Written first as a prompt section, "# Earlier chats", 434 chars, and moved
into the tool description the same day. See THE PATTERN above for why the
HOW-versus-WHEN split it was built on did not hold up.

What it says now, in search_chats' own description: SEARCH FIRST when the
user refers back — "what did we decide about…", "you said last week…", "did
I already ask you to…" — because they are telling you the answer is in a
conversation you both had, and asking them to repeat it is the one wrong
move.

REACHING THE USER MOVED THE SAME WAY
------------------------------------

"# Reaching the user", 909 chars, into send_message's description. All of
it was about one tool: that it is the only way to reach the user outside
the current chat, that "send me / notify me / let me know / ping me /
remind me / tell me when" all mean CALL IT rather than write it down, and
that on an unattended run a message not sent is a message that did not
happen.

One sentence did not move, because it was never about this tool: the advice
to write "send the user a message …" into a cron.json prompt. That belongs
to writing cron jobs, and SCHEDULED_RUNS already says it.


TWO RULES INTO MEMORY_TOOL_DESCRIPTION
--------------------------------------

hermes carries both in its system prompt; we had neither anywhere.

PHRASING: declarative facts, not instructions. An imperative memory is
indistinguishable next chat from an instruction the user just gave, and it
sits above the conversation where it can outrank what they are actually
asking for.

THE STALENESS TEST, appended to SKIP: no PR numbers, commit SHAs or "Phase
N done"; stale in a week means it is not a memory. The category alone only
classifies cases already listed; the test classifies the rest.

Both went in the tool description rather than the prompt because the prompt
is frozen per chat — these reach conversations that already exist.


"# SPEAKING OUT LOUD" NO LONGER TEACHES ARGUMENTS THAT DO NOT EXIST
-------------------------------------------------------------------

It instructed send_message with output: 'voice' and save: true. The tool
takes only text, with additionalProperties: false. Rewritten: the reply
mode is the user's setting, applies automatically, and changes only via
/voice.


DECLINED, CLOSED
----------------

PARALLEL_TOOL_CALL_GUIDANCE — batching advice. Its premise does hold here
(pi defaults to toolExecution "parallel" and runs independent calls through
Promise.all; no tool of ours opts out), but it is a speed optimization for
a cost we have not measured.

TASK_COMPLETION_GUIDANCE — don't stop at a stub, don't fabricate output.
Targets a failure seen in hermes' fleet on GPT-family models, not here.

SKILLS_GUIDANCE — declined, then reversed and taken the same day. The
original call read it as conflicting with our ask-first stance; that was
wrong on the facts, because hermes pairs it with offer-and-confirm in the
tool description. Only its SKILL_PRUNED half is genuinely inapplicable.
