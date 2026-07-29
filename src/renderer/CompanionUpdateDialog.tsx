import React, { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import Dialog from './Dialog.js';
import { Button } from '@/components/ui/button';

const INSTALL_CMD = 'curl -fsSL https://raw.githubusercontent.com/stephengpope/shockwave/main/api/install.sh | sh';
const POLL_MS = 3000;
const TIMEOUT_MS = 3 * 60 * 1000;

// Confirm-and-run flow for upgrading the companion server to this desktop's
// version. The heavy lifting happens server-side (POST /update -> the updater
// sidecar); this dialog fires the request, then polls api:checkVersion until
// the companion comes back on the new version (it restarts mid-way, so
// 'unreachable' during the poll is expected). Rendered by App.tsx (boot check)
// and CompanionSection (manual).
export default function CompanionUpdateDialog({
  open,
  onClose,
  desktop,
  companion,
  onUpdated,
}: {
  open: boolean;
  onClose: () => void;
  desktop?: string;
  companion?: string;
  onUpdated?: () => void;
}) {
  const [phase, setPhase] = useState<'confirm' | 'updating' | 'unavailable' | 'error'>('confirm');
  const [error, setError] = useState('');
  // Cancels the poll loop when the dialog closes/unmounts mid-update. The
  // server finishes the upgrade regardless; the next version check sees it.
  const runRef = useRef(0);

  useEffect(() => {
    if (open) { setPhase('confirm'); setError(''); }
    else runRef.current++;
  }, [open]);
  useEffect(() => () => { runRef.current++; }, []);

  const onUpgrade = async () => {
    setPhase('updating');
    const run = ++runRef.current;
    const r = await window.api.settings.apiUpgradeCompanion();
    if (run !== runRef.current) return;
    if (!r.ok) {
      if (r.error === 'updater-unavailable') { setPhase('unavailable'); return; }
      setError(r.error || 'The companion rejected the update request.');
      setPhase('error');
      return;
    }
    const deadline = Date.now() + TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, POLL_MS));
      if (run !== runRef.current) return;
      try {
        const c = await window.api.settings.apiCheckVersion();
        if (run !== runRef.current) return;
        if (c.status === 'match') {
          toast.success('Companion updated', { description: `Now on v${c.companion?.replace(/^v/, '')}.` });
          onUpdated?.();
          onClose();
          return;
        }
        // 'unreachable' while the container restarts is normal — keep polling.
      } catch { /* keep polling */ }
    }
    setError('The companion did not come back on the new version in time. Check the server, or re-run the install command below.');
    setPhase('error');
  };

  const versions = (
    <p>
      Desktop is on <span className="font-mono">v{String(desktop ?? '').replace(/^v/, '')}</span>, companion is on{' '}
      <span className="font-mono">{companion ?? 'unknown'}</span>.
    </p>
  );

  return (
    <Dialog
      open={open}
      onClose={() => { if (phase !== 'updating') onClose(); }}
      title="Update companion server"
      footer={
        phase === 'confirm' ? (
          <>
            <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
            <Button size="sm" onClick={onUpgrade}>Update companion</Button>
          </>
        ) : phase === 'updating' ? null : (
          <Button variant="outline" size="sm" onClick={onClose}>Close</Button>
        )
      }
    >
      <div className="flex flex-col gap-2 text-sm">
        {phase === 'confirm' && (
          <>
            {versions}
            <p>
              The server pulls the matching release and restarts itself — this takes a minute or two.
              Any Telegram or scheduled agent runs in progress will be interrupted.
            </p>
          </>
        )}
        {phase === 'updating' && (
          <p className="text-muted-foreground">Updating the companion… it restarts mid-way, so a short outage is expected.</p>
        )}
        {phase === 'unavailable' && (
          <>
            <p>
              This companion was installed before remote updates existed. Run the install command on the
              server once — after that, updates are one click from here.
            </p>
            <code className="rounded bg-raise px-2 py-1.5 font-mono text-xs break-all">{INSTALL_CMD}</code>
          </>
        )}
        {phase === 'error' && (
          <>
            <p className="text-destructive">{error}</p>
            <code className="rounded bg-raise px-2 py-1.5 font-mono text-xs break-all">{INSTALL_CMD}</code>
          </>
        )}
      </div>
    </Dialog>
  );
}
