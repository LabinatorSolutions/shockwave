SYSTEM PROMPT — WORKING LIST
2026-08-06.  Prompt is now 91 lines / 6,455 chars.  Was 246 / 19,088.


=========================================================================
DONE
=========================================================================

DELETED
  [x] # Available tools          -2,908   model already gets tool schemas
  [x] # Daily notes              -3,175   one workspace's journaling style
  [x] # Scheduled runs (cron)    -2,608   became the cron tool
  [x] # Creating skills          -1,934   moved to manage_skill
  [x] # Reaching the user          -909   moved to send_message
  [x] # Speaking out loud          -690   already in send_message
  [x] # Guidelines                 -526   split into Operating system +
                                          Secrets; two preferences dropped
  [x] # Earlier chats              -434   moved to search_chats
  [x] # The workspace              -249   nothing the agent can act on
  [x] # Templates                  -224   the file list IS the section
  [x] DEFAULT_AGENTS               -190   AGENTS.md now seeds empty

MERGED INTO # Wiki-links
  [x] # Duplicate basenames
  [x] # Associating content
  [x] # Extending the graph
  [x] # Finding what links to a file

ADDED
  [x] # Skills (mandatory)       +1,087   from hermes. We had NOTHING telling
                                          the agent to load its skills
  [x] # Saving what you learn      +721   from hermes
  [x] # Operating system           +207   platform stated, and gated
  [x] # Secrets                     +77   was a bullet in Guidelines

BUILT
  [x] cron tool                   create/update/remove/list/status.
                                  Validates, then writes cron.json
  [x] cron panel badge            was hardcoded null; broken jobs show red now
  [x] Run Now no longer deletes a one-time job
  [x] daily_note create now defaults to true

TOOL DESCRIPTIONS
  [x] send_message      1,249 -> 190 chars
  [x] search_chats      + when to reach for it
  [x] memory            + declarative phrasing, + 7-day staleness test
  [x] manage_skill      copied from hermes
  [x] daily_note        rewritten to stand alone

REVIEWED, KEPT
  [x] # Markdown supported        940   what the app can render
  [x] # Boundaries                605   where the agent may write and delete
  [x] # Unattended run            439   tells a scheduled run nobody is here
  [x] # Operating system          207   platform, gated
  [x] # File Templates             94   trimmed, renamed
  [x] # Secrets                    77   the token rule
  [x] # Sending the user a file   260   the MEDIA:/path syntax
  [x] # Wiki-links            3,094 -> 1,938  trimmed

CODE
  [x] workspaceFiles/     one module per seeded file, DEFAULT_<X> naming
  [x] cron-parser         removed, imported nowhere
  [x] correlator test     bulk case moved to the unit file, no longer flaky

GATES: 595/595 tests, both typechecks clean, lint 0 errors.


=========================================================================
TODO — SECTIONS NEVER REVIEWED
=========================================================================

One left. All paths are agent-core/ unless noted.

  [ ] SOUL (DEFAULT_SOUL)       508   defaults/workspaceFiles/soul.ts:26
        identity and tone. Only used when a workspace has no SOUL.md

PARKED — hermes' text, taken as-is for now
  # Skills (mandatory)      1,087   defaults/helper.ts:351
  # Saving what you learn     721   defaults/helper.ts:379
  # Memory                    866   defaults/helper.ts:315

WAITING ON SOMETHING ELSE
  The backlinks guidance inside # Wiki-links deletes entirely once a real
  backlinks tool exists. grep is 100% recall, precision ~1/k where k =
  files sharing a basename. Indexed lookup was 294 tokens vs 55,949.


=========================================================================
WRONG THINGS FOUND
=========================================================================

1. THE ASSOCIATION RULE WAS FALSE
   Prompt said a bullet never counts as indentation, with an example:

       [[Topic A]]
       - Note 2.        <- prompt said NOT associated

   It IS associated. collectContext (src/renderer/linkIndex.ts:77) grew a
   second clause and the prompt never followed. Also undocumented:
   numbered items count the same, and a BLANK LINE breaks the association.
   Fixed. 3 tests now run the prompt's own examples through the parser.

2. A PAST DATETIME NEVER FIRES AND NOTHING SAYS SO
   croner accepts a past date and reports no next run. Job registers,
   never fires, nothing logged. This is the ordinary reminder case: the
   agent knows the date, never the time of day. Fixed by the cron tool.

3. RUN NOW DELETED A ONE-TIME JOB
   Manual run shared the scheduler's code and disposal was unconditional.
   Testing a reminder consumed it. Fixed.

4. A JOB WITH NO PROMPT REGISTERS AND THROWS FOREVER
   Scheduler gates on name + schedule only. Fixed.

5. send_message DESCRIBED ARGUMENTS THAT DID NOT EXIST
   `output` and `save`, months after the tool stopped accepting them.

6. THE WINDOWS WARNING PRINTED EVERYWHERE
   "bash and Unix tools are not available on Windows" sat inside a
   guideline with no gate — so it printed on every Mac, and on every
   Telegram and cron run, which are Linux and can never be Windows.
   Meanwhile the three things that WERE gated could never be false.

7. A TEST OF MINE ENFORCED BLOAT
   Asserted description.length > 400. Passed on 1,249 chars of inert
   prose, would have failed the cut that removed it.


=========================================================================
REFERENCE — WHERE EVERYTHING IS
=========================================================================

THE PROMPT, IN ORDER

  ours, frozen when the chat is created:
     1  SOUL               workspaceFiles/soul.ts:26      508   always
     2  # Boundaries       helper.ts:27                   605   always
     3  # Unattended run   helper.ts:37                   439   cron/review/memory
     4  # Operating system helper.ts:140                  207   always
     5  # Secrets          helper.ts:121                    77   always
     6  # Sending a file   companion.ts:26                 260   telegram/cron
     7  # Wiki-links       helper.ts:150                 1,938   always
     8  # File Templates   helper.ts:259                   ~94   if configured
     9  # Markdown         helper.ts:265                   940   always
    10  # Memory           helper.ts:315                   866   always
    11  # Skills (mand.)   helper.ts:351                 1,087   always
    12  # Saving skills    helper.ts:379                   721   always
    13  memory blocks      memoryStore.ts:131         up to 3,575

  pi appends, rebuilt every boot:
    14  <project_context>  AGENTS.md / CLAUDE.md, injected whole
    15  skills list
    16  Current date       (date only — it is part of the cache key)
    17  Current working directory

TOTALS
  desktop             99 lines,  6,965 chars
  cron / telegram    107 lines,  7,668 chars
  + memory blocks    up to +3,575

WHAT VARIES BY MACHINE
  # Unattended run     cron, review, memory only
  # Sending a file     telegram, cron only
  # Operating system   wording differs on Windows vs macOS/Linux
  # File Templates     only when the workspace has some
  memory blocks        only when the files are not empty

  Everything else is identical on every run. Desktop has nothing of its own.

TOOL DESCRIPTIONS — the live layer, rebuilt every boot
  sendMessage.ts        send_message
  chatSearch.ts:63      search_chats
  cronTool.ts           cron
  dailyNoteTool.ts:141  daily_note
  skillTool.ts:52       manage_skill
  memoryTool.ts:34      memory

DOES ANYTHING GET ADDED TO WHAT I TYPE?

  Once. Attachments on Telegram. Send a photo captioned "what's wrong with
  this?" and the agent receives:

      [Image attached at: /data/files/abc123/photo.jpg]

      what's wrong with this?

  You never see that first line. It is there because the agent can SEE the
  picture but needs the path to do anything with the FILE.
  api/src/telegram/attachmentPolicy.ts:193

  Nothing else touches what you type:
    send-to-agent   puts text in the composer, where you edit it and press
                    send yourself (useSendToAgent.ts:108)
    voice echo      goes back to you in Telegram, never to the model
    cron            job.prompt sent verbatim, nothing added
    background runs no human typed anything — the whole message is ours

MESSAGES WE COMPOSE FROM SCRATCH (no human involved)
  defaults/conversation.ts:41   background run context note
  defaults/reviewPrompt.ts:39   review instruction
  defaults/memoryPrompt.ts:28   memory instruction

SEPARATE MODEL CALLS, OWN PROMPTS, NOT THE AGENT
  agent-core/agent.ts:170       chat auto-title
  api/src/telegram/btw.ts:121   /btw
  api/src/gitFixer.ts:225       merge-conflict fixer

WORKSPACE FILE DEFAULTS — agent-core/defaults/workspaceFiles/
  soul.ts        SOUL.md       DEFAULT_SOUL + readSoul (runtime fallback)
  agents.ts      AGENTS.md     empty
  memory.ts      MEMORY.md     empty
  user.ts        USER.md       empty
  ignore.ts      .ignore
  gitignore.ts   .gitignore
  index.ts       DEFAULT_FILES + ensureWorkspaceFiles

SOUL.md vs AGENTS.md — different files, different everything
                 SOUL.md                  AGENTS.md
  read by        us (readSoul)            pi
  lands          FIRST in the prompt      near the END
  read when      chat creation, frozen    every session boot
  found where    workspace root only      every ancestor of cwd
  for            who the agent is         how this project works

  Edit SOUL.md and existing chats keep the old text forever.
  Edit AGENTS.md and it lands on the next message of every chat.
