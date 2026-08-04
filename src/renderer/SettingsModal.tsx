import React, { useEffect, useState } from 'react';
import CompanionSection from './settings/CompanionSection.jsx';
import TelegramSection from './settings/TelegramSection.jsx';
import { SETTINGS_SECTIONS } from './constants.js';
import { CheckCircleIcon } from './Icons.jsx';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import WorkspacesSection from './settings/WorkspacesSection.jsx';
import GitHubSection from './settings/GitHubSection.jsx';
import GeneralSection from './settings/GeneralSection.jsx';
import AgentChatSection from './settings/AgentChatSection.jsx';
import WorkspaceSkillsSection from './settings/WorkspaceSkillsSection.jsx';
import AgentSecretsSection from './settings/AgentSecretsSection.jsx';
import DailyNoteSection from './settings/DailyNoteSection.jsx';
import TemplatesSection from './settings/TemplatesSection.jsx';
import VoiceSection from './settings/VoiceSection.jsx';
import UpdatesSection from './settings/UpdatesSection.jsx';
import AdvancedSection from './settings/AdvancedSection.jsx';

// Sidebar layout: section headers group related items. Header rows are
// non-interactive labels; item rows are the actual nav buttons. To add a new
// page, drop a new { kind: 'item', id, label } row under the relevant header.
//
// "Workspaces" (the list/create/switch picker) is a GLOBAL concern, so it lives
// under Shockwave — it's not configuration *of* a workspace. The second group
// holds per-(active-)workspace pages and is labeled with the active workspace's
// name so it reads as scoped to it. `workspaceLabel` is passed in at render.
//
// "APIs" is last and holds every page that is really credentials for a third
// party we talk to over the network (our own companion included). Companion
// sitting at the bottom is fine for the offline gate — that pins `active` by id,
// not by position, and the rail doesn't scroll at this height.
function buildNav(workspaceLabel) {
  return [
    { kind: 'header', label: 'Shockwave' },
    { kind: 'item', id: SETTINGS_SECTIONS.GENERAL, label: 'General' },
    { kind: 'item', id: SETTINGS_SECTIONS.WORKSPACES, label: 'Workspaces' },
    { kind: 'item', id: SETTINGS_SECTIONS.UPDATES, label: 'Updates' },
    { kind: 'header', label: workspaceLabel },
    { kind: 'item', id: SETTINGS_SECTIONS.DAILY_NOTE, label: 'Daily Notes' },
    { kind: 'item', id: SETTINGS_SECTIONS.TEMPLATES, label: 'Templates' },
    { kind: 'item', id: SETTINGS_SECTIONS.WORKSPACE_SKILLS, label: 'Manage Skills' },
    // Advanced sits here, not under Shockwave: rebuilding the link cache
    // re-parses the ACTIVE workspace and does nothing without one.
    { kind: 'item', id: SETTINGS_SECTIONS.ADVANCED, label: 'Advanced' },
    { kind: 'header', label: 'AI Agent' },
    { kind: 'item', id: SETTINGS_SECTIONS.AGENT_LLM, label: 'Agent Chat' },
    { kind: 'item', id: SETTINGS_SECTIONS.AGENT_SECRETS, label: 'API Secrets' },
    { kind: 'item', id: SETTINGS_SECTIONS.TELEGRAM, label: 'Telegram' },
    { kind: 'header', label: 'APIs' },
    { kind: 'item', id: SETTINGS_SECTIONS.COMPANION, label: 'Companion' },
    { kind: 'item', id: SETTINGS_SECTIONS.GITHUB, label: 'GitHub Sync' },
    { kind: 'item', id: SETTINGS_SECTIONS.VOICE, label: 'Agent Voice' },
  ];
}

const DEFAULT_SECTION = SETTINGS_SECTIONS.GENERAL;

// Which nav row each `setupStatus` flag badges. Only REQUIRED things are in
// here: a red dot has to mean "the app can't do its job until you deal with
// this", so Telegram, Voice and the per-workspace pages are absent no
// matter how empty they are. Add a row here and you are claiming the app is
// broken without it.
const BADGE_KEY_FOR_SECTION: Record<string, string> = Object.freeze({
  [SETTINGS_SECTIONS.COMPANION]: 'companion',
  [SETTINGS_SECTIONS.GITHUB]: 'github',
  [SETTINGS_SECTIONS.AGENT_LLM]: 'agent',
});

// The pages that stay usable while the companion is unreachable. Companion,
// because it is the fix. Updates, because it is the one page that talks to
// GitHub rather than that server — updating the desktop app has nothing to do
// with the companion being up, and it's where the update pill points, so gating
// it would send anyone whose companion is away to a page about a different
// problem entirely.
const UNGATED_SECTIONS: string[] = Object.freeze([
  SETTINGS_SECTIONS.COMPANION, SETTINGS_SECTIONS.UPDATES,
]) as string[];

// Per-workspace sections need an active workspace. Shown when none is open.
function NoWorkspaceNote() {
  return (
    <div className="px-7 py-6 text-sm text-muted-foreground">
      Open a workspace to configure this.
    </div>
  );
}

export default function SettingsModal({
  open,
  initialSection,
  onClose,
  workspaces,
  activeWorkspaceId,
  onWorkspaceAdded,
  onSwitchWorkspace,
  onRemoveWorkspace,
  onRenameWorkspaces,
  themeMode,
  onThemeModeChange,
  hideLineNumbers,
  onHideLineNumbersChange,
  treePanel,
  onTreePanelChange,
  dailyNote,
  onDailyNoteChange,
  today,
  templates,
  onTemplatesChange,
  templateOptions,
  builtinSkills,
  onBuiltinSkillToggle,
  tree,
  workspacePath,
  codingAgent,
  onCodingAgentChange,
  agentSecrets,
  onAgentSecretsChange,
  onReloadSecrets,
  transcription,
  onTranscriptionChange,
  telegram,
  onTelegramChange,
  speech,
  onSpeechChange,
  hasVoiceKey,
  onVoiceKeyChange,
  voiceReply,
  onVoiceReplyChange,
  sync,
  onSyncChange,
  timezone,
  onTimezoneChange,
  onRebuildCache,
  appUpdate,
  saveStatus,
  setupStatus,
  companionOnline = true,
}) {
  const [active, setActive] = useState(initialSection || DEFAULT_SECTION);

  // This modal is PERMANENTLY MOUNTED and driven by `open` (see the Dialog
  // below for why). So `active` survives between visits and the section to land
  // on has to be re-applied on the OPEN TRANSITION — the useState initializer
  // above runs once, at app start, and never again. Without this, every deep
  // link (the sidebar's CloudOff → Companion, Workspaces → GitHub Sync) would
  // land on whatever page you happened to close Settings on last time.
  useEffect(() => {
    if (open) setActive(initialSection || DEFAULT_SECTION);
  }, [open, initialSection]);

  // The live feed is the gate. Every other page reads/writes through the STORED
  // connection, which is exactly what the feed exercises — so `companionOnline`
  // is the one signal, known synchronously (App seeds it before the modal
  // mounts; there is no "still checking" window). The Companion page's own
  // probe is diagnostics for the human (WHAT is wrong), never the gate.
  //
  // An earlier design also gated on the probe's result (`apiReady`), which made
  // two independent assessments of the same server: the feed could still be
  // backing off (up to 30s) after a successful Connect, so the nav sat disabled
  // beside a green "Connected" row. And it gated on draft edits, which is
  // wrong — other pages talk to the stored config, not the boxes.
  const gated = !companionOnline;
  const effectiveActive = gated && !UNGATED_SECTIONS.includes(active)
    ? SETTINGS_SECTIONS.COMPANION
    : active;

  // Move `active` itself, not only the derived value: otherwise the instant the
  // gate releases (the feed opens after Approve/Connect) the page would jump
  // away from Companion to whatever `active` still pointed at, mid-task. Deep
  // links survive because this only runs while gated — every target section is
  // disabled then anyway.
  useEffect(() => {
    if (gated && !UNGATED_SECTIONS.includes(active)) {
      setActive(SETTINGS_SECTIONS.COMPANION);
    }
  }, [gated, active]);

  const activeWs = (workspaces || []).find((w) => w.id === activeWorkspaceId);
  const workspaceLabel = activeWs ? `Workspace · ${activeWs.name}` : 'Workspace';
  const NAV = buildNav(workspaceLabel);

  // `open` is a PROP, and this component is never conditionally mounted — App
  // renders it unconditionally. Both halves of that are load-bearing. Radix's
  // modal layer sets `pointer-events: none` on <body> while open and takes it
  // off in its close sequence; unmounting an open Dialog skips that sequence
  // entirely and the style sticks. The whole app then ignores every click while
  // continuing to render and tick normally — it reads as a total freeze, and the
  // keyboard still working is the tell. Never go back to `<Dialog open>` behind
  // a `{isOpen && …}` mount.
  return (
    <Dialog open={!!open} onOpenChange={(next) => { if (!next) onClose(); }}>
      {/* Height is set by the NAV, not the content pane: 17 rows (13 items + 4
          group headers) measure ~625px, so 620 clipped it by a hair and the left
          rail scrolled. 720 fits the rail outright with room for a few more
          sections. The rail keeps overflow-y-auto for short viewports, where
          max-h-[85vh] wins regardless. */}
      <DialogContent className="flex h-[720px] max-h-[85vh] w-[780px] max-w-[92vw] gap-0 overflow-hidden p-0 sm:max-w-[780px]">
        <DialogHeader className="sr-only">
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>Application settings</DialogDescription>
        </DialogHeader>
        {saveStatus && saveStatus !== 'idle' && (
          <div
            className={cn(
              'absolute right-12 top-3.5 z-10 flex items-center gap-1.5 text-xs',
              saveStatus === 'error' ? 'text-destructive' : 'text-muted-foreground',
              saveStatus === 'saved' && 'text-success',
            )}
          >
            {saveStatus === 'saving' && <span>Saving…</span>}
            {saveStatus === 'error' && <span>Save failed</span>}
            {saveStatus === 'saved' && (
              <>
                <CheckCircleIcon size={14} />
                <span>Saved</span>
              </>
            )}
          </div>
        )}
        <nav className="flex w-[216px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-border bg-sidebar p-2.5 pt-4">
          {NAV.map((row, idx) => {
            if (row.kind === 'header') {
              return (
                <div
                  key={`h-${idx}`}
                  className={cn(
                    'px-3 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.09em] text-muted-2',
                    idx === 0 ? 'pt-1.5' : 'pt-4',
                  )}
                >
                  {row.label}
                </div>
              );
            }
            const disabled = gated && !UNGATED_SECTIONS.includes(row.id ?? '');
            const badgeKey = BADGE_KEY_FOR_SECTION[row.id ?? ''];
            const needsSetup = !!(badgeKey && setupStatus?.[badgeKey]);
            return (
              <button
                key={row.id}
                disabled={disabled}
                title={disabled ? 'Connect to your server first' : undefined}
                className={cn(
                  'flex items-center gap-2 rounded-lg px-3 py-[7px] text-left text-[13px] text-foreground/75 hover:bg-accent',
                  effectiveActive === row.id && 'bg-selected font-medium text-selected-foreground hover:bg-selected',
                  disabled && 'cursor-not-allowed opacity-40 hover:bg-transparent',
                )}
                onClick={() => { if (!disabled) setActive(row.id); }}
                aria-current={effectiveActive === row.id ? 'page' : undefined}
              >
                <span className="truncate">{row.label}</span>
                {needsSetup && (
                  <>
                    {/* The dot says WHERE, the page says what. Two badge shapes
                        (empty vs rejected) would be a vocabulary in a 216px rail
                        that nobody learns; there's room for a sentence on the
                        page and none here. */}
                    <span className="ml-auto size-[7px] shrink-0 rounded-full bg-destructive" aria-hidden="true" />
                    <span className="sr-only">needs setup</span>
                  </>
                )}
              </button>
            );
          })}
        </nav>
        <div className="min-w-0 flex-1 overflow-y-auto">
          {effectiveActive === SETTINGS_SECTIONS.COMPANION && (
            <CompanionSection />
          )}
          {effectiveActive === SETTINGS_SECTIONS.GENERAL && (
            <GeneralSection
              themeMode={themeMode}
              onThemeModeChange={onThemeModeChange}
              hideLineNumbers={hideLineNumbers}
              onHideLineNumbersChange={onHideLineNumbersChange}
              treePanel={treePanel}
              onTreePanelChange={onTreePanelChange}
              timezone={timezone}
              onTimezoneChange={onTimezoneChange}
            />
          )}
          {effectiveActive === SETTINGS_SECTIONS.WORKSPACES && (
            <WorkspacesSection
              workspaces={workspaces}
              activeWorkspaceId={activeWorkspaceId}
              onWorkspaceAdded={(id) => { onWorkspaceAdded(id); onClose(); }}
              onSwitch={(id) => { onSwitchWorkspace(id); onClose(); }}
              onRemove={onRemoveWorkspace}
              onRename={onRenameWorkspaces}
              hasSyncPat={!!sync?.hasPat}
              onOpenGitHubSettings={() => setActive(SETTINGS_SECTIONS.GITHUB)}
            />
          )}
          {effectiveActive === SETTINGS_SECTIONS.GITHUB && (
            <GitHubSection sync={sync} onSyncChange={onSyncChange} />
          )}
          {/* Per-workspace config — applies to the ACTIVE workspace, stored in
              its `.shockwave/workspace.json`. */}
          {effectiveActive === SETTINGS_SECTIONS.DAILY_NOTE && (
            workspacePath ? (
              <DailyNoteSection
                dailyNote={dailyNote}
                onDailyNoteChange={onDailyNoteChange}
                tree={tree}
                workspacePath={workspacePath}
                today={today}
                templateOptions={templateOptions}
              />
            ) : <NoWorkspaceNote />
          )}
          {effectiveActive === SETTINGS_SECTIONS.TEMPLATES && (
            workspacePath ? (
              <TemplatesSection
                templates={templates}
                onTemplatesChange={onTemplatesChange}
                tree={tree}
                workspacePath={workspacePath}
              />
            ) : <NoWorkspaceNote />
          )}
          {effectiveActive === SETTINGS_SECTIONS.WORKSPACE_SKILLS && (
            workspacePath ? (
              <WorkspaceSkillsSection
                workspacePath={workspacePath}
                builtinSkills={builtinSkills}
                onBuiltinSkillToggle={onBuiltinSkillToggle}
              />
            ) : <NoWorkspaceNote />
          )}
          {effectiveActive === SETTINGS_SECTIONS.ADVANCED && (
            workspacePath ? <AdvancedSection onRebuildCache={onRebuildCache} /> : <NoWorkspaceNote />
          )}
          {effectiveActive === SETTINGS_SECTIONS.VOICE && (
            <VoiceSection
              transcription={transcription}
              onTranscriptionChange={onTranscriptionChange}
              speech={speech}
              onSpeechChange={onSpeechChange}
              hasVoiceKey={hasVoiceKey}
              onVoiceKeyChange={onVoiceKeyChange}
              voiceReply={voiceReply}
              onVoiceReplyChange={onVoiceReplyChange}
              hasWorkspace={!!workspacePath}
            />
          )}
          {effectiveActive === SETTINGS_SECTIONS.UPDATES && (
            <UpdatesSection appUpdate={appUpdate} />
          )}
          {effectiveActive === SETTINGS_SECTIONS.AGENT_LLM && (
            <AgentChatSection
              codingAgent={codingAgent}
              onCodingAgentChange={onCodingAgentChange}
            />
          )}
          {effectiveActive === SETTINGS_SECTIONS.AGENT_SECRETS && (
            <AgentSecretsSection
              secrets={agentSecrets ?? []}
              onChange={onAgentSecretsChange}
              onReload={onReloadSecrets}
            />
          )}
          {effectiveActive === SETTINGS_SECTIONS.TELEGRAM && (
            <TelegramSection
              workspaces={workspaces}
              transcription={transcription}
              onTranscriptionChange={onTranscriptionChange}
              telegram={telegram}
              onTelegramChange={onTelegramChange}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
