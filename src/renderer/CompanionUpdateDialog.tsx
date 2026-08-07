import React, { useEffect, useState } from 'react';
import { toast } from 'sonner';
import Dialog from './Dialog.js';
import { Button } from '@/components/ui/button';

const INSTALL_CMD = 'curl -fsSL https://raw.githubusercontent.com/stephengpope/shockwave/main/api/install.sh | sh';

// Confirm-and-send for upgrading the companion server to this desktop's
// version. Fire-and-forget by design: the request is sent, the dialog closes,
// and the "it's done" signal arrives later — main watches the live feed
// reconnect after the companion's restart and pushes `api:companionUpdated`
// (App.tsx toasts it). Nothing here waits, polls, or blocks; an earlier
// version owned a polling loop behind a non-dismissable overlay, and one hung
// health check locked the entire app. Rendered by App.tsx — which opens it from
// the version toast's button AND automatically once the companion classifies as
// older — and by CompanionSection (manual).
export default function CompanionUpdateDialog({
  open,
  onClose,
  desktop,
  companion,
}: {
  open: boolean;
  onClose: () => void;
  desktop?: string;
  companion?: string;
}) {
  const [phase, setPhase] = useState<'confirm' | 'unavailable' | 'error'>('confirm');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (open) { setPhase('confirm'); setError(''); setSending(false); }
  }, [open]);

  const onUpgrade = async () => {
    setSending(true);
    const r = await window.api.settings.apiUpgradeCompanion();
    setSending(false);
    if (!r.ok) {
      if (r.error === 'updater-unavailable') { setPhase('unavailable'); return; }
      setError(r.error || 'The companion rejected the update request.');
      setPhase('error');
      return;
    }
    toast('Companion update started', {
      description: 'The server restarts in a minute or two — you’ll get a note here when it’s done.',
    });
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Update companion server"
      footer={
        phase === 'confirm' ? (
          <>
            <Button variant="outline" size="sm" onClick={onClose} disabled={sending}>Cancel</Button>
            <Button size="sm" onClick={onUpgrade} disabled={sending}>
              {sending ? 'Requesting…' : 'Update companion'}
            </Button>
          </>
        ) : (
          <Button variant="outline" size="sm" onClick={onClose}>Close</Button>
        )
      }
    >
      <div className="flex flex-col gap-2 text-sm">
        {phase === 'confirm' && (
          <>
            <p>
              Desktop is on <span className="font-mono">v{String(desktop ?? '').replace(/^v/, '')}</span>, companion is on{' '}
              <span className="font-mono">{companion ?? 'unknown'}</span>.
            </p>
            <p>
              The server pulls the matching release and restarts itself — this takes a minute or two.
              Any Telegram or scheduled agent runs in progress will be interrupted.
            </p>
          </>
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
