// Cross-process constants live in src/shared/constants.ts (single source of truth).
// Renderer-only constants stay here. Extensionless import so it resolves to the
// .ts in the Vite dev server, the esbuild build, and tsc alike (an explicit
// `.js` is NOT rewritten to `.ts` by Vite's dev server).
export {
  APP_NAME,
  FILE_ACTIONS,
  FOLDER_ACTIONS,
  EDITOR_ACTIONS,
  SUPPORTED_PROVIDER_SLUGS,
  DEFAULT_PROVIDER_SLUG,
// Spelled `.ts` because `tests/chatSources.test.js` loads this module, and
// `node --test` resolves a specifier literally — no extensionAlias, so an
// extensionless (or `.js`) specifier does not find `constants.ts`. See the
// import rule in the root CLAUDE.md.
} from '../shared/constants.ts';

export const SETTINGS_SECTIONS = Object.freeze({
  COMPANION: 'companion',
  GENERAL: 'general',
  VOICE: 'voice',
  UPDATES: 'updates',
  ADVANCED: 'advanced',
  // Workspace group — Workspaces list + per-(active-)workspace config.
  WORKSPACES: 'workspaces',
  GITHUB: 'github',
  DAILY_NOTE: 'daily-note',
  TEMPLATES: 'templates',
  WORKSPACE_SKILLS: 'workspace-skills',
  AGENT_LLM: 'agent-llm',
  AGENT_SECRETS: 'agent-secrets',
  TELEGRAM: 'telegram',
});

export const THEME_MODES = Object.freeze({
  LIGHT: 'light',
  DARK: 'dark',
  SYSTEM: 'system',
});

// Editor live-preview mode. 'live' renders headings, wiki-link widgets, image
// embeds, task checkboxes, etc. 'raw' shows the underlying markdown text only.
export const VIEW_MODES = Object.freeze({
  LIVE: 'live',
  RAW: 'raw',
});

// Status of the in-flight save lifecycle, surfaced on the editor status bar.
export const SAVE_STATES = Object.freeze({
  SAVED: 'saved',
  UNSAVED: 'unsaved',
});

// File-tree sort order. Folders are always pinned to the top in A→Z order;
// these values only re-order files within their folder.
export const TREE_SORT_ORDERS = Object.freeze({
  NAME_ASC: 'name-asc',
  NAME_DESC: 'name-desc',
  MODIFIED_DESC: 'modified-desc',
  MODIFIED_ASC: 'modified-asc',
  CREATED_DESC: 'created-desc',
  CREATED_ASC: 'created-asc',
});

export const TREE_SORT_LABELS = Object.freeze({
  [TREE_SORT_ORDERS.NAME_ASC]: 'Name (A → Z)',
  [TREE_SORT_ORDERS.NAME_DESC]: 'Name (Z → A)',
  [TREE_SORT_ORDERS.MODIFIED_DESC]: 'Modified (new → old)',
  [TREE_SORT_ORDERS.MODIFIED_ASC]: 'Modified (old → new)',
  [TREE_SORT_ORDERS.CREATED_DESC]: 'Created (new → old)',
  [TREE_SORT_ORDERS.CREATED_ASC]: 'Created (old → new)',
});

// Where a chat came from — `chat.source`, as the companion stores it. Used by the
// chat-history source filter, which is machine-local (a view preference) and
// defaults to all of them.
//
// `desktop` is also the fallback for a row with no source: `agent-core` writes
// `source ?? 'desktop'`, so a null is a pre-provenance chat rather than an unknown
// kind, and filtering it out of "Desktop" would hide history for a reason the user
// can't see.
// **Every `chat.source` the companion can write must be listed here.** A missing
// one is not a missing checkbox: chats of that kind stay visible while the filter
// is `null` (all), and become invisible with no way to turn them back on the
// moment the user narrows it once — and `allSelected` reads as true while they
// are hidden, so the UI says everything is shown. `memory` was added with the
// memory pass for exactly this reason.
export const CHAT_SOURCES = Object.freeze(['desktop', 'telegram', 'cron', 'review', 'memory']);

export const CHAT_SOURCE_LABELS = Object.freeze({
  desktop: 'Desktop',
  telegram: 'Telegram',
  cron: 'Scheduled',
  review: 'Reviews',
  memory: 'Memory',
});
