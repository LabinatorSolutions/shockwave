import React, { useState } from 'react';
import { FolderOpen, Plus, Trash2, X, FileCog, Pencil } from 'lucide-react';
import { toast } from 'sonner';
import ConfirmDialog from '../ConfirmDialog.jsx';
import AddWorkspaceDialog from './AddWorkspaceDialog';
import { SettingsSection, SettingsGroup } from './SectionUI';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import ErrorMessage from '../ErrorMessage.jsx';

// Workspaces — just the list and the ways in and out of it. The account, the
// sync interval, and the git check live in GitHubSection: none of them is per
// workspace, and stacking three global controls above the list pushed the
// workspaces themselves below the fold.
//
// The PAT is still required to add one. What the old split got wrong wasn't
// that the token lived elsewhere — it's that this page left you to find it on
// your own. The Add button is disabled without a token, with a link to the
// GitHub Sync section right above it.
//
// **It gates on `hasSyncPat`, never on the token itself.** Credential fields are
// write-only: main strips `sync.pat` before settings cross IPC and substitutes
// the `hasPat` flag, so the value is `undefined` in the renderer whether or not
// one is stored. This shipped as `!syncPat?.trim()` and so was disabled for
// everyone, permanently — with a "a GitHub token is required" note above it
// aimed at people who already had one. Same mistake the Verify button made
// (see "Verifying a credential" in settings/CLAUDE.md); anything asking "is
// this credential set?" asks the presence flag.

// The two default files whose default is EMPTY, so "restore" means "erase".
// Spelled out here rather than imported from `agent-core/defaults/files.ts`:
// that module imports `node:fs`, which the renderer has no access to. The
// whole-set confirmation below already names them in prose for the same reason.
// If a third memory file is ever added to the manifest, it belongs here too —
// the cost of missing it is a dialog that promises a restore and performs a
// deletion.
const USER_FILE = 'USER.md';
const MEMORY_FILES = ['MEMORY.md', USER_FILE];
const isMemoryFile = (name: string) => MEMORY_FILES.includes(name);

export default function WorkspacesSection({
  workspaces,
  activeWorkspaceId,
  onWorkspaceAdded,
  onSwitch,
  onRemove,
  onRename,
  // PRESENCE, not the value. Credentials are write-only — main strips `sync.pat`
  // before settings cross IPC and substitutes `hasPat` — so a check against the
  // value is a check against `undefined` and this button could never enable.
  hasSyncPat,
  onOpenGitHubSettings,
}) {
  const [confirmRemoveId, setConfirmRemoveId] = useState<any>(null);
  const [renamingId, setRenamingId] = useState<any>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [settingUpId, setSettingUpId] = useState<any>(null);
  // One error slot per row, for both setup and sync-toggle failures — they're
  // the same kind of thing to the user ("this row's action failed") and having
  // two meant one could silently replace the other.
  const [rowError, setRowError] = useState<any>(null);
  const [addOpen, setAddOpen] = useState(false);

  // The workspace default files (SOUL.md, AGENTS.md, MEMORY.md, USER.md,
  // .ignore, .gitignore). Both creation paths seed them; this is the manual
  // half, for workspaces that predate one being added to the set.
  const [confirmResetWs, setConfirmResetWs] = useState<any>(null);
  // Restoring ONE file, once we know it's already there and about to be
  // overwritten: `{ ws, name, purpose }`.
  const [confirmFile, setConfirmFile] = useState<any>(null);
  // What the open row's menu is listing. One slot, not a map keyed by
  // workspace — only one dropdown can be open at a time, and a map would keep
  // serving a list from whenever that row was last opened.
  const [fileMenu, setFileMenu] = useState<any>(null);

  const target = workspaces.find((w) => w.id === confirmRemoveId) ?? null;

  // The manifest is the app's, not the repo's, so the menu is built from what
  // main reports rather than from anything on disk — `files` is every default
  // and `missing` is the subset this workspace hasn't got. Read when the menu
  // opens, so a file restored (or deleted in Finder) since last time is
  // reflected without a settings reload.
  const loadFileList = async (ws: any) => {
    setFileMenu({ id: ws.id, files: null, missing: [] });
    try {
      const res = await window.api.workspace.listFiles({ workspacePath: ws.path });
      if (!res?.ok) {
        setFileMenu({ id: ws.id, files: [], missing: [], error: res?.error });
        return;
      }
      setFileMenu({ id: ws.id, files: res.files ?? [], missing: res.missing ?? [] });
    } catch {
      // Nothing to report here — the menu shows that it couldn't list them, and
      // the two whole-set actions below it still work.
      setFileMenu({ id: ws.id, files: [], missing: [] });
    }
  };

  // `overwrite` replaces; without it the write is fail-if-exists, so the safe
  // action can't destroy anything and needs no confirm. `names` narrows both to
  // part of the manifest — how one file is restored on its own.
  const writeDefaultFiles = async (ws: any, overwrite: boolean, names?: string[]) => {
    setRowError(null);
    try {
      const res = await window.api.workspace.ensureFiles({ workspacePath: ws.path, overwrite, names });
      if (!res?.ok) {
        setRowError({ id: ws.id, error: res?.error ?? 'Could not write the default files.' });
        return;
      }
      const written = res.written ?? [];
      toast(
        written.length === 0
          ? names?.length
            ? `${names.join(', ')} is already there in ${ws.name}.`
            : `${ws.name} already has every default file.`
          : `${overwrite ? 'Restored' : 'Added'} ${written.join(', ')} in ${ws.name}.`,
      );
    } catch (err: any) {
      setRowError({ id: ws.id, error: err?.message ?? 'Could not write the default files.' });
    } finally {
      // The list this menu was built from is now stale about what's missing.
      setFileMenu(null);
    }
  };

  // Picking one file out of the submenu. A file that ISN'T there has nothing to
  // lose, so it's written straight away — and written fail-if-exists rather than
  // overwriting, so if the list has gone stale in the seconds since it was read
  // (the agent writes these files too) the worst case is that nothing happens,
  // not that a live file is replaced without being asked about.
  const restoreOneFile = (ws: any, file: any) => {
    if (fileMenu?.missing?.includes(file.name)) { writeDefaultFiles(ws, false, [file.name]); return; }
    setConfirmFile({ ws, ...file });
  };

  // Renames go through the normal settings save — `updateWorkspaces` applies
  // name + order and can't create or delete, so sending the list is safe.
  const commitRename = () => {
    const id = renamingId;
    setRenamingId(null);
    const next = renameDraft.trim();
    if (!id || !next) return;
    const cur = workspaces.find((w) => w.id === id);
    if (!cur || cur.name === next) return;
    onRename?.(workspaces.map((w) => (w.id === id ? { ...w, name: next } : w)));
  };

  // Main owns the column, reconciles the engine (only if this is the active
  // workspace), and pushes the updated list back — so there's nothing to mirror
  // here. A failure has to SAY so: this used to be `if (res?.ok)` with no else,
  // so a failed toggle just snapped the switch back with no explanation.
  const setSyncEnabled = async (ws: any, enabled: boolean) => {
    setRowError(null);
    try {
      const res = await window.api.sync.setWorkspaceDisabled({ workspacePath: ws.path, disabled: !enabled });
      if (!res?.ok) setRowError({ id: ws.id, error: res?.error ?? 'Could not change sync for this workspace.' });
    } catch (err: any) {
      setRowError({ id: ws.id, error: err?.message ?? 'Could not change sync for this workspace.' });
    }
  };

  // Clone (or attach) a workspace that exists but has no folder on this box.
  const setUpHere = async (ws: any) => {
    // Claim the row BEFORE the picker opens — it's an await, and without this
    // the button stays live long enough to open two pickers.
    if (settingUpId) return;
    setSettingUpId(ws.id);
    const dir = await window.api.openFolder();
    if (!dir) { setSettingUpId(null); return; }
    const res = await window.api.workspace.setUpHere({ id: ws.id, workspacePath: dir });
    setSettingUpId(null);
    if (!res.ok) { setRowError({ id: ws.id, error: res.error }); return; }
    setRowError(null);
    // No switch. Main pushes the updated list, so the row refreshes on its own —
    // checking a workspace out on this machine shouldn't yank you out of the
    // one you're currently in, which is what routing this through the add
    // callback used to do (it also closed Settings).
  };

  const renderRow = (ws: any) => {

    // No path = the workspace exists but isn't checked out on this machine
    // (a DB from another machine, or a folder that went missing). It stays in
    // the list — hiding it would lose a repo you still own.
    const here = !!ws.path;
    return (
      <li
        key={ws.id}
        className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2.5"
      >
        <div className="min-w-0 flex-1">
          {/* Name is the only editable field. The repo is the workspace's
              identity and the path is where it was cloned — neither is a
              rename, they'd be a different workspace.

              THE TWO STATES ARE SIZED TO MATCH, which is what these classes are
              for rather than taste. The resting state was bare text on a 20px
              line and the input is 28px, so clicking the name grew the row and
              shunted the path down under it — the click read as having hit
              something, not as having opened the field that replaced it. Both
              are `h-7` now with the same padding, and both are pulled left by
              the same `-mx-2` so the NAME TEXT sits in the same column either
              way: the field appears around the word instead of moving it. The
              input compensates for that negative margin in its width (`w-full`
              would otherwise overflow the row by exactly `mx-2`), and the button
              carries a transparent border so the input's 1px doesn't nudge the
              text either. Change one of these and change the other. */}
          {renamingId === ws.id ? (
            <Input
              autoFocus
              aria-label="Workspace name"
              value={renameDraft}
              onChange={(e) => setRenameDraft(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename();
                if (e.key === 'Escape') setRenamingId(null);
              }}
              className="-mx-2 h-7 w-[calc(100%+1rem)] px-2 text-sm"
            />
          ) : (
            <button
              type="button"
              className="group/name -mx-2 flex h-7 max-w-full items-center gap-1.5 rounded-md border border-transparent px-2 text-left text-sm font-medium hover:bg-accent"
              onClick={() => { setRenamingId(ws.id); setRenameDraft(ws.name); }}
              title="Rename"
              aria-label={`Rename ${ws.name}`}
            >
              <span className="min-w-0 truncate">{ws.name}</span>
              {/* Dimmed rather than hover-only: a control nobody can see until
                  they happen to hover it is one most people never find, and
                  "this name is editable" is not guessable from text alone. */}
              <Pencil className="size-3 shrink-0 text-muted-foreground opacity-60 transition-opacity group-hover/name:opacity-100" />
            </button>
          )}
          <div className="truncate font-mono text-xs text-muted-2" title={ws.path || ws.repo}>
            {here ? ws.path : `${ws.repo} — not on this machine`}
          </div>
          {rowError?.id === ws.id && (
            <div className="mt-1.5 flex items-start gap-2" role="alert">
              <ErrorMessage className="flex-1">{rowError.error}</ErrorMessage>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => setRowError(null)}
                aria-label="Dismiss error"
                title="Dismiss"
              >
                <X />
              </Button>
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2.5">
          {/* The engine is a singleton bound to the ACTIVE workspace, so a
              switch left on does nothing until that workspace is opened — the
              tooltip carries that, since the label has no room for it.
              Not error handling either: a failing sync retries on its own and
              never lands here. Meaningless without a checkout. */}
          {here && (
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground" title="Sync to GitHub while this workspace is open">
              <Switch
                checked={ws.syncEnabled}
                onCheckedChange={(v) => setSyncEnabled(ws, v)}
                aria-label={`Sync ${ws.name} to GitHub`}
              />
              Sync
            </label>
          )}
          {here ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => onSwitch(ws.id)}
              disabled={ws.id === activeWorkspaceId}
            >
              Open
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setUpHere(ws)}
              disabled={settingUpId === ws.id}
            >
              <FolderOpen /> {settingUpId === ws.id ? 'Setting up…' : 'Set up here'}
            </Button>
          )}
          {/* Meaningless without a checkout — there's no folder to write to. */}
          {here && (
            <DropdownMenu onOpenChange={(open) => { if (open) loadFileList(ws); }}>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground"
                  title="Default files"
                  aria-label={`Default files for ${ws.name}`}
                >
                  <FileCog />
                </Button>
              </DropdownMenuTrigger>
              {/* Safe action first, destructive last — the same order every other
                  menu in the app uses, and the reason the whole-set restore isn't
                  sitting where the pointer lands when the menu opens. */}
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => writeDefaultFiles(ws, false)}>
                  Add missing files
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>Restore a specific file</DropdownMenuSubTrigger>
                  {/* Each row carries the file's PURPOSE, because the names alone
                      don't say what restoring one costs — `.ignore` is a file
                      nobody would miss and `MEMORY.md` is everything the agent has
                      learned, and they look equally harmless as a list of names. */}
                  <DropdownMenuSubContent className="w-72">
                    {fileMenu?.id !== ws.id || fileMenu.files === null ? (
                      <DropdownMenuItem disabled>Reading the workspace…</DropdownMenuItem>
                    ) : fileMenu.files.length === 0 ? (
                      <DropdownMenuItem disabled>Could not list the default files.</DropdownMenuItem>
                    ) : (
                      fileMenu.files.map((f: any) => {
                        const absent = fileMenu.missing.includes(f.name);
                        return (
                          <DropdownMenuItem
                            key={f.name}
                            onSelect={() => restoreOneFile(ws, f)}
                            className="flex-col items-start gap-0.5"
                          >
                            <span className="flex w-full items-center justify-between gap-3">
                              <span className="font-mono text-xs">{f.name}</span>
                              {absent && <span className="text-xs text-muted-foreground">missing</span>}
                            </span>
                            <span className="text-xs text-muted-foreground">{f.purpose}</span>
                          </DropdownMenuItem>
                        );
                      })
                    )}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={() => setConfirmResetWs(ws)}>
                  Restore all files…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground hover:text-destructive"
            onClick={() => setConfirmRemoveId(ws.id)}
            title={`Remove ${ws.name}`}
            aria-label={`Remove ${ws.name}`}
          >
            <Trash2 />
          </Button>
        </div>
      </li>
    );
  };

  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId) ?? null;
  const otherWorkspaces = workspaces.filter((w) => w.id !== activeWorkspaceId);

  return (
    <SettingsSection
      wide
      title="Workspaces"
      description="Each workspace is a GitHub repository with a copy on this machine."
    >
      <SettingsGroup>
        <div>
          {/* The page's single primary action — row actions stay outline/ghost. */}
          {/* The gate is stated BEFORE the button and the button is dead, so
              the requirement is visible without clicking into a dialog to be
              told. The old split's failure was leaving people to discover the
              token requirement on their own. */}
          {!hasSyncPat && (
            <p className="mb-2 text-sm text-muted-foreground">
              A GitHub token is required.{' '}
              <button
                type="button"
                className="text-primary hover:underline"
                onClick={() => onOpenGitHubSettings?.()}
              >Add one in GitHub Sync settings</button>.
            </p>
          )}
          <Button size="sm" onClick={() => setAddOpen(true)} disabled={!hasSyncPat}>
            <Plus /> Add workspace
          </Button>
        </div>
      </SettingsGroup>

      {workspaces.length === 0 ? (
        <SettingsGroup>
          <p className="text-sm text-muted-foreground">No workspaces yet.</p>
        </SettingsGroup>
      ) : (
        <>
          {activeWorkspace && (
            <SettingsGroup title="Active workspace">
              <ul className="m-0 flex list-none flex-col gap-2 p-0">{renderRow(activeWorkspace)}</ul>
            </SettingsGroup>
          )}
          {otherWorkspaces.length > 0 && (
            <SettingsGroup title="Other workspaces">
              <ul className="m-0 flex list-none flex-col gap-2 p-0">{otherWorkspaces.map(renderRow)}</ul>
            </SettingsGroup>
          )}
        </>
      )}

      <ConfirmDialog
        open={!!target}
        title="Remove workspace"
        message={target ? `Remove "${target.name}"? The folder on disk and the GitHub repo are both kept.` : ''}
        confirmLabel="Remove"
        destructive
        onConfirm={() => { onRemove(confirmRemoveId); setConfirmRemoveId(null); }}
        onClose={() => setConfirmRemoveId(null)}
      />

      {/* Names the files, because the destructive part is specific: the repo
          makes this recoverable, but only for what's already COMMITTED — an
          edit made since the last sync tick has no git copy to come back
          from. */}
      <ConfirmDialog
        open={!!confirmResetWs}
        title="Reset default files"
        message={confirmResetWs
          // MEMORY.md and USER.md are named explicitly because a reset EMPTIES
          // them, and what they hold is not something the user wrote and can
          // retype — it is everything the agent has learned about them.
          ? `Replace SOUL.md, AGENTS.md, .ignore, and .gitignore in "${confirmResetWs.name}" with the current defaults, and empty MEMORY.md and USER.md — everything the agent has learned about you and this workspace? Any edits you've made are overwritten — committed versions stay in the repo's history, but changes since the last sync are lost.`
          : ''}
        confirmLabel="Restore all"
        destructive
        onConfirm={() => { writeDefaultFiles(confirmResetWs, true); setConfirmResetWs(null); }}
        onClose={() => setConfirmResetWs(null)}
      />

      {/* Restoring ONE file asks separately, because the answer is genuinely
          different per file — and for two of them the word "restore" is wrong
          about what happens. `.ignore` is app boilerplate nobody edits; SOUL.md
          is usually tuned by hand; MEMORY.md and USER.md have a BLANK default,
          so restoring them is an erase, and a dialog that said "replace with the
          default" would be technically true and completely misleading. */}
      <ConfirmDialog
        open={!!confirmFile}
        title={confirmFile && isMemoryFile(confirmFile.name) ? `Empty ${confirmFile.name}` : `Restore ${confirmFile?.name ?? ''}`}
        message={confirmFile
          ? isMemoryFile(confirmFile.name)
            ? `Empty ${confirmFile.name} in "${confirmFile.ws.name}"? This file starts blank, so restoring it erases ${confirmFile.name === USER_FILE ? 'everything the agent has learned about you' : 'everything the agent has learned about working here'}. The committed version stays in the repo's history, but anything learned since the last sync is lost.`
            : `Replace ${confirmFile.name} in "${confirmFile.ws.name}" with the app's default? Any edits you've made to it are overwritten — the committed version stays in the repo's history, but changes since the last sync are lost.`
          : ''}
        confirmLabel={confirmFile && isMemoryFile(confirmFile.name) ? 'Empty it' : 'Restore it'}
        destructive
        onConfirm={() => { writeDefaultFiles(confirmFile.ws, true, [confirmFile.name]); setConfirmFile(null); }}
        onClose={() => setConfirmFile(null)}
      />

      <AddWorkspaceDialog
        open={addOpen}
        onAdded={onWorkspaceAdded}
        onClose={() => setAddOpen(false)}
      />
    </SettingsSection>
  );
}
