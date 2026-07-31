import React, { useMemo } from 'react';
import { THEME_MODES } from '../constants.js';
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

const TREE_PANEL_OPTIONS = [
  { value: 'off', label: 'Off' },
  { value: 'recent', label: 'Recent files' },
  { value: 'daily', label: 'Daily notes' },
  { value: 'both', label: 'Files + Notes' },
];

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
  // Commits on blur (see useCommitField). Typed digit-by-digit, so per-keystroke
  // writes also meant "1" and "10" both being saved on the way to "100" — and a
  // clamp firing against each partial value.
  const countField = useCommitField(String(treePanel?.count ?? 10), (next) => {
    const n = Math.round(Number(next));
    if (!Number.isFinite(n) || n < 1) return;
    onTreePanelChange?.({ ...treePanel, count: Math.min(50, n) });
  });

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
        <Label className="gap-2.5 text-[13px] font-normal">
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
          <FieldLabel htmlFor="tree-panel-content">Show below the file tree</FieldLabel>
          <Select
            value={treePanel?.content ?? 'off'}
            onValueChange={(v) => onTreePanelChange?.({ ...treePanel, content: v })}
          >
            <SelectTrigger id="tree-panel-content" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TREE_PANEL_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FieldDescription>
            A quick-access list under the file tree in the left sidebar, sorted by last modified. When showing both, daily notes are left out of recent files.
          </FieldDescription>
        </Field>
        {treePanel?.content !== 'off' && (
          <Field>
            <FieldLabel htmlFor="tree-panel-count">Items per list</FieldLabel>
            <div>
              <Input
                id="tree-panel-count"
                className={NUMBER_FIELD}
                type="number"
                min={1}
                max={50}
                value={countField.value}
                onChange={(e) => countField.onChange(e.target.value)}
                onBlur={countField.onBlur}
              />
            </div>
          </Field>
        )}
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
