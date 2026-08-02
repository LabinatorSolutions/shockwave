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
// and DO have desktop defaults — see LOCAL_DEFAULTS in src/main/settingsStore.ts.
//
// Credentials are never stored here in the clear: the companion encrypts them in
// its `secret_value` table (see api/CLAUDE.md), keyed by owner + field.

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
}

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
  // Note: an unset/omitted level makes pi fall back to 'medium' for reasoning-
  // capable models — this field makes the choice explicit and user-controllable.
  thinkingLevel: ThinkingLevel;
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
  // hourly sweeper and the desktop's boot cleanup. Unset ⇒ 1.
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
  // `apiKey` is present in MAIN only; the renderer gets `hasApiKey`.
  // `echoTelegramTranscript`: after transcribing an inbound Telegram voice note,
  // post the transcript back to the chat as `🎤 "…"` before running the turn.
  // Unset ⇒ off (the consumer reads `?? false` — see api/src/telegram/webhook.ts).
  transcription: { provider: string; apiKey?: string; hasApiKey?: boolean; echoTelegramTranscript?: boolean };
  // `pat` is present in MAIN only; the renderer gets `hasPat`.
  sync: { pat?: string; hasPat?: boolean; pullIntervalSeconds: number };
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
  // Whether self-improvement chats are hidden from the chat history list. They
  // are ordinary chats and show by default — the point of running them as chats
  // is that you can open one and read what it decided. This is a VIEW
  // preference, which is why it is machine-local rather than synced: you might
  // want them out of the way on a laptop and visible on a desktop. It hides
  // nothing else — the runs still happen, and their commits still land.
  hideReviewChats: boolean;
  windowBounds: WindowBounds | null;
}
