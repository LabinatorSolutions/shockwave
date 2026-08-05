import { useState, useRef, useCallback, useEffect } from 'react';
import { useSyncRef } from './useSyncRef';
import { buildPatch, dropEmptyCredentials } from '../settingsDiff.js';
import { THEME_MODES, VIEW_MODES, TREE_SORT_ORDERS } from '../constants';
import type { Settings, WorkspaceData, ThemeMode, ViewMode, TreeSortOrder, CodingAgentSettings, AgentSecret, VoiceReply } from '../../shared/settings';

// dailyNote + templates moved to the per-workspace WorkspaceData.
type DailyNote = WorkspaceData['dailyNote'];
type TreePanel = Settings['appearance']['treePanel'];
type Templates = WorkspaceData['templates'];
type Transcription = Settings['transcription'];
type Speech = NonNullable<Settings['speech']>;
type SyncSettings = Settings['sync'];
type TelegramSettings = NonNullable<Settings['telegram']>;

// Empty-shaped placeholder to satisfy the Settings type before hydrate() seeds
// the real values from the companion. DB settings start UNSET here — no provider,
// no model — so the renderer never invents a value the DB doesn't have (that fake
// `anthropic` was the provider bug). hydrate() overwrites this wholesale on boot.
const DEFAULT_CANONICAL: Settings = {
  workspaces: [],
  activeWorkspaceId: null,
  appearance: { themeMode: THEME_MODES.SYSTEM, hideLineNumbers: false, treePanel: { content: 'off', count: 10 } },
  // thinkingLevel is OMITTED, not defaulted: 'medium' here was a value no DB row
  // ever held, and the agent boots unset as 'off' — so the page showed a level
  // that never ran. Unset stays unset; the field renders its placeholder.
  codingAgent: { provider: '', model: '', hasProviderKey: {}, baseUrl: '' },
  agentSecrets: [],
  // Unset, like every other DB-backed value here. A seeded vendor would be
  // written back on the next save as if it had been chosen.
  transcription: { provider: '' },
  speech: {},
  hasVoiceKey: {},
  sync: { hasPat: false, pullIntervalSeconds: 10 },
  // Empty, not seeded: every field inside is optional and the numbers that
  // actually apply come from agent-core/chatNotice.ts at the point of use. A
  // seeded 24 here would be written back on the next save as if you had chosen it.
  telegram: {},
  timezone: 'UTC',
  chatSidebarOpen: true,
  chatSidebarWidth: 360,
  sidebarWidth: 260,
  viewMode: VIEW_MODES.LIVE,
  treeSortOrder: TREE_SORT_ORDERS.NAME_ASC,
  bookmarkFilterActive: false,
  showHiddenFiles: false,
  chatSources: null,
  openTabs: {},
  windowBounds: null,
};

interface UseSettingsOpts {
  /** Called when MAIN pushes a new workspace list (create / remove / set-up-here
   *  / sync toggle). The list lives in App, so this hands it over rather than
   *  duplicating the state here. */
  onWorkspacesPushed?: (workspaces: any[], activeWorkspaceId: string | null) => void;
  // Needed for onSyncChange to restart the sync engine for the active workspace.
  activeWorkspacePath: string | null;
}

// Owns everything persisted to settings.json: the per-field UI state, the one
// canonical settingsRef (the single source of truth a save writes), the save-
// status badge, persistSettings (the shared writer — callers pass only what
// changed), the per-field change handlers, and hydrate() to seed from disk on
// boot. Non-settings persisted fields (workspaces, viewMode, sidebar widths)
// flow through persistSettings too; their UI state lives in App.

export function useSettings({ activeWorkspacePath, onWorkspacesPushed }: UseSettingsOpts) {
  const [themeMode, setThemeMode] = useState<ThemeMode>(THEME_MODES.SYSTEM);
  const [hideLineNumbers, setHideLineNumbers] = useState(false);
  const [treePanel, setTreePanel] = useState<TreePanel>({ content: 'off', count: 10 });
  // Live + persisted bookmark-filter mode (single source of truth; useBookmarks
  // no longer owns this so the view can survive restarts / workspace switches).
  const [bookmarkFilterActive, setBookmarkFilterActiveState] = useState(false);
  // "Show hidden files" — the eye button above the tree. Display only; the tree
  // is re-read from disk when it flips (App owns that call).
  const [showHiddenFiles, setShowHiddenFilesState] = useState(false);
  const [chatSources, setChatSourcesState] = useState<string[] | null>(null);
  const [dailyNote, setDailyNote] = useState<DailyNote>({ format: 'YYYY-MM-DD', folder: '', templatePath: '' });
  const dailyNoteRef = useSyncRef(dailyNote);
  const [templates, setTemplates] = useState<Templates>({ folder: '' });
  // Per-workspace built-in skill toggles: folderName → 'enabled' | 'disabled'.
  // Absent ⇒ enabled (default-on). Loaded with the workspace; written to its file.
  const [builtinSkills, setBuiltinSkills] = useState<Record<string, 'enabled' | 'disabled'>>({});
  const [treeSortOrder, setTreeSortOrder] = useState<TreeSortOrder>(TREE_SORT_ORDERS.NAME_ASC);
  const [codingAgentSettings, setCodingAgentSettings] = useState<CodingAgentSettings>(DEFAULT_CANONICAL.codingAgent);
  const [agentSecrets, setAgentSecrets] = useState<AgentSecret[]>([]);
  // Unset until hydrate — never a guessed vendor. See the note in `hydrateSettings`.
  const [transcription, setTranscription] = useState<Transcription>({ provider: '' });
  // The speaking half, and the per-vendor key flags both halves render dots from.
  // `hasVoiceKey` is a MAP (slug -> true), the shape a wildcard credential's flag
  // takes — see stripCredentials.
  const [speech, setSpeech] = useState<Speech>({});
  const [hasVoiceKey, setHasVoiceKey] = useState<Record<string, boolean>>({});
  const [sync, setSync] = useState<SyncSettings>({ hasPat: false, pullIntervalSeconds: 10 });
  const syncRef = useSyncRef(sync);
  const [telegram, setTelegram] = useState<TelegramSettings>({});
  const [timezone, setTimezone] = useState('UTC');

  // Local cache of everything persisted, for rendering and for building whole
  // sub-objects in per-field setters. NOT the source of truth — the store is.
  const settingsRef = useRef<Settings>(DEFAULT_CANONICAL);

  // `hydrateSettings` is defined far below (it needs every setter), and the
  // settings:changed listener above it needs to call it on a resync. Held in a
  // ref and assigned after the declaration — the same pattern the settings pages
  // use for `recheck` — so the listener keeps a stable identity and does not tear
  // down and re-subscribe on every render.
  const hydrateRef = useRef<((disk: any) => void) | null>(null);

  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const inFlightSavesRef = useRef(0);
  const savedFadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Writes ONLY the individual leaves the caller actually changed.
  //
  // This used to merge the patch into settingsRef and write the whole settings
  // object — correct when settings were one JSON file, where a partial write
  // meant a read-modify-write in main and sending everything was the safe play.
  // With one row per key that inverted: writing every subtree to change a
  // sidebar width put every unrelated setting, credentials included, in the
  // blast radius of a stale in-memory copy.
  //
  // A key absent from the patch keeps whatever the store already holds.
  const persistSettings = useCallback(async (next: Partial<Settings>) => {
    const prev = settingsRef.current;
    settingsRef.current = { ...prev, ...next };
    const patch = dropEmptyCredentials(buildPatch(next, prev));
    if (!Object.keys(patch).length) return;
    inFlightSavesRef.current += 1;
    if (savedFadeTimerRef.current) {
      clearTimeout(savedFadeTimerRef.current);
      savedFadeTimerRef.current = null;
    }
    setSaveStatus('saving');
    try {
      await window.api.settings.write(patch);
      inFlightSavesRef.current -= 1;
      if (inFlightSavesRef.current === 0) {
        setSaveStatus('saved');
        savedFadeTimerRef.current = setTimeout(() => {
          savedFadeTimerRef.current = null;
          setSaveStatus('idle');
        }, 1500);
      }
    } catch {
      // Roll the cache back for the keys this save owned. Without this, the
      // optimistic update above survives a failed write, so re-applying the same
      // change diffs as "unchanged", sends nothing, and the setting can never be
      // persisted again — the cache would permanently disagree with the store.
      // Only the failed keys are reverted, so a concurrent successful save isn't
      // clobbered.
      const rolled: any = { ...settingsRef.current };
      for (const k of Object.keys(next)) rolled[k] = (prev as any)[k];
      settingsRef.current = rolled;
      inFlightSavesRef.current -= 1;
      setSaveStatus('error');
    }
  }, []);

  // persistSettings stores appearance flat for callers, so settingsRef.appearance
  // must always be coherent. The theme/hideLineNumbers handlers patch the nested
  // appearance object explicitly.
  const onThemeModeChange = useCallback(async (mode: ThemeMode) => {
    setThemeMode(mode);
    await persistSettings({ appearance: { ...settingsRef.current.appearance, themeMode: mode } });
  }, [persistSettings]);

  const onHideLineNumbersChange = useCallback(async (next: boolean) => {
    setHideLineNumbers(next);
    await persistSettings({ appearance: { ...settingsRef.current.appearance, hideLineNumbers: next } });
  }, [persistSettings]);

  const onTreePanelChange = useCallback(async (next: TreePanel) => {
    setTreePanel(next);
    await persistSettings({ appearance: { ...settingsRef.current.appearance, treePanel: next } });
  }, [persistSettings]);

  // Toggle/persist the bookmark-filter view. Sets React state synchronously so
  // the tree re-renders immediately; the write is fire-and-forget.
  const onBookmarkFilterActiveChange = useCallback((next: boolean) => {
    setBookmarkFilterActiveState(next);
    persistSettings({ bookmarkFilterActive: next });
  }, [persistSettings]);

  // Same shape as the bookmark filter: state first so the UI reacts, write is
  // fire-and-forget. settingsRef is updated by persistSettings, and App reads
  // the flag from THERE (not from this state) when it reads the tree — boot
  // calls loadWorkspace in the same tick as hydrate, before React has
  // re-rendered, so a state read would be false and hide everything.
  const onShowHiddenFilesChange = useCallback((next: boolean) => {
    setShowHiddenFilesState(next);
    persistSettings({ showHiddenFiles: next });
  }, [persistSettings]);

  // Which chat sources the history list shows. A view preference, machine-local
  // like the rest of this group — the runs happen either way. `null` is "all",
  // and staying null rather than seeding the full list is what keeps a source
  // added later visible by default.
  // Which files are open, per workspace. Deliberately NOT React state: nothing
  // renders from it, and tab churn (every open, close, switch and drag) would
  // otherwise re-render the whole app to store a value only the next launch
  // reads. App debounces the call; settingsRef is the live copy either way.
  const saveOpenTabs = useCallback((workspaceId: string, entry: { paths: string[]; active: string | null }) => {
    if (!workspaceId) return;
    const prev = settingsRef.current.openTabs ?? {};
    const next = { ...prev, [workspaceId]: entry };
    if (JSON.stringify(prev[workspaceId]) === JSON.stringify(entry)) return;
    persistSettings({ openTabs: next });
  }, [persistSettings, settingsRef]);

  const onChatSourcesChange = useCallback((next: string[] | null) => {
    setChatSourcesState(next);
    persistSettings({ chatSources: next });
  }, [persistSettings]);

  // Daily-note + templates are per-workspace now: they live in the active
  // workspace's `.shockwave/workspace.json`, not global settings.json. Writes
  // go through workspaceSettings.update (active workspace only); loads happen on
  // workspace switch via loadWorkspaceData().
  const onDailyNoteChange = useCallback(async (next: DailyNote) => {
    setDailyNote(next);
    dailyNoteRef.current = next;
    if (activeWorkspacePath) await window.api.workspaceSettings.update(activeWorkspacePath, { dailyNote: next });
  }, [dailyNoteRef, activeWorkspacePath]);

  const onTemplatesChange = useCallback(async (next: Templates) => {
    setTemplates(next);
    if (activeWorkspacePath) await window.api.workspaceSettings.update(activeWorkspacePath, { templates: next });
  }, [activeWorkspacePath]);

  // How this workspace wants Telegram replies delivered. It lives on the
  // COMPANION's workspace row rather than in the checkout, because `/voice` sets
  // the same value from the bot and a slash command has no checkout prepared.
  //
  // No local state: main re-pushes the workspace list after the write, and the
  // page reads the mode off the active workspace entry. A second copy here would
  // be one the bot could silently disagree with.
  const onVoiceReplyChange = useCallback(async (id: string, next: VoiceReply) => {
    if (id) await window.api.workspace.setVoiceReply(id, next);
  }, []);

  // Seed daily-note + templates from a loaded workspace-data object (called by
  // App's loadWorkspace). Resets to defaults when data is null.
  const loadWorkspaceData = useCallback((data: any) => {
    const dn: DailyNote = {
      format: data?.dailyNote?.format || 'YYYY-MM-DD',
      folder: data?.dailyNote?.folder ?? '',
      templatePath: data?.dailyNote?.templatePath ?? '',
    };
    const tpl: Templates = { folder: data?.templates?.folder ?? '' };
    setDailyNote(dn);
    dailyNoteRef.current = dn;
    setTemplates(tpl);
    setBuiltinSkills(data?.builtinSkills && typeof data.builtinSkills === 'object' ? data.builtinSkills : {});
  }, [dailyNoteRef]);

  // Per-workspace built-in on/off. Built-ins are default-on (absent key ⇒
  // enabled); this writes an explicit value only when the user changes it.
  const onBuiltinSkillToggle = useCallback(async (folderName: string, enabled: boolean) => {
    setBuiltinSkills((prev) => {
      const next = { ...prev, [folderName]: enabled ? 'enabled' : 'disabled' } as Record<string, 'enabled' | 'disabled'>;
      if (activeWorkspacePath) window.api.workspaceSettings.update(activeWorkspacePath, { builtinSkills: next }).catch(() => {});
      return next;
    });
  }, [activeWorkspacePath]);

  const onTreeSortOrderChange = useCallback(async (next: TreeSortOrder) => {
    setTreeSortOrder(next);
    await persistSettings({ treeSortOrder: next });
  }, [persistSettings]);

  // ── Slice setters MERGE; they do not replace ────────────────────────────────
  //
  // Each of these owns one sub-object of settings, and a caller passes only the
  // leaves it changed. The siblings are filled in HERE, from the canonical ref.
  //
  // They used to replace, which made every caller responsible for spreading the
  // rest of the slice back in — a rule that is invisible at the call site, since
  // `onTranscriptionChange({echoTelegramTranscript})` is a perfectly ordinary
  // looking line. Miss the spread and the SERVER stays correct (the diff only
  // sends the leaves present) while the renderer's copy silently loses the
  // siblings, so an unrelated page reads as unconfigured until the next
  // `settings:changed` push repairs it. It was got wrong three times: Telegram's
  // echo checkbox blanked both voice providers, `micProvider` was dropped by
  // hydrate, and GitHub's `updateSync` rebuilt the slice without `hasPat` so
  // saving a token hid its own dots.
  //
  // Merging here is strictly safer than the old contract, never weaker: a caller
  // that still passes a whole slice gets the identical result, and omitting a key
  // could never have deleted it anyway — the patch simply wouldn't mention it, so
  // the stored value survived regardless. The only thing that changed is whether
  // the RENDERER agrees with the store about what it didn't touch.
  //
  // Merge from `settingsRef`, not React state: `persistSettings` updates the ref
  // synchronously, so two commits in the same tick both see the first one's work.
  // Reading state would make the second overwrite the first with a stale sibling.
  const onCodingAgentChange = useCallback(async (patch: Partial<CodingAgentSettings>) => {
    const next = { ...settingsRef.current.codingAgent, ...patch } as CodingAgentSettings;
    setCodingAgentSettings(next);
    await persistSettings({ codingAgent: next });
  }, [persistSettings]);

  const onAgentSecretsChange = useCallback(async (next: AgentSecret[]) => {
    setAgentSecrets(next);
    await persistSettings({ agentSecrets: next });
  }, [persistSettings]);

  // Re-seed agentSecrets from the store WITHOUT persisting. Mostly redundant now
  // that main pushes `settings:changed` after an OAuth write (see the listener
  // below), but kept as an explicit belt for callers that want to force a pull.
  const reloadAgentSecrets = useCallback(async () => {
    const disk = await window.api.settings.read();
    const secrets: AgentSecret[] = Array.isArray(disk.agentSecrets) ? disk.agentSecrets : [];
    setAgentSecrets(secrets);
    settingsRef.current = { ...settingsRef.current, agentSecrets: secrets };
  }, []);

  // Main writes settings on its own — OAuth token refresh, cron toggles,
  // ensureBuiltinSecretSlots — and it re-pushes when the companion becomes
  // reachable again. Every one of those carries a COMPLETE snapshot, and this
  // re-seeds from it through the same function boot uses.
  //
  // ONE mapping, deliberately. This used to apply only the keys main named, which
  // meant the disk→state mapping existed twice — complete in `hydrateSettings`,
  // partial here — and a field added to one and missed in the other worked at
  // boot and was stale forever after. That is exactly what happened to
  // `voiceReply`, and to every synced setting after a reconnect.
  //
  // It is a PULL. `hydrateSettings` only seeds local state and the canonical ref;
  // nothing on this path writes, which is what stops the blanks an offline boot
  // invented from ever reaching the companion. The old "apply only the reported
  // keys so an unrelated write can't stomp a field you're editing" guard is not
  // needed for that: a text field's draft lives in `useCommitField` and commits on
  // blur, so settings state was never the edit buffer.
  useEffect(() => {
    const off = window.api.settings.onChanged(({ settings }: { settings: any }) => {
      hydrateRef.current?.(settings);
      // The workspace list lives in App, not here, and boot may have had none to
      // load — so a reconnect can still open a workspace the offline boot couldn't.
      onWorkspacesPushed?.(settings.workspaces ?? [], settings.activeWorkspaceId ?? null);
    });
    return off;
  }, [onWorkspacesPushed]);

  // Merges, like every slice setter — see the note above `onCodingAgentChange`.
  const onTranscriptionChange = useCallback(async (patch: Partial<Transcription>) => {
    const next = { ...settingsRef.current.transcription, ...patch } as Transcription;
    setTranscription(next);
    await persistSettings({ transcription: next });
  }, [persistSettings]);

  const onSpeechChange = useCallback(async (patch: Partial<Speech>) => {
    const next = { ...(settingsRef.current.speech ?? {}), ...patch } as Speech;
    setSpeech(next);
    await persistSettings({ speech: next });
  }, [persistSettings]);

  // Merges at the TOP level only. `telegram.chatNotice` is a nested object, so a
  // caller changing one of its fields still rebuilds that inner object itself —
  // one level of merging is what a spread does, and pretending otherwise here
  // would be a deep-merge nobody asked for (it would also make clearing a nested
  // field impossible).
  const onTelegramChange = useCallback(async (patch: Partial<TelegramSettings>) => {
    const next = { ...(settingsRef.current.telegram ?? {}), ...patch } as TelegramSettings;
    setTelegram(next);
    await persistSettings({ telegram: next });
  }, [persistSettings]);

  /**
   * Store one vendor's API key.
   *
   * Sends ONLY the slot being typed into. The companion merges a credential map
   * rather than treating it as complete (`reconcileCredentialMap`), so the other
   * vendors' keys are untouched — and there is nothing to resend, because the
   * renderer never holds a key value in the first place.
   *
   * Removing is a separate call (`settings:deleteCredential`): an empty value
   * can't carry the intent, since every credential the renderer holds reads as
   * empty and empties are stripped from saves.
   */
  const onVoiceKeyChange = useCallback(async (slug: string, value: string) => {
    if (!slug || !value) return;
    setHasVoiceKey((prev) => ({ ...prev, [slug]: true }));
    await persistSettings({ voiceKeys: { [slug]: value } });
  }, [persistSettings]);

  // Goes through persistSettings like every other setting. The Cron page used to
  // call window.api.settings.write directly, which skipped the Saving/Saved badge
  // AND left settingsRef holding the old zone — so a later diffed save computed
  // its patch against a value that was already stale on the server.
  const onTimezoneChange = useCallback(async (next: string) => {
    setTimezone(next);
    await persistSettings({ timezone: next });
  }, [persistSettings]);

  const onSyncChange = useCallback(async (patch: Partial<SyncSettings>) => {
    const next = { ...settingsRef.current.sync, ...patch } as SyncSettings;
    setSync(next);
    syncRef.current = next;
    await persistSettings({ sync: next });
    // Restart the engine so PAT / interval changes take effect immediately.
    if (activeWorkspacePath) {
      window.api.sync.engineStart({ workspacePath: activeWorkspacePath, intervalSeconds: next.pullIntervalSeconds }).catch(() => {});
    }
  }, [persistSettings, activeWorkspacePath, syncRef]);

  // Seed everything from the on-disk settings object at boot, BEFORE any save can
  // fire (so an unchanged field isn't written as its default and clobbered).
  const hydrateSettings = useCallback((disk: any) => {
    // Carry the presence FLAGS through — main strips the values, so these are the
    // only thing telling a field whether a credential is stored. Dropping them here
    // is why every box read as empty.
    // Both provider fields, and NEITHER is defaulted. This was a two-field
    // whitelist that also substituted `'assemblyai'`, which broke twice over: a
    // field added to the slice (`micProvider`) was silently dropped on every
    // hydrate — so it persisted correctly and then vanished from the screen —
    // and the fallback re-invented exactly the vendor-nobody-chose that
    // `listenProviderOf` stopped inventing. Unset stays unset; resolution is
    // `agent-core/voiceProviders.ts`'s job, at the point of use.
    const tr: Transcription = {
      provider: disk.transcription?.provider || '',
      micProvider: disk.transcription?.micProvider || '',
      echoTelegramTranscript: !!disk.transcription?.echoTelegramTranscript,
    };
    // Speaking is opt-in, so an unset provider stays unset — there is no vendor
    // it would be right to guess, and guessing one would show a configured-looking
    // page for an account that doesn't exist.
    const sp: Speech = {
      provider: disk.speech?.provider || '',
      voiceId: disk.speech?.voiceId || '',
      modelId: disk.speech?.modelId || '',
    };
    // A MAP of flags, not a boolean — one entry per vendor that has a key stored.
    const vk: Record<string, boolean> = { ...(disk.hasVoiceKey ?? {}) };
    const sy: SyncSettings = {
      hasPat: !!disk.sync?.hasPat,
      pullIntervalSeconds: typeof disk.sync?.pullIntervalSeconds === 'number' && disk.sync.pullIntervalSeconds > 0 ? disk.sync.pullIntervalSeconds : 10,
    };
    // Carried through raw — unset fields stay unset, so the page can tell "you
    // chose 24" from "nobody has chosen anything", and only the display fills in.
    const tg: TelegramSettings = disk.telegram ?? {};
    const tm: ThemeMode = disk.appearance?.themeMode || THEME_MODES.SYSTEM;
    const hln = !!disk.appearance?.hideLineNumbers;
    // Migrate the retired `dailyNotesInBookmarks` checkbox: on ⇒ daily notes panel.
    const rawTp = disk.appearance?.treePanel;
    const tp: TreePanel = {
      content: ['off', 'recent', 'daily', 'both'].includes(rawTp?.content)
        ? rawTp.content
        : (disk.appearance?.dailyNotesInBookmarks ? 'daily' : 'off'),
      count: typeof rawTp?.count === 'number' && rawTp.count >= 1 ? Math.min(50, Math.round(rawTp.count)) : 10,
    };
    const bfa = !!disk.bookmarkFilterActive;
    const shf = !!disk.showHiddenFiles;
    const cs = Array.isArray(disk.chatSources) ? disk.chatSources : null;
    const tso: TreeSortOrder = typeof disk.treeSortOrder === 'string' ? disk.treeSortOrder : TREE_SORT_ORDERS.NAME_ASC;
    const ca: CodingAgentSettings = disk.codingAgent ?? settingsRef.current.codingAgent;
    const secrets: AgentSecret[] = Array.isArray(disk.agentSecrets) ? disk.agentSecrets : [];

    settingsRef.current = {
      workspaces: disk.workspaces || [],
      activeWorkspaceId: disk.activeWorkspaceId ?? null,
      appearance: { themeMode: tm, hideLineNumbers: hln, treePanel: tp },
      codingAgent: ca,
      agentSecrets: secrets,
      transcription: tr,
      speech: sp,
      hasVoiceKey: vk,
      sync: sy,
      telegram: tg,
      timezone: typeof disk.timezone === 'string' ? disk.timezone : 'UTC',
      chatSidebarOpen: typeof disk.chatSidebarOpen === 'boolean' ? disk.chatSidebarOpen : true,
      chatSidebarWidth: typeof disk.chatSidebarWidth === 'number' ? disk.chatSidebarWidth : 360,
      sidebarWidth: typeof disk.sidebarWidth === 'number' ? disk.sidebarWidth : 260,
      viewMode: disk.viewMode === VIEW_MODES.RAW || disk.viewMode === VIEW_MODES.LIVE ? disk.viewMode : VIEW_MODES.LIVE,
      treeSortOrder: tso,
      bookmarkFilterActive: bfa,
      showHiddenFiles: shf,
      chatSources: cs,
      openTabs: (disk.openTabs && typeof disk.openTabs === 'object') ? disk.openTabs : {},
      windowBounds: disk.windowBounds ?? null,
    };
    setThemeMode(tm);
    setHideLineNumbers(hln);
    setTreePanel(tp);
    setBookmarkFilterActiveState(bfa);
    setShowHiddenFilesState(shf);
    setChatSourcesState(cs);
    setTreeSortOrder(tso);
    if (disk.codingAgent) setCodingAgentSettings(ca);
    if (Array.isArray(disk.agentSecrets)) setAgentSecrets(secrets);
    if (disk.transcription) setTranscription(tr);
    if (disk.speech) setSpeech(sp);
    // Unconditional: an empty flag map is the honest answer for a fresh install,
    // and gating on presence would leave the dots from a previous workspace up.
    setHasVoiceKey(vk);
    if (disk.sync) { setSync(sy); syncRef.current = sy; }
    setTelegram(tg);
    if (typeof disk.timezone === 'string') setTimezone(disk.timezone);
  }, [dailyNoteRef, syncRef]);
  hydrateRef.current = hydrateSettings;

  return {
    themeMode, hideLineNumbers, treePanel, bookmarkFilterActive, showHiddenFiles,
    chatSources,
    dailyNote, dailyNoteRef, templates, builtinSkills, treeSortOrder,
    codingAgentSettings, agentSecrets, transcription, speech, hasVoiceKey, sync, syncRef, telegram, timezone,
    settingsRef, saveStatus, persistSettings, hydrateSettings, loadWorkspaceData,
    onThemeModeChange, onHideLineNumbersChange, onTreePanelChange,
    onBookmarkFilterActiveChange, onShowHiddenFilesChange, onChatSourcesChange, saveOpenTabs,
    onDailyNoteChange, onTemplatesChange, onBuiltinSkillToggle, onVoiceReplyChange, onTreeSortOrderChange,
    onCodingAgentChange, onAgentSecretsChange, reloadAgentSecrets, onTranscriptionChange,
    onSpeechChange, onVoiceKeyChange, onTelegramChange,
    onSyncChange, onTimezoneChange,
  };
}
