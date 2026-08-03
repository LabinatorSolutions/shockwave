import React from 'react';
import { Input } from '@/components/ui/input';
import { credentialPlaceholder } from './credentialField';

// One shape for every credential box in Settings, so the six of them can't
// drift apart in size the way they had.
//
// WHY THE BUTTONS SIT BELOW, NOT BESIDE. They used to sit beside, with the
// input on `flex-1`, and the buttons were CONDITIONAL — Remove only exists once
// something is stored, Test only for openai-compatible. So the field resized as
// a side effect of state: GitHub's PAT was 280px empty, 186px once a token was
// stored, and 153px for as long as "Verify" said "Verifying…" — the box moved
// under the cursor while you used it. Beside-the-input cannot be fixed by
// reserving a slot either: "Verifying…" + "Removing…" is 216px of the 360px
// measure, which would leave every credential field 136px wide. Below is the
// only arrangement where the field is the same width in all states.
//
// The width comes from the container (the 360px settings measure — dialogs that
// host one of these are sized to match), never from a per-call-site class. That
// is what keeps them equal across sections. Don't pass a width in `className`.
//
// It also owns the FOCUS state, which is why every box gets the click-to-clear
// behaviour without a single call site knowing about it. The state has to live
// here rather than in the placeholder helper because a placeholder is a string
// and focus is not; and here rather than in the sections because there are seven
// of them and this is the one thing they all already share. `onFocus`/`onBlur`
// are chained, never replaced — two callers pass neither and the rest pass a
// blur that commits the draft.
export default function CredentialRow({
  id,
  saved,
  value,
  onChange,
  onFocus,
  onBlur,
  actions,
  className,
  ...props
}: any) {
  const [focused, setFocused] = React.useState(false);

  return (
    <div className="flex flex-col gap-2">
      <Input
        id={id}
        type="password"
        className={['w-full font-mono', className].filter(Boolean).join(' ')}
        placeholder={credentialPlaceholder(!!saved, focused)}
        value={value}
        onChange={onChange}
        onFocus={(e) => { setFocused(true); onFocus?.(e); }}
        onBlur={(e) => { setFocused(false); onBlur?.(e); }}
        spellCheck={false}
        autoComplete="off"
        autoCorrect="off"
        {...props}
      />
      {/* `empty:hidden` because callers pass a fragment whose buttons are each
          conditional — when none of them render, this row must not still eat a
          gap under the field. */}
      {actions && <div className="flex gap-2 empty:hidden">{actions}</div>}
    </div>
  );
}
