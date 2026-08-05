import { useState, useEffect, useCallback, useRef } from 'react';
import { toast } from 'sonner';
import type { UpdateStatus } from '../../shared/api';

// App-update state for the two places that show it: the toast, and
// Settings → Updates.
//
// **Nothing downloads or installs by itself.** Main checks on launch and daily
// and reports a phase; leaving `available` takes a `download()` call, and
// leaving `ready` takes `restart()`. This hook adds no automatic action of its
// own — that was the whole problem with the previous version, which toasted
// "downloaded, installs on restart" about a transfer nobody had asked for.
//
// Toast policy: it announces EVENTS (a version appeared; a download finished),
// and both carry the action — Download, then Restart. A dismissed toast stays
// dismissed: `snooze()` records the version in machine-local settings and main
// echoes it back as `snoozedVersion`. Settings → Updates is then the only place
// that still shows it, which is what `unsnooze()` below exists to undo. There
// used to be a persistent pill over the tab strip carrying the state alongside
// this; the tab strip needed that space for overflow controls, and the toast's
// action is the same one the pill led to.
//
// `onRequestRestart` is supplied by App (it opens the confirm dialog) and is
// re-exposed as `requestRestart` so the toast and Settings both go through the
// SAME confirmation. Nothing here calls `restartToUpdate` directly:
// installing quits the app, which kills a running agent turn, and that is not
// something a single click on a status pill should be able to do.
export function useAppUpdate({ onRequestRestart }: { onRequestRestart: () => void }) {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [checking, setChecking] = useState(false);
  // Read through a ref: the subscription below mounts once, so a callback
  // captured in its closure would go stale on App's next render.
  const restartRef = useRef(onRequestRestart);
  restartRef.current = onRequestRestart;
  // Keyed by `version:phase`, not version alone: `available` and `ready` are two
  // separate pieces of news about the SAME version, and a version-only guard
  // would let the first one swallow the second.
  const toastedRef = useRef<string | null>(null);

  useEffect(() => {
    let alive = true;
    window.api.app.getUpdateStatus().then((s) => { if (alive && s) setStatus(s); }).catch(() => {});
    const off = window.api.app.onUpdateStatus((s) => {
      setStatus(s);
      if (!s.latest) return;
      const key = `${s.latest}:${s.phase}`;
      if (toastedRef.current === key) return;              // repeat push, same news
      if (s.snoozedVersion === s.latest) return;           // user dismissed this version

      if (s.phase === 'available') {
        toastedRef.current = key;
        toast(`Version ${s.latest} is available`, {
          description: `You're on ${s.current}.`,
          action: s.canDownload
            ? { label: 'Download', onClick: () => { window.api.app.downloadUpdate(); } }
            // Dev build: no downloader, so the honest action is the release page.
            : { label: 'View release', onClick: () => { if (s.url) window.api.openExternal(s.url); } },
          // Dismissing means "not this version" — without this, declining an
          // update re-toasted on every launch and every daily poll.
          onDismiss: () => { window.api.app.snoozeUpdate(s.latest); },
        });
      } else if (s.phase === 'ready') {
        toastedRef.current = key;
        toast.success(`Version ${s.latest} is ready`, {
          description: 'It installs when you restart.',
          action: { label: 'Restart', onClick: () => restartRef.current() },
        });
      }
    });
    return () => { alive = false; off(); };
  }, []);

  // Manual check (returns the result so the caller can show inline feedback).
  const check = useCallback(async () => {
    setChecking(true);
    try {
      const s = await window.api.app.checkForUpdates();
      setStatus(s);
      return s;
    } finally {
      setChecking(false);
    }
  }, []);

  const download = useCallback(async () => {
    const s = await window.api.app.downloadUpdate();
    setStatus(s);
    return s;
  }, []);

  // Clearing the snooze is what makes Settings honest: someone who dismissed the
  // toast and later came looking should get the toast back for the same version.
  const unsnooze = useCallback(async () => {
    const s = await window.api.app.snoozeUpdate(null);
    setStatus(s);
    return s;
  }, []);

  const requestRestart = useCallback(() => restartRef.current(), []);

  return { status, checking, check, download, unsnooze, requestRestart };
}
