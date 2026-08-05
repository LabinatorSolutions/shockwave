// The persisted settings schema — the single typed source of truth shared by
// main (readSettings/writeSettings) and the renderer (settingsRef).
//
// This is the shape the renderer sees. The data lives on the COMPANION server
// (Postgres) — the single source of truth — and the desktop reaches it through
// the API client (src/main/api/client.ts). readSettings/writeSettings hide that.
//
// No defaults are merged on read: a DB setting is either set (a row exists) or
// unset, and consumers that need a value either require it (error if unset) or
// fall back at the point of use. The ONE exception is machine-local settings
// (window/view state, the active workspace), which live in a userData file
// and DO have desktop defaults — see LOCAL_SETTINGS in src/main/api/localSettings.ts.
//
// Credentials are never stored here in the clear: the companion encrypts them in
// its `secret_value` table (see api/CLAUDE.md), keyed by owner + field.

// Declared in agent-core because the companion reads the same shape and applies
// the same defaults — see the file for why one copy matters here.
import type { ChatNotice } from '../../agent-core/chatNotice.ts';

export type { ChatNotice };

export type ThemeMode = 'system' | 'light' | 'dark';
// What the quick-access panel pinned below the file tree shows (Explorer and
// Bookmarks views alike). 'both' lists Recent Files and Daily Notes as two
// sections, with daily notes excluded from Recent Files. Lists are always
// sorted last-modified desc and capped to `count` items each.
export type TreePanelContent = 'off' | 'recent' | 'daily' | 'both';
export type ViewMode = 'live' | 'raw';
export type TreeSortOrder =
  | 'name-asc'
  | 'name-desc'
  | 'modified-desc'
  | 'modified-asc'
  | 'created-desc'
  | 'created-asc';

export interface WorkspaceEntry {
  id: string;
  name: string;
  /** Absolute path of the checkout on THIS machine, or null when the workspace
   *  exists but isn't cloned here (a synced DB, or a folder that vanished). */
  path: string | null;
  /** "owner/name", for display. */
  repo: string;
  /** Whether this workspace syncs to GitHub ON THIS MACHINE. Lives here rather
   *  than in `sync` because it's per-workspace: as a list inside the sync object
   *  it was rebuilt — and dropped — whenever anything else in that object
   *  changed.
   *
   *  Stored as `workspace_local.sync_disabled` (0 = syncing), because a zero /
   *  absent row should mean normal behaviour. The negation happens once, in the
   *  projection — it used to leak up here and get negated three more times in
   *  the one switch that renders it. */
  syncEnabled: boolean;
  /** How the agent's Telegram replies come back for this workspace. Lives on the
   *  companion's workspace row, not in the checkout, because `/voice` is a slash
   *  command — answered from that database with no checkout prepared. */
  voiceReply: VoiceReply;
}

/** `'text'` — text only. `'voice'` — a voice note only. `'both'` — voice and text. */
export type VoiceReply = 'text' | 'voice' | 'both';

export type SkillState = 'enabled' | 'disabled';

// Pi's thinking/reasoning levels. 'off' disables extended thinking; the rest map
// to pi's ModelThinkingLevel and are clamped to what each model actually supports
// (via getSupportedThinkingLevels in main). Kept as a local literal union so this
// shared file has no dependency on the pi SDK.
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export interface CodingAgentSettings {
  provider: string;
  model: string;
  // Per-provider API keys, keyed by provider slug, each encrypted at rest
  // (AES-256-GCM). Replaces the former single `apiKey` so switching providers keeps
  // each key. openai-compatible's key lives here too (under 'openai-compatible');
  // its baseUrl/contextWindow stay in the active fields below.
  // Present in MAIN only. The renderer is given `hasProviderKey` instead — see
  // stripCredentials in src/main/settingsStore.ts — so a screen that never holds a
  // key cannot send a stale one back.
  providerKeys?: Record<string, string>;
  /** Renderer-facing: which provider slugs have a key stored. Never the values. */
  hasProviderKey?: Record<string, boolean>;
  // OpenAI-compatible endpoint URL (Ollama, LM Studio, vLLM, remote gateways).
  // Empty for built-in providers; set only when provider === 'openai-compatible'.
  baseUrl: string;
  // Optional context-window override (tokens) for openai-compatible models, whose
  // size pi can't know. Built-in providers carry authoritative values, so it's
  // unused there. Empty/undefined → 128000 default.
  contextWindow?: number;
  // Extended-thinking level applied at session boot. Clamped per-model by pi.
  // OPTIONAL, and unset is a real state: `agent-core/agent.ts` boots with
  // `thinkingLevel || 'off'`, so an unset level runs with thinking OFF. Nothing
  // may substitute another value on the way to the screen — a settings page that
  // renders unset as 'medium' shows a level the agent will not run. See the
  // no-defaults-on-read rule in the root CLAUDE.md.
  thinkingLevel?: ThinkingLevel;
  // How long an unattended run may take before the watchdog aborts it. Applies to
  // Telegram and cron turns, which have no one watching; a desktop chat has the
  // user and the Stop button instead. Unset ⇒ 30 (read `?? 30` at the point of
  // use — there are no defaults on the companion).
  maxRunMinutes?: number;
  // How many times the git-fixer agent may re-attempt a conflicted check-in
  // before the run gives up and reports it. Each attempt reopens the SAME folder,
  // so progress from earlier attempts carries over. `maxRunMinutes` bounds the
  // whole loop, so raising this can't extend the total time. Unset ⇒ 3.
  maxFixAttempts?: number;
  // How long per-chat working directories are kept — the agent's scratch pad and
  // the server's git checkouts — counted from last use. Read by the companion's
  // hourly sweeper and the desktop's boot cleanup, both of which run the shared
  // rule in `agent-core/scratchSweep.ts`: a PINNED chat's dirs are never swept,
  // whatever their age. Unset ⇒ `DEFAULT_SCRATCH_TTL_DAYS` (7).
  scratchTtlDays?: number;
  // How many workspace checkouts the companion keeps cloned in advance, so a new
  // chat doesn't begin with a download somebody waits through. Every companion
  // chat claims from it — Telegram and cron alike — which is why the default is
  // two rather than one: two can legitimately be wanted inside a single restock
  // tick. 0 disables it and every chat clones, as it did before. Unset ⇒ 2.
  checkoutPoolSize?: number;
  // How many tool calls a chat must accumulate before the companion reviews it
  // and updates the agent's own skills. Counted from the last review, across
  // every source — a desktop chat, a Telegram thread and a cron run all feed the
  // same tally, because every turn's messages land on the companion whoever ran
  // it. Tool calls rather than turns: ten trivial exchanges are not a learning
  // opportunity, one turn with twelve tool calls usually is. Unset ⇒ 10, which is
  // what hermes and knack both default to.
  reviewInterval?: number;
  // How many of YOUR messages a chat must accumulate before the companion looks
  // it over for facts worth remembering about you. Counted from the last look,
  // across every source, exactly like reviewInterval.
  //
  // Messages and not tool calls, because this is a different question from the
  // review's. What the agent learns about you shows up in what you SAY — a chat
  // that ran forty tool calls and two sentences reveals almost nothing about you,
  // and one that ran none and twenty sentences may reveal a great deal. That is
  // why the two are separate processes with separate counters rather than one
  // pass doing both. Unset ⇒ 10, 0 disables. hermes' `memory.nudge_interval`.
  memoryInterval?: number;
  // How long a chat must sit untouched before either background process may
  // open it. Both use this one number: they come due at different times because
  // they measure different work, but "are you still in this conversation?" is a
  // fact about the chat, not about which pass is asking.
  //
  // It exists because a finished TURN is not a finished CONVERSATION. The
  // running flag clears the moment the agent stops talking, so without a wait a
  // background run can start while you are typing your next message — examining
  // half a conversation, out of a checkout your next turn is about to write
  // into. Nothing waits on these runs, so delaying one costs nothing.
  //
  // Unset ⇒ 10, and 0 means no wait rather than off — the two intervals above
  // are what switch a process off.
  backgroundQuietMinutes?: number;
  // Char budgets for MEMORY.md and USER.md. The cap is the mechanism, not a
  // safety rail: a write that would exceed it is refused with the current
  // entries attached and an instruction to consolidate, which is what keeps
  // memory a curated page instead of an ever-growing log. Every entry is in
  // every prompt, so the number is also the standing cost.
  // Unset ⇒ 2200 / 1375, hermes' figures (~800 and ~500 tokens).
  memoryCharLimit?: number;
  userCharLimit?: number;
}

// OAuth connection state carried by an `oauth`-kind AgentSecret. The three
// secret-bearing fields (clientSecret, accessToken, refreshToken) are encrypted
// at rest like `token` — they live in `secret_value`, keyed by this entry's
// name; see AGENT_SECRET_FIELDS in the companion's api/src/keys.ts. The lifecycle
// fields (accessToken/refreshToken/expiresAt/status/accountEmail) are written
// ONLY by oauth.ts via patchAgentSecretOAuth; a bulk settings save cannot author
// them (OAUTH_OWNED_FIELDS / OAUTH_OWNED_COLUMNS), which is what stops a stale
// renderer copy from clobbering a token main just refreshed.
// `expiresAt` is an absolute epoch-ms deadline for the access
// token; the refresh-on-demand getter (oauth.ts) refreshes before it lapses.
export interface AgentSecretOAuth {
  provider: string;              // preset id (e.g. 'google') or 'custom'
  clientId: string;
  clientSecret: string;          // encrypted at rest
  authUrl?: string;              // custom provider only (presets bake these in)
  tokenUrl?: string;             // custom provider only
  scopes: string[];
  accessToken?: string;          // encrypted at rest
  refreshToken?: string;         // encrypted at rest
  expiresAt?: number;            // epoch ms; access-token expiry deadline
  accountEmail?: string;         // display only, decoded from an OIDC id_token
  status: 'disconnected' | 'connected' | 'expired';
}

// A credential the coding agent can use. Two kinds, discriminated by `kind`
// (absent ⇒ 'static' for back-compat with pre-OAuth settings files):
//   - 'static' — a pasted API token, in `token`.
//   - 'oauth'  — an OAuth2 connection, in `oauth`; `token` is unused. The agent
//                still fetches it by name via get_agent_secret, which returns a
//                freshly-refreshed access token (see oauth.ts / the bridge).
export interface AgentSecret {
  name: string;
  description: string;
  kind?: 'static' | 'oauth';
  /** Present in MAIN only; stripped before the renderer (see `hasToken`). */
  token?: string;
  /** Renderer-facing: a token is stored. Never the value. */
  hasToken?: boolean;
  oauth?: AgentSecretOAuth;
  createdAt?: number;
  updatedAt?: number;
}

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  maximized: boolean;
}

// Per-workspace data persisted to `<workspace>/.shockwave/workspace.json`.
// Everything scoped to a single workspace lives here (not in global settings):
// bookmarks, daily-note config, templates config, and built-in skill toggles.
export interface WorkspaceData {
  schemaVersion: number;
  // `.md` basenames (no folder, no extension), lowercased.
  bookmarks: string[];
  // `templatePath` is the workspace-relative path of the template seeded into a
  // newly-created daily note ('' = none).
  dailyNote: { format: string; folder: string; templatePath: string };
  // `folder` is the workspace-relative folder whose `.md` files are offered as
  // templates ('' = templates disabled / none configured).
  templates: { folder: string };
  // Built-in skill on/off for this workspace, by folderName. Absent key ⇒
  // enabled (built-ins are default-on). This is the only tier — there is no
  // global default.
  builtinSkills: Record<string, SkillState>;
}

export interface Settings {
  workspaces: WorkspaceEntry[];
  activeWorkspaceId: string | null;
  // `treePanel` replaced the boolean `dailyNotesInBookmarks` (old true migrates
  // to content 'daily' in useSettings.hydrateSettings).
  appearance: { themeMode: ThemeMode; hideLineNumbers: boolean; treePanel: { content: TreePanelContent; count: number } };
  // NOTE: `dailyNote` and `templates` are no longer global — they're per-
  // workspace, stored in `<workspace>/.shockwave/workspace.json` (see
  // `WorkspaceData` below), loaded on workspace switch.
  codingAgent: CodingAgentSettings;
  agentSecrets: AgentSecret[];
  // ── Voice ──────────────────────────────────────────────────────────────────
  // Two directions, chosen INDEPENDENTLY, because the vendor matrix is not
  // square: AssemblyAI listens but cannot speak. See agent-core/voiceProviders.ts
  // for the table both processes read.
  //
  /** Listening. `provider` applies to EVERYTHING that hears — the desktop mic,
   *  Telegram voice notes, and the agent's `transcribe` tool.
   *  `echoTelegramTranscript`: after transcribing an inbound voice note, post the
   *  transcript back as `🎤 "…"` before running the turn. Unset ⇒ off (the
   *  consumer reads `?? false` — see api/src/telegram/webhook.ts). */
  transcription: {
    provider: string;
    /** The MICROPHONE's vendor, when it differs from `provider`. Unset ⇒ the same
     *  one, if it has a microphone. Separate because a key can be permitted to
     *  transcribe and not to stream — see `micProviderOf` in
     *  `agent-core/voiceProviders.ts` for why that is the common case. */
    micProvider?: string;
    echoTelegramTranscript?: boolean;
  };
  /** Speaking. An unset `provider` means speech is not configured, and every
   *  caller falls back to text without complaining — it is opt-in. */
  speech?: {
    provider?: string;
    /** Deepgram: the Aura model (`aura-2-thalia-en`), which IS its voice.
     *  ElevenLabs: the voice id, with `modelId` chosen separately. */
    voiceId?: string;
    modelId?: string;
  };
  /** Vendor slug -> API key, shared by both directions: pick one vendor for both
   *  and you enter its key once. Present in MAIN only; the renderer gets
   *  `hasVoiceKey` (a map of slug -> true). */
  voiceKeys?: Record<string, string>;
  hasVoiceKey?: Record<string, boolean>;
  // `pat` is present in MAIN only; the renderer gets `hasPat`.
  sync: { pat?: string; hasPat?: boolean; pullIntervalSeconds: number };
  /** How the Telegram bot behaves. Identity and runtime state (bot token, active
   *  chat, active workspace, last update id) are NOT here — they live in the
   *  companion's `telegram_account` row. This is preference, which is why it
   *  rides the ordinary settings path and needs no endpoint of its own.
   *
   *  `chatNotice`: after a gap, list the chats that moved while you were away
   *  before answering. Every field is optional and unset means unset — the
   *  defaults live in `agent-core/chatNotice.ts` and are applied at the point of
   *  use (the companion's `telegram/commands.ts`, and this page for display). */
  telegram?: { chatNotice?: ChatNotice };
  // The one unified system timezone (synced). The companion uses it for cron
  // schedules and the agent's "current date"; the desktop uses it for display.
  // IANA name, e.g. "America/New_York"; default "UTC".
  timezone: string;
  // Scheduled runs (cron) have NO settings here. The desktop stopped running the
  // scheduler; the companion owns execution and its knobs are that server's env
  // (CRON_ENABLED, CRON_REFRESH_SCHEDULE). Job definitions
  // live per-workspace in `<workspace>/cron.json`. The in-app surface is the
  // schedule panel (CronModal) — read-only over that file, plus Run now.
  chatSidebarOpen: boolean;
  chatSidebarWidth: number;
  sidebarWidth: number;
  viewMode: ViewMode;
  treeSortOrder: TreeSortOrder;
  // Whether the file-tree is filtered to bookmarks only. Persisted globally so
  // the view survives restarts and workspace switches.
  bookmarkFilterActive: boolean;
  // Whether the file tree shows hidden entries (dotfiles, .git, node_modules).
  // DISPLAY ONLY — the watcher and the link index keep their own rule, so this
  // never changes what the app indexes, resolves wiki-links against, or reloads.
  showHiddenFiles: boolean;
  // Which chat sources the history list shows (`chat.source` — see CHAT_SOURCES
  // in the renderer's constants). **null means all**, which is the default and
  // what a fresh install gets; a stored array is an explicit narrowing.
  //
  // Null rather than a seeded full array so a source added later is visible by
  // default — a saved list from an older build would silently hide it otherwise.
  //
  // A VIEW preference, so machine-local rather than synced: you might want
  // scheduled runs out of the way on a laptop and visible on a desktop. It hides
  // nothing else — the runs still happen and their commits still land.
  chatSources: string[] | null;
  // Which files were open in each workspace when the app last closed, so a
  // restart comes back to the tabs you left rather than an empty window.
  // Keyed by workspace id; `active` is the path that was in front.
  //
  // Machine-local, like the checkout it describes — the same workspace on
  // another machine has its own window and its own idea of what you were doing.
  // Paths are re-checked against the tree on load, so a file deleted or renamed
  // elsewhere is simply dropped rather than opening a tab onto nothing.
  openTabs: Record<string, { paths: string[]; active: string | null }>;
  windowBounds: WindowBounds | null;
}
