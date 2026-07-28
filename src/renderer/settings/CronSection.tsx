import React, { useEffect, useState } from 'react';
import { CalendarClock, ChevronRight } from 'lucide-react';
import { SettingsSection, SettingsGroup, SettingsDivider } from './SectionUI';
import { Field, FieldLabel, FieldDescription } from '@/components/ui/field';
import { Input } from '@/components/ui/input';

// Cron execution runs on the companion server, not the desktop. This page is the
// entry point to the schedule VIEW (next/last run + manual run) plus the one
// unified system timezone. Job definitions live in cron.json at each workspace
// root (git-synced); server-wide knobs (enable/refresh/max-run) are companion env.
export default function CronSection({ onOpenCronPanel }: { onOpenCronPanel?: () => void }) {
  const [tz, setTz] = useState('UTC');

  useEffect(() => {
    let alive = true;
    window.api.settings.read().then((s: any) => { if (alive) setTz(s.timezone || 'UTC'); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  const commitTz = (value: string) => {
    const next = value.trim() || 'UTC';
    setTz(next);
    window.api.settings.write({ timezone: next }).catch(() => {});
  };

  return (
    <SettingsSection
      title="Cron"
      description="The coding agent runs on a schedule on your companion server. Jobs are defined in cron.json at each workspace root; open the schedule view to see each job's next and last run, and to run one manually."
    >
      <SettingsGroup>
        <Field>
          <FieldLabel htmlFor="cron-tz">Timezone</FieldLabel>
          <Input
            id="cron-tz"
            className="font-mono"
            defaultValue={tz}
            key={tz}
            placeholder="UTC"
            spellCheck={false}
            onBlur={(e) => commitTz(e.currentTarget.value)}
          />
          <FieldDescription>
            The one timezone the whole system uses — cron schedules, run times, and the agent's date. IANA name (e.g. <span className="font-mono">America/New_York</span>) or <span className="font-mono">UTC</span>.
          </FieldDescription>
        </Field>
      </SettingsGroup>

      {onOpenCronPanel && (
        <>
          <SettingsDivider />
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
        </>
      )}
    </SettingsSection>
  );
}
