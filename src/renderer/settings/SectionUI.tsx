import React from 'react';
import { cn } from '@/lib/utils';

// Shared scaffolding for settings pages (polish spec §7). Every section:
//
//   <SettingsSection title="Appearance" description="One-line intro.">
//     <SettingsGroup title="Theme">…controls…</SettingsGroup>
//     <SettingsDivider />
//     <SettingsGroup title="Editor">…controls…</SettingsGroup>
//   </SettingsSection>
//
// Controls come from shadcn (Field, Input, Select, Switch, Checkbox, Slider,
// Button). Field groups cap at a 360px measure (`SETTINGS_MEASURE`).

export const SETTINGS_MEASURE = 'max-w-[360px]';

export function SettingsSection({ title, description, children, wide = false }: any) {
  return (
    <div className="flex min-h-full flex-col px-7 pb-8 pt-6">
      <div className="pr-8">
        <h2 className="text-xl font-bold tracking-tight text-foreground">{title}</h2>
        {description && <p className="mt-1.5 text-[13px] text-muted-foreground">{description}</p>}
      </div>
      <div className={cn('flex flex-col gap-[22px] pt-[22px]', !wide && SETTINGS_MEASURE)}>
        {children}
      </div>
    </div>
  );
}

export function SettingsGroup({ title, children, className }: any) {
  return (
    <div className={className}>
      {title && <div className="mb-2.5 text-xs font-semibold text-foreground">{title}</div>}
      <div className="flex flex-col gap-3">{children}</div>
    </div>
  );
}

export function SettingsDivider() {
  return <div className={cn('h-px bg-border', SETTINGS_MEASURE, 'w-full')} />;
}

// Width for a small whole-number input (an interval, a count, a number of days).
// These take their width from the value they hold rather than the 360px measure:
// a full-width box for "30" reads as somewhere to type a sentence, and leaves the
// stepper arrows an inch away from the digits.
//
// 64px with the padding cut to 8px leaves ~30px of text column after Chromium's
// ~15px stepper — enough for the largest value any of these holds (600, the sync
// interval ceiling) without the box being wider than its contents.
//
// **Wrap the input in a plain <div>.** `Field`'s vertical variant carries
// `[&>*]:w-full` (field.tsx), which compiles to `.field > * { width: 100% }` — a
// child selector, so it outranks `.w-16` on specificity and tailwind-merge never
// gets a say. Measured in the renderer: Field > Input is 360px, Field > div >
// Input is 64px. The wrapper takes the full width and the input inside is free.
//
// **The input must be wrapped in a plain `<div>`.** `Field`'s vertical variant
// carries `[&>*]:w-full` (`components/ui/field.tsx`), which compiles to
// `.field > * { width: 100% }` — a child selector, so it outranks `.w-16` on
// specificity and tailwind-merge never gets a say. Measured in the renderer:
// Field > Input is 360px, Field > div > Input is 64px. The wrapper takes the full
// width the Field insists on, and the input inside is free to be its own size.
export const NUMBER_FIELD = 'w-16 px-2';

/** Same rules, for values up to about six digits (a context window, 128000). */
export const NUMBER_FIELD_WIDE = 'w-24 px-2';
