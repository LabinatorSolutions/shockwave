import React, { useMemo } from 'react';
import { THEME_MODES } from '../constants.js';
import { clampPanelCount } from '../../shared/settings.js';
import { useCommitField } from './useCommitField';
import { SettingsSection, SettingsGroup, SettingsDivider, NUMBER_FIELD } from './SectionUI';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import Combobox from '../Combobox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Label } from '@/components/ui/label';

const OPTIONS = [
  { value: THEME_MODES.SYSTEM, label: 'System (follow your OS appearance)' },
  { value: THEME_MODES.LIGHT, label: 'Light' },
  { value: THEME_MODES.DARK, label: 'Dark' },
];

// One row of the file-tree panel control: a checkbox that turns the list on and
// the cap that applies to it. The two lists are configured independently, so
// this is called twice rather than being spelled out twice.
function TreePanelList({ id, label, list, onChange }) {
  // Commits on blur (see useCommitField). Typed digit-by-digit, so per-keystroke
  // writes also meant "1" and "10" both being saved on the way to "100" — and a
  // clamp firing against each partial value.
  const countField = useCommitField(String(list?.count ?? 10), (next) => {
    onChange({ ...list, count: clampPanelCount(next, list?.count ?? 10) });
  });
  return (
    <div className="flex items-center justify-between gap-4">
      <Label className="gap-2.5 text-sm font-normal">
        <Checkbox
          checked={!!list?.show}
          onCheckedChange={(v) => onChange({ ...list, show: v === true })}
        />
        {label}
      </Label>
      {/* The cap is meaningless for a list that isn't shown, but it keeps its
          slot rather than unmounting — a row that changes height on every
          click makes the group jump under the pointer. */}
      <Input
        id={id}
        className={NUMBER_FIELD}
        type="number"
        min={1}
        max={50}
        aria-label={`${label} to show`}
        disabled={!list?.show}
        value={countField.value}
        onChange={(e) => countField.onChange(e.target.value)}
        onBlur={countField.onBlur}
      />
    </div>
  );
}

export default function GeneralSection({
  themeMode,
  onThemeModeChange,
  hideLineNumbers,
  onHideLineNumbersChange,
  treePanel,
  onTreePanelChange,
  timezone,
  onTimezoneChange,
}) {

  // Every IANA zone Chromium knows, so the value is always one the server can
  // actually resolve — a typo'd zone name would silently fall back to UTC on the
  // companion and fire every scheduled job at the wrong hour.
  const zones = useMemo(() => {
    let list: string[] = [];
    try { list = (Intl as any).supportedValuesOf?.('timeZone') ?? []; } catch { /* older runtime */ }
    return ['UTC', ...list.filter((z) => z !== 'UTC')];
  }, []);

  return (
    <SettingsSection title="General" description="App-wide preferences: color theme, editor display, and time.">
      <SettingsGroup title="Theme">
        <Field>
          <FieldLabel htmlFor="theme-mode">Color theme</FieldLabel>
          <Select value={themeMode} onValueChange={onThemeModeChange}>
            <SelectTrigger id="theme-mode" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </SettingsGroup>

      <SettingsDivider />

      <SettingsGroup title="Editor">
        <Label className="gap-2.5 text-sm font-normal">
          <Checkbox
            checked={!!hideLineNumbers}
            onCheckedChange={(v) => onHideLineNumbersChange?.(v === true)}
          />
          Hide line numbers in editor
        </Label>
      </SettingsGroup>

      <SettingsDivider />

      <SettingsGroup title="File tree">
        <Field>
          <FieldLabel>Show below the file tree</FieldLabel>
          <div className="flex flex-col gap-2">
            <TreePanelList
              id="tree-panel-recent-count"
              label="Recent files"
              list={treePanel?.recent}
              onChange={(next) => onTreePanelChange?.({ ...treePanel, recent: next })}
            />
            <TreePanelList
              id="tree-panel-daily-count"
              label="Daily notes"
              list={treePanel?.daily}
              onChange={(next) => onTreePanelChange?.({ ...treePanel, daily: next })}
            />
          </div>
          <FieldDescription>
            Quick-access lists under the file tree in the left sidebar, sorted by last modified. Each has its own limit. When both are shown, daily notes are left out of recent files.
          </FieldDescription>
        </Field>
      </SettingsGroup>

      <SettingsDivider />

      {/* Last, not first. Not a display setting — which is why this page isn't
          called Appearance any more — but also not the reason anyone opens it:
          it's set once, when the companion is first set up, and then never
          again, while theme and editor display are what people come back for.
          It lived on a Cron page while the desktop ran its own scheduler; cron
          moved to the companion and took that page's reason to exist with it,
          but the zone is used app-wide — schedules, run times, and the agent's
          idea of today's date. */}
      <SettingsGroup title="Time">
        <Field>
          <FieldLabel htmlFor="timezone">Timezone</FieldLabel>
          <Combobox
            id="timezone"
            className="font-mono"
            options={zones}
            value={timezone || 'UTC'}
            onChange={(v) => onTimezoneChange?.(v.trim() || 'UTC')}
            placeholder="UTC"
          />
          <FieldDescription>
            The one timezone the whole system uses — scheduled runs, run times, and the agent's date. Type to filter (e.g. <span className="font-mono">New_York</span>).
          </FieldDescription>
        </Field>
      </SettingsGroup>
    </SettingsSection>
  );
}
