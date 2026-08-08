import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { useSyncRef } from './useSyncRef';
import { buildPatch, dropEmptyCredentials } from '../settingsDiff.js';
import { EMPTY_SETTINGS, normalizeSettings } from '../settingsModel.js';
import { SETTINGS_CREDENTIALS, deletePath, getPath } from '../../../agent-core/credentials.js';
import type { Settings, WorkspaceData, ThemeMode, ViewMode, TreeSortOrder, CodingAgentSettings, AgentSecret } from '../../shared/settings';

// ONE settings object, and it is a READ of what the companion sent — never a copy.
//
// Everything on screen comes off `settings` below. There are no per-field
// `useState` slices, and adding one is the bug this hook was rebuilt to make
// impossible: a payload arriving with a key absent (which is what the companion
// sends for a setting nobody has set) used to skip that key's setter, so the
// screen kept showing the PREVIOUS value. Point the app at a second companion
// and its Agent, GitHub, Voice and timezone settings all stayed on the first
// one's — and `codingAgent` was carried forward into the canonical cache too, so
// the old server's provider could be written into the new one on the next edit.
//
// The three rules that replace it:
//
//   1. A push replaces the whole object (`hydrate` → `normalizeSettings`). One
//      assignment, total by construction, nothing to partially apply.
//   2. A write sends only the leaves that changed (`persistSettings` →
//      `buildPatch`). This half was always correct and is unchanged.
//   3. Pointing at a different companion resets the object (`reset`). Nothing
//      from the old server can survive, because nothing is stored per-field.
//
// Non-settings state that happens to live here: `dailyNote`, `templates` and
// `builtinSkills` are PER-WORKSPACE (`.shockwave/workspace.json`), not settings.
// They keep their own state and their own writer.

type DailyNote = WorkspaceData['dailyNote'];
type Templates = WorkspaceData['templates'];
type TreePanel = Settings['appearance']['treePanel'];
type Transcription = Settings['transcription'];
type Speech = NonNullable<Settings['speech']>;
type SyncSettings = Settings['sync'];
type TelegramSettings = NonNullable<Settings['telegram']>;

interface UseSettingsOpts {
  /** Called when MAIN pushes a new workspace list (create / remove / set-up-here
   *  / sync toggle). The list lives in App, so this hands it over rather than
   *  duplicating the state here. */
  onWorkspacesPushed?: (workspaces: any[], activeWorkspaceId: string | null) => void;
  // Needed for onSyncChange to restart the sync engine for the active workspace.
  activeWorkspacePath: string | null;
}

/**
 * Strip credential VALUES out of the renderer's own copy.
 *
 * Main strips them on the way down (`settingsStrip.ts`), and this is the other
 * direction: a save carries a real key (you just typed it), so merging the patch
 * verbatim would park that key in renderer memory until the next push. The patch
 * that goes to the companion is built BEFORE this runs, so nothing is lost — the
 * value travels, it just doesn't stay.
 *
 * Which fields are credentials is declared once, in `agent-core/credentials.ts`.
 */
function withoutCredentials(settings: Settings, patch: Partial<Settings>): Settings {
  // Only when the patch actually carried one. `deletePath` copies each object on
  // the way down, so running it unconditionally would hand back a new
  // `codingAgent` and `sync` on every save — new identities for objects nothing
  // changed, and a re-render of every page reading them.
  const touched = SETTINGS_CREDENTIALS.filter((c) => getPath(patch, c.path) !== undefined);
  if (!touched.length) return settings;
  let out: any = settings;
  for (const c of touched) out = deletePath(out, c.path);
  return out as Settings;
}

export function useSettings({ activeWorkspacePath, onWorkspacesPushed }: UseSettingsOpts) {
  // THE object. Everything the settings pages render is a read off this.
  const [settings, setSettings] = useState<Settings>(EMPTY_SETTINGS);
  // The same object, readable synchronously. Two callers need that: `persistSettings`
  // (two commits in one tick must both see the first one's work) and App's
  // `readTree`, which runs in the same tick as hydrate at boot, before React has
  // re-rendered. It is a mirror of the state, never a second source — both are
  // written together, in `apply`, and nowhere else.
  const settingsRef = useRef<Settings>(EMPTY_SETTINGS);

  const apply = useCallback((next: Settings) => {
    settingsRef.current = next;
    setSettings(next);
  }, []);

  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const inFlightSavesRef = useRef(0);
  const savedFadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Per-workspace state (NOT settings) ──────────────────────────────────────
  const [dailyNote, setDailyNote] = useState<DailyNote>({ format: 'YYYY-MM-DD', folder: '', templatePath: '' });
  const dailyNoteRef = useSyncRef(dailyNote);
  const [templates, setTemplates] = useState<Templates>({ folder: '' });
  // Per-workspace built-in skill toggles: folderName → 'enabled' | 'disabled'.
  // Absent ⇒ enabled (default-on). Loaded with the workspace; written to its file.
  const [builtinSkills, setBuiltinSkills] = useState<Record<string, 'enabled' | 'disabled'>>({});

  /**
   * Seed the object from a `settings:read` / `settings:changed` payload.
   *
   * ONE line of work, deliberately. It used to be twenty-one assignments fanning
   * this payload into twenty `useState` slices, seven of them guarded on the key
   * being present — and "the key isn't present" is exactly what a companion
   * without that row sends. Every one of those guards was a place the screen
   * could keep a value the server doesn't have.
   */
  const hydrateSettings = useCallback((disk: any) => {
    apply(normalizeSettings(disk));
  }, [apply]);

  /**
   * Forget everything the companion told us.
   *
   * Called when the app is pointed at a DIFFERENT companion (main broadcasts
   * `api:companionChanged` from `api:write`). Not called when one merely goes
   * away: the app keeps working offline, the theme must not flip to system
   * because the wifi dropped, and Settings already refuses to show a synced page
   * while unreachable (`SettingsModal`'s gate). A different server is a different
   * truth; an unreachable one is the same truth, temporarily out of contact.
   */
  const resetSettings = useCallback(() => {
    apply(EMPTY_SETTINGS);
  }, [apply]);

  /**
   * Write the leaves the caller changed, and merge the same patch into the object.
   *
   * A key absent from the patch keeps whatever the store already holds. This used
   * to merge and write the WHOLE settings object — correct when settings were one
   * JSON file, wrong once the store kept one row per key: writing every subtree to
   * change a sidebar width put every unrelated setting, credentials included, in
   * the blast radius of a stale in-memory copy.
   */
  const persistSettings = useCallback(async (next: Partial<Settings>) => {
    const prev = settingsRef.current;
    const patch = dropEmptyCredentials(buildPatch(next, prev));
    // Merge first so the UI moves at once, and so a second commit in the same
    // tick sees the first one's work. Credentials are dropped from what we KEEP,
    // not from what we send — `patch` is already built.
    apply(withoutCredentials({ ...prev, ...next } as Settings, next));
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
      apply(rolled as Settings);
      inFlightSavesRef.current -= 1;
      setSaveStatus('error');
    }
  }, [apply]);

  // Main writes settings on its own — OAuth token refresh, ensureBuiltinSecretSlots
  // — the companion announces its own (`/voice` from the bot, cron), and main
  // re-pushes when it becomes reachable again. Every one of those carries a
  // COMPLETE snapshot, and this re-seeds from it through the same function boot
  // uses, so there is one disk→state mapping rather than a complete one at boot
  // and a partial one on a push.
  //
  // It is a PULL: `hydrateSettings` only seeds; nothing on this path writes, which
  // is what stops the blanks an offline boot invented from ever reaching the
  // companion.
  useEffect(() => {
    const off = window.api.settings.onChanged(({ settings: disk }: { settings: any }) => {
      hydrateSettings(disk);
      // The workspace list lives in App, not here, and boot may have had none to
      // load — so a reconnect can still open a workspace the offline boot couldn't.
      onWorkspacesPushed?.(disk.workspaces ?? [], disk.activeWorkspaceId ?? null);
    });
    return off;
  }, [onWorkspacesPushed, hydrateSettings]);

  // ── Setters ─────────────────────────────────────────────────────────────────
  //
  // Every one of these is now just a write: merge into the object, send the diff.
  // They used to each call a `setX` of their own beside `persistSettings`, which
  // is what made twenty copies exist in the first place.
  //
  // The slice setters MERGE — a caller passes only the leaves it changed and the
  // siblings are filled in HERE, from `settingsRef` (current within the tick;
  // React state lags a render). They used to REPLACE, which made every caller
  // responsible for spreading the rest of the slice back in — a rule invisible at
  // the call site, since `onTranscriptionChange({echoTelegramTranscript})` reads
  // perfectly ordinary. It was got wrong three times: Telegram's echo checkbox
  // blanked both voice providers, `micProvider` was dropped by hydrate, and
  // GitHub's `updateSync` rebuilt the slice without `hasPat` so saving a token hid
  // its own dots.

  const onThemeModeChange = useCallback(async (mode: ThemeMode) => {
    await persistSettings({ appearance: { ...settingsRef.current.appearance, themeMode: mode } });
  }, [persistSettings]);

  const onHideLineNumbersChange = useCallback(async (next: boolean) => {
    await persistSettings({ appearance: { ...settingsRef.current.appearance, hideLineNumbers: next } });
  }, [persistSettings]);

  const onTreePanelChange = useCallback(async (next: TreePanel) => {
    await persistSettings({ appearance: { ...settingsRef.current.appearance, treePanel: next } });
  }, [persistSettings]);

  const onBookmarkFilterActiveChange = useCallback((next: boolean) => {
    persistSettings({ bookmarkFilterActive: next });
  }, [persistSettings]);

  const onShowHiddenFilesChange = useCallback((next: boolean) => {
    persistSettings({ showHiddenFiles: next });
  }, [persistSettings]);

  const onChatSourcesChange = useCallback((next: string[] | null) => {
    persistSettings({ chatSources: next });
  }, [persistSettings]);

  const onTreeSortOrderChange = useCallback(async (next: TreeSortOrder) => {
    await persistSettings({ treeSortOrder: next });
  }, [persistSettings]);

  const onViewModeChange = useCallback(async (next: ViewMode) => {
    await persistSettings({ viewMode: next });
  }, [persistSettings]);

  // Which files are open, per workspace. App debounces the call; the object is the
  // live copy either way.
  const saveOpenTabs = useCallback((workspaceId: string, entry: { paths: string[]; active: string | null }) => {
    if (!workspaceId) return;
    const prev = settingsRef.current.openTabs ?? {};
    if (JSON.stringify(prev[workspaceId]) === JSON.stringify(entry)) return;
    persistSettings({ openTabs: { ...prev, [workspaceId]: entry } });
  }, [persistSettings]);

  const onCodingAgentChange = useCallback(async (patch: Partial<CodingAgentSettings>) => {
    await persistSettings({ codingAgent: { ...settingsRef.current.codingAgent, ...patch } as CodingAgentSettings });
  }, [persistSettings]);

  const onAgentSecretsChange = useCallback(async (next: AgentSecret[]) => {
    await persistSettings({ agentSecrets: next });
  }, [persistSettings]);

  // Re-seed from the store WITHOUT persisting. Mostly redundant now that main
  // pushes `settings:changed` after an OAuth write, but kept as an explicit belt
  // for callers that want to force a pull. Re-reads EVERYTHING, not just the
  // secrets: a partial re-seed is the shape of bug this hook exists to remove.
  const reloadAgentSecrets = useCallback(async () => {
    hydrateSettings(await window.api.settings.read());
  }, [hydrateSettings]);

  const onTranscriptionChange = useCallback(async (patch: Partial<Transcription>) => {
    await persistSettings({ transcription: { ...settingsRef.current.transcription, ...patch } as Transcription });
  }, [persistSettings]);

  const onSpeechChange = useCallback(async (patch: Partial<Speech>) => {
    await persistSettings({ speech: { ...(settingsRef.current.speech ?? {}), ...patch } as Speech });
  }, [persistSettings]);

  // Merges at the TOP level only. `telegram.chatNotice` is a nested object, so a
  // caller changing one of its fields still rebuilds that inner object itself —
  // one level of merging is what a spread does, and a deep-merge here would make
  // clearing a nested field impossible.
  const onTelegramChange = useCallback(async (patch: Partial<TelegramSettings>) => {
    await persistSettings({ telegram: { ...(settingsRef.current.telegram ?? {}), ...patch } as TelegramSettings });
  }, [persistSettings]);

  /**
   * Store one vendor's API key.
   *
   * Sends ONLY the slot being typed into. The companion merges a credential map
   * rather than treating it as complete (`reconcileCredentialMap`), so the other
   * vendors' keys are untouched — and there is nothing to resend, because the
   * renderer never holds a key value.
   *
   * The flag is set here rather than waiting for a push: `persistSettings` drops
   * the value from what it keeps, and `hasVoiceKey` is what the dots render from.
   *
   * Removing is a separate call (`settings:deleteCredential`): an empty value
   * can't carry the intent, since every credential the renderer holds reads as
   * empty and empties are stripped from saves.
   */
  const onVoiceKeyChange = useCallback(async (slug: string, value: string) => {
    if (!slug || !value) return;
    apply({
      ...settingsRef.current,
      hasVoiceKey: { ...(settingsRef.current.hasVoiceKey ?? {}), [slug]: true },
    });
    await persistSettings({ voiceKeys: { [slug]: value } } as Partial<Settings>);
  }, [persistSettings, apply]);

  const onTimezoneChange = useCallback(async (next: string) => {
    await persistSettings({ timezone: next });
  }, [persistSettings]);

  const onSyncChange = useCallback(async (patch: Partial<SyncSettings>) => {
    const next = { ...settingsRef.current.sync, ...patch } as SyncSettings;
    await persistSettings({ sync: next });
    // Restart the engine so PAT / interval changes take effect immediately.
    if (activeWorkspacePath) {
      window.api.sync.engineStart({ workspacePath: activeWorkspacePath, intervalSeconds: next.pullIntervalSeconds }).catch(() => {});
    }
  }, [persistSettings, activeWorkspacePath]);

  // ── Per-workspace writers (`.shockwave/workspace.json`, not settings) ────────

  const onDailyNoteChange = useCallback(async (next: DailyNote) => {
    setDailyNote(next);
    dailyNoteRef.current = next;
    if (activeWorkspacePath) await window.api.workspaceSettings.update(activeWorkspacePath, { dailyNote: next });
  }, [dailyNoteRef, activeWorkspacePath]);

  const onTemplatesChange = useCallback(async (next: Templates) => {
    setTemplates(next);
    if (activeWorkspacePath) await window.api.workspaceSettings.update(activeWorkspacePath, { templates: next });
  }, [activeWorkspacePath]);

  // Seed daily-note + templates from a loaded workspace-data object (called by
  // App's loadWorkspace). Resets to defaults when data is null.
  const loadWorkspaceData = useCallback((data: any) => {
    const dn: DailyNote = {
      format: data?.dailyNote?.format || 'YYYY-MM-DD',
      folder: data?.dailyNote?.folder ?? '',
      templatePath: data?.dailyNote?.templatePath ?? '',
    };
    setDailyNote(dn);
    dailyNoteRef.current = dn;
    setTemplates({ folder: data?.templates?.folder ?? '' });
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

  // ── Reads ───────────────────────────────────────────────────────────────────
  //
  // Named slices, so App and SettingsModal keep the props they always had — but
  // every one is a READ off the single object, not a stored copy. Deriving them
  // here rather than at each call site keeps `settings` the only thing a future
  // field has to be added to.
  const appearance = settings.appearance;
  const reads = useMemo(() => ({
    themeMode: appearance.themeMode,
    hideLineNumbers: appearance.hideLineNumbers,
    treePanel: appearance.treePanel,
  }), [appearance]);

  return {
    // The object itself, for anything that would otherwise want a new slice.
    settings,
    settingsRef,
    ...reads,
    bookmarkFilterActive: settings.bookmarkFilterActive,
    showHiddenFiles: settings.showHiddenFiles,
    chatSources: settings.chatSources,
    treeSortOrder: settings.treeSortOrder,
    viewMode: settings.viewMode,
    codingAgentSettings: settings.codingAgent,
    agentSecrets: settings.agentSecrets,
    transcription: settings.transcription,
    speech: settings.speech ?? {},
    hasVoiceKey: settings.hasVoiceKey ?? {},
    sync: settings.sync,
    telegram: settings.telegram ?? {},
    timezone: settings.timezone,

    // Per-workspace (not settings).
    dailyNote, dailyNoteRef, templates, builtinSkills,

    saveStatus, persistSettings, hydrateSettings, resetSettings, loadWorkspaceData,
    onThemeModeChange, onHideLineNumbersChange, onTreePanelChange,
    onBookmarkFilterActiveChange, onShowHiddenFilesChange, onChatSourcesChange, saveOpenTabs,
    onDailyNoteChange, onTemplatesChange, onBuiltinSkillToggle, onTreeSortOrderChange,
    onViewModeChange,
    onCodingAgentChange, onAgentSecretsChange, reloadAgentSecrets, onTranscriptionChange,
    onSpeechChange, onVoiceKeyChange, onTelegramChange,
    onSyncChange, onTimezoneChange,
  };
}
