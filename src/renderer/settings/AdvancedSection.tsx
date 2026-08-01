import React, { useState } from 'react';
import { SettingsSection, SettingsGroup } from './SectionUI';
import { Button } from '@/components/ui/button';

// Per-workspace maintenance actions that don't belong to any one feature section.
//
// "Rebuild link cache" is the UI for the `fs:rebuildLinkCache` escape hatch:
// it discards the persisted parse cache (userData/link-cache/<hash>.json) and
// re-parses every .md in the active workspace from scratch, then rebuilds the
// in-memory link index. Normally unnecessary — the cache self-validates on
// mtime + size — but it's the recovery path if the index ever drifts from disk
// (e.g. after an external tool rewrites files in ways the watcher missed).
//
// It lives under the WORKSPACE nav group, so it takes no `hasWorkspace`: the
// modal renders `NoWorkspaceNote` in its place when none is open, the same as
// Daily Notes / Templates / Manage Skills. Handling the empty case here as well
// would mean this one page answered "no workspace" with a live page and a dead
// button while its neighbours answered with a sentence.
export default function AdvancedSection({ onRebuildCache }) {
  const [state, setState] = useState('idle'); // 'idle' | 'running' | 'done' | 'error'
  const [count, setCount] = useState(0);

  const onClick = async () => {
    if (state === 'running') return;
    setState('running');
    try {
      const res = await onRebuildCache?.();
      if (res?.ok) {
        setCount(res.count ?? 0);
        setState('done');
      } else {
        setState('error');
      }
    } catch {
      setState('error');
    }
  };

  return (
    <SettingsSection
      title="Advanced"
      description="Maintenance actions for this workspace. You shouldn't normally need these."
    >
      <SettingsGroup title="Link cache">
        <p className="text-xs text-muted-foreground">
          The link index (wiki-links, backlinks, graph) is cached per file and
          re-parses only what changed on each launch. Rebuild it if links,
          backlinks, or the graph ever look out of sync with your files.
        </p>

        <Button
          size="sm"
          className="w-fit"
          onClick={onClick}
          disabled={state === 'running'}
        >
          {state === 'running' ? 'Rebuilding…' : 'Rebuild link cache'}
        </Button>
        {state === 'done' && (
          <p className="text-xs text-primary">
            Rebuilt — re-parsed {count} file{count === 1 ? '' : 's'}.
          </p>
        )}
        {state === 'error' && (
          <p className="text-xs text-destructive">
            Rebuild failed. Check the logs.
          </p>
        )}
      </SettingsGroup>
    </SettingsSection>
  );
}
