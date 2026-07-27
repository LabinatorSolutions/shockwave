import React from 'react';
import { CalendarClock, ChevronRight } from 'lucide-react';
import { SettingsSection, SettingsGroup } from './SectionUI';

// Cron execution runs on the companion server, not the desktop. This page is
// just the entry point to the schedule VIEW (the operational panel where you see
// each job's next/last run and can trigger a manual run). Job definitions live in
// cron.json at each workspace root (git-synced); server-wide settings
// (enable/refresh/max-run) are the companion's env, not machine-local anymore.
export default function CronSection({ onOpenCronPanel }: { onOpenCronPanel?: () => void }) {
  return (
    <SettingsSection
      title="Cron"
      description="The coding agent runs on a schedule on your companion server. Jobs are defined in cron.json at each workspace root; open the schedule view to see each job's next and last run, and to run one manually."
    >
      {onOpenCronPanel && (
        <SettingsGroup>
          <button
            type="button"
            onClick={onOpenCronPanel}
            className="flex w-full items-center justify-between rounded-lg border border-border px-3 py-2.5 text-left hover:bg-accent"
          >
            <span className="flex items-center gap-2 text-[13px] font-medium">
              <CalendarClock className="size-4 text-muted-foreground" /> Scheduled Jobs
            </span>
            <ChevronRight className="size-4 text-muted-foreground" />
          </button>
        </SettingsGroup>
      )}
    </SettingsSection>
  );
}
