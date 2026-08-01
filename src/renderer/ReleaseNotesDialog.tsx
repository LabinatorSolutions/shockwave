import React, { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import Dialog from './Dialog.js';
import { Button } from '@/components/ui/button';
import type { ReleaseNote } from '../shared/api';

// "What's new" — the release notes for every version between the one running
// here and the newest, read without leaving the app.
//
// **Every intervening version, not just the latest.** Someone four releases
// behind who only sees the newest one's notes has no idea what the other three
// changed, and it costs nothing to include them: main filters one list request.
//
// Notes are raw markdown from the GitHub API rather than electron-updater's
// `releaseNotes`, which hands back HTML in a shape that varies with its
// `fullChangelog` setting. Markdown means this renders through the same
// react-markdown the chat uses and nothing here has to sanitize HTML.
//
// Reachable while the update is merely `available` — reading what changed is how
// someone decides whether to download at all, so gating it behind the download
// would be backwards.
export default function ReleaseNotesDialog({
  open,
  onClose,
  current,
}: {
  open: boolean;
  onClose: () => void;
  current?: string;
}) {
  const [notes, setNotes] = useState<ReleaseNote[] | null>(null);
  const [error, setError] = useState('');

  // Keyed off the open transition, not mount: this dialog is permanently
  // mounted (see the modal rule in CLAUDE.md), so a mount-time fetch would run
  // once at app start and never again.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setNotes(null);
    setError('');
    window.api.app.getReleaseNotes()
      .then((r) => {
        if (!alive) return;
        setNotes(r.notes || []);
        setError(r.error || '');
      })
      .catch((err: any) => { if (alive) setError(err?.message || 'Could not load release notes'); });
    return () => { alive = false; };
  }, [open]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="What's new"
      footer={<Button variant="outline" size="sm" onClick={onClose}>Close</Button>}
    >
      <div className="chat-markdown max-h-[60vh] overflow-y-auto text-sm">
        {notes === null && !error && (
          <p className="text-muted-foreground">Loading…</p>
        )}
        {error && <p className="text-destructive">{error}</p>}
        {notes?.length === 0 && !error && (
          <p className="text-muted-foreground">
            No release notes newer than v{current ?? ''}.
          </p>
        )}
        {notes?.map((n) => (
          <section key={n.version} className="mb-5 last:mb-0">
            <div className="mb-1 flex items-baseline gap-2">
              <h3 className="m-0 text-sm font-semibold">v{n.version}</h3>
              {n.publishedAt && (
                <span className="text-xs text-muted-foreground">
                  {new Date(n.publishedAt).toLocaleDateString()}
                </span>
              )}
            </div>
            {n.body
              ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{n.body}</ReactMarkdown>
              : <p className="text-muted-foreground">No notes for this release.</p>}
          </section>
        ))}
      </div>
    </Dialog>
  );
}
