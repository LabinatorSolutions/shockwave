import React, { useCallback, useEffect, useState } from 'react';
import { Play, AlertTriangle, FileText, Loader2 } from 'lucide-react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { CronView, CronJobView } from '../shared/api';

// The in-app cron experience: the live schedule + manual Run-now buttons. There
// is no cron settings page to pair it with — the desktop stopped running the
// scheduler, so the knobs that page held (master on/off, catch-up window,
// max-run) are the companion's env now (CRON_ENABLED, CRON_REFRESH_SCHEDULE,
// CRON_MAX_RUN_MINUTES). This panel is the whole in-app surface.
//
// One-way by design: cron.json (the file) is the source of truth for the jobs +
// their enabled flag. This panel DISPLAYS that state (read-only) and can trigger
// a manual run; it never writes job definitions back to the file. Edit cron.json
// (or ask the agent) to add / enable / disable jobs.

function fmtRel(ms: number | null): string {
  if (ms == null) return '—';
  const delta = ms - Date.now();
  const abs = Math.abs(delta);
  const mins = Math.round(abs / 60000);
  if (mins < 1) return delta > 0 ? 'in <1m' : 'just now';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const span = h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : h ? `${h}h ${m}m` : `${m}m`;
  return delta > 0 ? `in ${span}` : `${span} ago`;
}

function JobRow({ job, busy, running, onRun }: { job: CronJobView; busy: boolean; running: boolean; onRun: () => void }) {
  const off = !job.enabled;
  return (
    <div className={cn(
      'flex items-start justify-between gap-3 rounded-lg border border-border px-3 py-2.5',
      off && 'opacity-60',
    )}>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium">{job.name || <span className="italic text-muted-foreground">(unnamed)</span>}</span>
          {off && !job.invalid && (
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">Off</span>
          )}
          {job.invalid && (
            <span className="rounded bg-destructive/10 px-1.5 py-0.5 text-[10px] font-medium text-destructive">{job.invalid}</span>
          )}
        </div>
        <div className="mt-0.5 font-mono text-xs text-muted-foreground">{job.description}</div>
        <div className="mt-1 flex gap-5 text-xs text-muted-foreground">
          <span><span className="text-muted-2">Next</span>&nbsp; {off ? '—' : fmtRel(job.nextRunAt)}</span>
          <span>
            <span className="text-muted-2">Last</span>&nbsp;{' '}
            {job.lastRunAt != null
              ? <span title={job.lastError ?? 'ok'}>{fmtRel(job.lastRunAt)} {job.lastError ? '✕' : '✓'}</span>
              : 'never'}
          </span>
        </div>
        {job.lastError && <div className="mt-1 truncate text-xs text-destructive" title={job.lastError}>{job.lastError}</div>}
      </div>
      <Button size="sm" variant="outline" className="h-7 shrink-0 gap-1 px-2" onClick={onRun}
        disabled={busy || !job.name} title={busy ? 'A run is in progress' : 'Run now'}>
        {running ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}Run
      </Button>
    </div>
  );
}

export default function CronModal({ open, onClose, onOpenFile, onRunStarted }: {
  open: boolean; onClose: () => void;
  onOpenFile?: (path: string) => void;
  onRunStarted?: (chatId: string) => void;
}) {
  const [view, setView] = useState<CronView | null>(null);

  const refresh = useCallback(async () => {
    try { setView(await window.api.cron.read()); } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    if (!open) return;
    void refresh();
    return window.api.cron.onState((v) => setView(v));
  }, [open, refresh]);

  const busy = !!view?.inFlight;
  const jobs = view?.jobs ?? [];
  const hasWorkspace = !!view?.activeWorkspace;

  const runNow = useCallback(async (name: string) => {
    const res = await window.api.cron.runNow(name);
    void refresh();
    if (res?.chatId) onRunStarted?.(res.chatId); // open the chat so it streams live
  }, [refresh, onRunStarted]);

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Scheduled Jobs</DialogTitle>
          <DialogDescription>
            The agent's schedule for the active workspace, read from <span className="font-mono">cron.json</span>.
            Runs execute on your companion server. Run a task now; enable, disable, or edit jobs in the file.
          </DialogDescription>
        </DialogHeader>

        {!hasWorkspace ? (
          <div className="rounded-lg border border-border px-3 py-6 text-center text-sm text-muted-foreground">
            Open a workspace to see its scheduled tasks.
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {view?.fileError && (
              <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" /><span>{view.fileError}</span>
              </div>
            )}

            {jobs.length === 0 && !view?.fileError ? (
              <div className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
                No scheduled tasks yet. Ask the agent to schedule something (e.g. “run a digest every
                morning at 8”), or create <span className="font-mono">cron.json</span> in the workspace root.
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {jobs.map((job, i) => (
                  <JobRow key={job.name || `__${i}`} job={job} busy={busy}
                    running={busy && view?.runningJobName === job.name} onRun={() => runNow(job.name)} />
                ))}
              </div>
            )}

            {view?.exists && onOpenFile && (
              <div className="flex items-center gap-1">
                <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground"
                  onClick={() => { onClose(); onOpenFile(`${view.activeWorkspace}/cron.json`); }}>
                  <FileText className="size-3.5" /> Open cron.json
                </Button>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
