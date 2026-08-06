import React, { useState } from 'react';
import { APP_NAME } from '../constants.js';
import { SettingsSection } from './SectionUI';
import ReleaseNotesDialog from '../ReleaseNotesDialog.js';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

// Settings → General → Updates. **This is where the pill points**, so it carries
// the whole story rather than just a check button: the running version, what
// phase the update is in, what's new, and the one action that phase allows.
//
// ONE primary slot, filled by whatever the top action is for the phase — Check →
// Download → Restart. Check keeps its own button beside Download (demoted to
// outline) while an update is merely `available`, because that is the one phase
// where re-checking both means something and is allowed: main's runUpdateCheck
// returns early once we're `downloading` or `ready` (a re-check would walk the
// phase back to `available` and lose the Restart button), so a Check button
// there would be a control that does nothing. Without this the only way to
// re-poll a pending update was to restart the app.
//
// Nothing on this page downloads or installs on its own; see the block comment
// in main.ts for why both of electron-updater's self-driving flags are off.
export default function UpdatesSection({ appUpdate }) {
  const { status, checking, check, download, unsnooze, requestRestart } = appUpdate;
  const [checkedOnce, setCheckedOnce] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);

  const onCheck = async () => {
    await check();
    setCheckedOnce(true);
  };

  const current = status?.current;
  const phase = status?.phase ?? 'idle';
  const latest = status?.latest;
  const snoozed = !!latest && status?.snoozedVersion === latest;

  // Result line. Silent until there is something to say — a page that reads
  // "you're on the latest version" before anything has been checked is guessing.
  let result: string | null = null;
  if (checking) {
    result = 'Checking…';
  } else if (phase === 'downloading') {
    // No percent here — the button is already counting it, and two live numbers
    // one above the other read as two different things happening.
    result = `Downloading version ${latest}…`;
  } else if (phase === 'ready') {
    result = `Version ${latest} is downloaded. It installs when you restart.`;
  } else if (phase === 'available') {
    result = `Version ${latest} is available.`;
  } else if (phase === 'error') {
    result = `Couldn't check for updates (${status.error}).`;
  } else if (checkedOnce) {
    result = "You're on the latest version.";
  }

  // The primary action for the phase we're in. `available` in a dev build has no
  // downloader behind it, so it offers the release page instead of pretending.
  let primary: React.ReactNode;
  if (phase === 'ready') {
    primary = <Button size="sm" onClick={requestRestart}>Restart to update</Button>;
  } else if (phase === 'downloading') {
    primary = <Button size="sm" disabled>Downloading… {status.percent}%</Button>;
  } else if (phase === 'available' && status?.canDownload) {
    primary = <Button size="sm" onClick={download}>Download version {latest}</Button>;
  } else if (phase === 'available' && status?.url) {
    primary = (
      <Button size="sm" onClick={() => window.api.openExternal(status.url)}>View release</Button>
    );
  }

  // Check rides along in `available` as the secondary. Only IT disables while a
  // check is in flight — the download decision has nothing to wait for.
  const checkButton = (
    <Button
      size="sm"
      variant={primary ? 'outline' : 'default'}
      onClick={onCheck}
      disabled={checking}
    >
      {primary ? 'Check again' : 'Check for updates'}
    </Button>
  );

  return (
    <SettingsSection
      title="Updates"
      description={`${APP_NAME} checks for new versions automatically, then waits for you. Nothing downloads or installs until you say so.`}
    >
      <div className="text-sm text-foreground">
        Current version: {current ? `v${current}` : '—'}
      </div>

      <div className="flex w-fit items-center gap-2">
        {primary}
        {phase !== 'downloading' && phase !== 'ready' && checkButton}
      </div>

      {result && (
        <p className={cn('text-xs', phase === 'error' ? 'text-destructive' : phase === 'available' || phase === 'ready' ? 'text-primary' : 'text-muted-foreground')}>
          {result}
        </p>
      )}

      {(phase === 'available' || phase === 'downloading' || phase === 'ready') && (
        <button
          type="button"
          className="w-fit text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
          onClick={() => setNotesOpen(true)}
        >
          What's new
        </button>
      )}

      {/* Only shown once it's true. Dismissing the toast is a decision about one
          version, and this is the one place that can undo it — without it, the
          setting would be invisible and permanent. */}
      {snoozed && (
        <p className="text-xs text-muted-foreground">
          Notifications for v{latest} are turned off.{' '}
          <button
            type="button"
            className="underline underline-offset-4 hover:text-foreground"
            onClick={unsnooze}
          >
            Turn them back on
          </button>
        </p>
      )}

      <ReleaseNotesDialog open={notesOpen} onClose={() => setNotesOpen(false)} current={current} />
    </SettingsSection>
  );
}
