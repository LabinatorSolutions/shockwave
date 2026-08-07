import React from 'react';
import { Check, CloudOff, CircleArrowUp } from 'lucide-react';
import { GearIcon, ChevronDownIcon } from './Icons.jsx';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

// Two things about the companion are STATES, not events — they last until
// something is done about them, so they get a persistent indicator here rather
// than a toast that scrolls away. Both sit next to the gear because the only
// thing a user can do about either lives one click away, in Settings.
//
//  - **Unreachable** → `CloudOff`. The server is away; nothing is wrong with the
//    settings on that page, so this must never open a modal or invite the user
//    to retype a URL and key that were correct all along.
//  - **Version mismatch** → `CircleArrowUp`. The server is up and answering, but
//    it and this app are on different releases, so main is refusing every write
//    until they match. A separate icon because it is a separate fact with a
//    separate fix — reusing the cloud would say "away" about a server that is
//    plainly there.
//
// They are mutually exclusive by construction: main clears the version the
// moment the companion goes offline, because a server we can't reach is one
// whose version we no longer know.
//
// **Toast announces, icon holds.** Both conditions also raise a toast in
// `App.tsx`; the toasts are dismissible and these are not, which is the whole
// point of having both — the news can be waved away, the state can't be lost.
export default function WorkspaceSelector({
  workspaces,
  activeWorkspaceId,
  onSwitch,
  onManage,
  onOpenSettings,
  companionOnline = true,
  companionStale = false,
  onOpenCompanion,
  needsSetup = false,
}) {
  const active = workspaces.find((w) => w.id === activeWorkspaceId) || null;
  const badgeLetter = (active?.name ?? '?').trim().charAt(0).toUpperCase() || '?';

  return (
    <div className="flex items-center justify-between border-t border-border px-2.5 py-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className={cn(
              'flex items-center gap-1.5 rounded-md px-1.5 py-1 text-foreground',
              'hover:bg-accent data-[state=open]:bg-accent',
            )}
            title={active ? (active.path ?? `${active.repo} — not on this machine`) : 'No workspace open'}
            aria-label={active ? `Workspace: ${active.name}. Switch workspace` : 'No workspace open. Choose a workspace'}
          >
            {/* Square accent workspace badge (polish spec §4). */}
            <span className="flex size-[18px] items-center justify-center rounded-[5px] bg-primary text-micro font-bold text-primary-foreground">
              {badgeLetter}
            </span>
            <span className="max-w-40 truncate text-sm font-medium">
              {active ? active.name : 'No workspace'}
            </span>
            <ChevronDownIcon size={12} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top" className="w-56">
          {workspaces.length === 0 ? (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">No workspaces yet</div>
          ) : (
            workspaces.map((w) => (
              // Disabled when it can't be opened: no checkout on this machine
              // (selecting it only produced an error), or it's already open
              // (re-selecting re-ran the whole load and destroyed every tab).
              <DropdownMenuItem
                key={w.id}
                onSelect={() => onSwitch(w.id)}
                disabled={!w.path || w.id === activeWorkspaceId}
                title={w.path ?? `${w.repo} — not on this machine`}
              >
                <span className="truncate">{w.name}</span>
                {!w.path && <span className="ml-2 shrink-0 text-micro text-muted-foreground">not here</span>}
                {w.id === activeWorkspaceId && <Check className="ml-auto" />}
              </DropdownMenuItem>
            ))
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onManage}>Manage workspaces…</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <div className="flex shrink-0 items-center gap-0.5">
        {!companionOnline && (
          <button
            className="flex size-[26px] items-center justify-center rounded-[7px] text-destructive hover:bg-accent"
            onClick={onOpenCompanion}
            title="Can't reach your companion server — settings, workspaces, and chats won't update until it's back. Click to review the connection."
            aria-label="Companion server unreachable. Review the connection"
          >
            <CloudOff className="size-[15px]" />
          </button>
        )}
        {companionOnline && companionStale && (
          <button
            className="flex size-[26px] items-center justify-center rounded-[7px] text-destructive hover:bg-accent"
            onClick={onOpenCompanion}
            title="Your server and this app are on different versions — chats and settings won't save until they match. Click to fix it."
            aria-label="Companion server version mismatch. Update to fix"
          >
            <CircleArrowUp className="size-[15px]" />
          </button>
        )}
        {/* The gear carries the dot as well as the pages inside it. Without
            this, "something still needs setting up" is only discoverable by
            opening Settings and looking — which is exactly the state a new
            install is in. */}
        <button
          className="relative flex size-[26px] items-center justify-center rounded-[7px] text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={onOpenSettings}
          title={needsSetup ? 'Settings — something still needs setting up' : 'Settings'}
          aria-label={needsSetup ? 'Open settings. Something still needs setting up' : 'Open settings'}
        >
          <GearIcon size={15} />
          {needsSetup && (
            // Ringed in the sidebar's own background so the dot reads as a badge
            // on the gear rather than a smudge on one of its teeth.
            <span className="absolute right-[3px] top-[3px] size-[6px] rounded-full bg-destructive ring-2 ring-sidebar" aria-hidden="true" />
          )}
        </button>
      </div>
    </div>
  );
}
