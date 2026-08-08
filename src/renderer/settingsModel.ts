// The renderer's ONE settings object, and the one function that builds it.
//
// The rule this file exists to enforce: **a settings value on screen is a read
// off the object the companion sent, never a copy of one.** `normalizeSettings`
// is the only way an object is built, it is total (every key of `Settings` is
// assigned, which the return type makes a compile error to get wrong), and it
// reads NOTHING but its argument — so it cannot carry a value forward from a
// previous read, a previous workspace, or a previous companion.
//
// It replaced ~21 hand-written assignments in `useSettings.hydrateSettings` that
// fanned one payload out into 20 `useState` slices. The companion builds its
// `/settings` response from rows, so a setting nobody has set is ABSENT rather
// than empty; most of those assignments were guarded on the key being present,
// which meant "the new server has no value for this, so keep showing the old
// server's". Point the app at a second companion and its Agent, GitHub and Voice
// pages all kept the first one's values — and `codingAgent` fell back through
// `?? settingsRef.current`, so the old server's provider and model could be
// written INTO the new one on the next edit.
//
// There is no `?? previous` anywhere below, and there must never be one. Unset
// reads as unset; consumers that need a value either require it (error) or fall
// back at the point of use. See the no-defaults-on-read rule in the root
// CLAUDE.md — the same rule, now with one place to hold it.
//
// Imports are spelled `.ts` because `tests/settingsModel.test.js` loads this
// straight off the source with `node --test`, which resolves specifiers
// literally. See "How imports are spelled" in the root CLAUDE.md.
import { clampPanelCount } from '../shared/settings.ts';
import type {
  Settings, ThemeMode, ViewMode, TreeSortOrder, TreePanelList,
  CodingAgentSettings, AgentSecret,
} from '../shared/settings.ts';
import { normalizeVoiceReply } from '../../agent-core/voiceReply.ts';

// Literals rather than the constants in `./constants.js`: that module re-exports
// through `.js` specifiers, which `node --test` cannot resolve. The types below
// are what keep them honest — a typo is a compile error.
const THEME_SYSTEM: ThemeMode = 'system';
const VIEW_LIVE: ViewMode = 'live';
const VIEW_RAW: ViewMode = 'raw';
const SORT_NAME_ASC: TreeSortOrder = 'name-asc';

const PANEL_OFF: TreePanelList = { show: false, count: 10 };

/**
 * Settings before any companion has answered, and after one goes away.
 *
 * Every DB-backed value is UNSET — no provider, no model, no vendor. The
 * renderer must never invent a value the companion doesn't have: the Telegram
 * and cron runners read that same database directly, so a desktop-side default
 * makes a setting look configured on screen while those runners see the hole and
 * fail. (A `DEFAULT_SETTINGS` merge did exactly that to `codingAgent.provider`.)
 *
 * The machine-local keys carry their real defaults because main always supplies
 * them — they live in a userData file and need no server. Their declaration is
 * `LOCAL_SETTINGS` in `src/main/api/localSettings.ts`; these mirror it only so
 * the pre-boot object has a usable shape.
 */
export const EMPTY_SETTINGS: Settings = Object.freeze({
  workspaces: [],
  activeWorkspaceId: null,
  appearance: { themeMode: THEME_SYSTEM, hideLineNumbers: false, treePanel: { recent: PANEL_OFF, daily: PANEL_OFF } },
  // `thinkingLevel` is OMITTED, not defaulted: 'medium' is a value no row ever
  // held, and the agent boots unset as 'off' — so the page would show a level
  // that never runs.
  codingAgent: { provider: '', model: '', hasProviderKey: {}, baseUrl: '' },
  agentSecrets: [],
  transcription: { provider: '' },
  speech: {},
  hasVoiceKey: {},
  sync: { hasPat: false, pullIntervalSeconds: 10 },
  telegram: {},
  timezone: 'UTC',
  chatSidebarOpen: true,
  chatSidebarWidth: 360,
  sidebarWidth: 260,
  viewMode: VIEW_LIVE,
  treeSortOrder: SORT_NAME_ASC,
  bookmarkFilterActive: false,
  showHiddenFiles: false,
  chatSources: null,
  openTabs: {},
  windowBounds: null,
}) as Settings;

/**
 * Build the renderer's settings object from one `settings:read` / `settings:changed`
 * payload. Total, and a pure function of `disk` alone.
 *
 * `disk` is main's merge of the companion's rows with the machine-local file,
 * credentials already replaced by `has*` flags (`src/main/settingsStrip.ts`).
 * Keys the companion has no row for are simply missing, and each falls to its
 * unset value here rather than to whatever was on screen a moment ago.
 */
export function normalizeSettings(disk: any): Settings {
  const d = (disk && typeof disk === 'object') ? disk : {};

  // Both provider fields carried through, and NEITHER defaulted. This was a
  // two-field whitelist that also substituted `'assemblyai'`, which broke twice:
  // a field added to the slice (`micProvider`) was dropped on every hydrate, so
  // it persisted correctly and then vanished from the screen; and the fallback
  // re-invented exactly the vendor-nobody-chose that `listenProviderOf` stopped
  // inventing. Resolution is `agent-core/voiceProviders.ts`'s job, at the point
  // of use.
  const transcription: Settings['transcription'] = {
    provider: d.transcription?.provider || '',
    micProvider: d.transcription?.micProvider || '',
    echoTelegramTranscript: !!d.transcription?.echoTelegramTranscript,
  };

  // Speaking is opt-in, so an unset provider stays unset — there is no vendor it
  // would be right to guess, and guessing one shows a configured-looking page for
  // an account that doesn't exist.
  const speech: Settings['speech'] = {
    provider: d.speech?.provider || '',
    voiceId: d.speech?.voiceId || '',
    modelId: d.speech?.modelId || '',
    // Unset ⇒ text, through the same normalizer every other reader uses rather
    // than a `|| 'text'` here — the bot writes this row too.
    telegramReply: normalizeVoiceReply(d.speech?.telegramReply),
  };

  // The two quick-access lists, each with its own on/off and cap, migrating
  // forward through both retired shapes. Superseded rows stay in the DB (nothing
  // deletes a row for a key that stops being written), so `content`/`count` are
  // still readable and an older build on another machine keeps reading them.
  // This only ever falls BACK to them, never writes them.
  const rawPanel = d.appearance?.treePanel;
  const legacyContent: string | undefined =
    ['off', 'recent', 'daily', 'both'].includes(rawPanel?.content) ? rawPanel.content
      : (d.appearance?.dailyNotesInBookmarks ? 'daily' : undefined);
  const legacyCount = clampPanelCount(rawPanel?.count);
  const panelList = (raw: any, wasOn: boolean): TreePanelList => ({
    show: typeof raw?.show === 'boolean' ? raw.show : wasOn,
    count: clampPanelCount(raw?.count ?? legacyCount),
  });

  const codingAgent: CodingAgentSettings = d.codingAgent ?? EMPTY_SETTINGS.codingAgent;
  const agentSecrets: AgentSecret[] = Array.isArray(d.agentSecrets) ? d.agentSecrets : [];

  return {
    workspaces: Array.isArray(d.workspaces) ? d.workspaces : [],
    activeWorkspaceId: d.activeWorkspaceId ?? null,
    appearance: {
      themeMode: d.appearance?.themeMode || THEME_SYSTEM,
      hideLineNumbers: !!d.appearance?.hideLineNumbers,
      treePanel: {
        recent: panelList(rawPanel?.recent, legacyContent === 'recent' || legacyContent === 'both'),
        daily: panelList(rawPanel?.daily, legacyContent === 'daily' || legacyContent === 'both'),
      },
    },
    codingAgent,
    agentSecrets,
    transcription,
    speech,
    // A MAP of slug -> true, not a boolean — the shape a wildcard credential's
    // flag takes. See `stripCredentials`.
    hasVoiceKey: { ...(d.hasVoiceKey ?? {}) },
    sync: {
      hasPat: !!d.sync?.hasPat,
      pullIntervalSeconds:
        typeof d.sync?.pullIntervalSeconds === 'number' && d.sync.pullIntervalSeconds > 0
          ? d.sync.pullIntervalSeconds
          : EMPTY_SETTINGS.sync.pullIntervalSeconds,
    },
    // Carried through raw — unset fields stay unset, so the page can tell "you
    // chose 24" from "nobody has chosen anything", and only the display fills in.
    telegram: d.telegram ?? {},
    timezone: typeof d.timezone === 'string' ? d.timezone : EMPTY_SETTINGS.timezone,
    chatSidebarOpen: typeof d.chatSidebarOpen === 'boolean' ? d.chatSidebarOpen : EMPTY_SETTINGS.chatSidebarOpen,
    chatSidebarWidth: typeof d.chatSidebarWidth === 'number' ? d.chatSidebarWidth : EMPTY_SETTINGS.chatSidebarWidth,
    sidebarWidth: typeof d.sidebarWidth === 'number' ? d.sidebarWidth : EMPTY_SETTINGS.sidebarWidth,
    viewMode: d.viewMode === VIEW_RAW || d.viewMode === VIEW_LIVE ? d.viewMode : EMPTY_SETTINGS.viewMode,
    treeSortOrder: typeof d.treeSortOrder === 'string' ? d.treeSortOrder : EMPTY_SETTINGS.treeSortOrder,
    bookmarkFilterActive: !!d.bookmarkFilterActive,
    showHiddenFiles: !!d.showHiddenFiles,
    chatSources: Array.isArray(d.chatSources) ? d.chatSources : null,
    openTabs: (d.openTabs && typeof d.openTabs === 'object') ? d.openTabs : {},
    windowBounds: d.windowBounds ?? null,
  };
}
