import { useCallback, useEffect, useRef, useState } from 'react';

// The one commit rule for Settings text inputs: edit locally, write on blur.
//
// Why not write on every keystroke (what several sections used to do): each
// keystroke is a full round-trip to the companion, and for anything with a
// side effect beyond storage it also re-fires that side effect. The GitHub PAT
// hit this first — typing a token did ~90 writes AND ~90 sync-engine restarts,
// against 90 half-tokens — and grew its own draft+onBlur pair. The AssemblyAI
// key hit it a second way: each write raced the "is this key usable?" check,
// and a stale failure landing last left the Test button dead until you left
// the page. Rather than a third hand-rolled copy, that pattern lives here.
//
// The blur rule has one real hole: close Settings (or switch section) with the
// cursor still in the box and blur never fires. So the unmount cleanup flushes
// a pending edit — that is what makes "no Save button" safe.
//
// Toggles, dropdowns and sliders do NOT use this. They commit immediately;
// there is no partial state for a checkbox, and a slider has onValueCommit.
export function useCommitField<T = string>(
  value: T,
  onCommit: (next: T) => void,
): { value: T; onChange: (next: T) => void; onBlur: () => void } {
  const [draft, setDraft] = useState<T>(value);

  // Refs so the unmount flush reads the latest of everything without being
  // rebuilt (a cleanup rebuilt on each render would fire on every keystroke).
  const draftRef = useRef(draft);
  const valueRef = useRef(value);
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;
  valueRef.current = value;

  // Follow the stored value when it changes underneath us (hydrate on boot, a
  // push from main). Safe against clobbering an in-progress edit: the stored
  // value only moves once we've committed, at which point it equals the draft.
  useEffect(() => {
    setDraft(value);
    draftRef.current = value;
  }, [value]);

  const change = useCallback((next: T) => {
    draftRef.current = next;
    setDraft(next);
  }, []);

  const commit = useCallback(() => {
    if (Object.is(draftRef.current, valueRef.current)) return;
    commitRef.current(draftRef.current);
  }, []);

  // Flush on unmount — closing the modal mid-edit must not drop the value.
  useEffect(() => () => { commit(); }, [commit]);

  return { value: draft, onChange: change, onBlur: commit };
}

// The write-only variant, for credential boxes. Same blur rule, different
// lifecycle — and the difference is why it can't just be `useCommitField('')`.
//
// A credential field is not a text box with a secret sitting in it. The renderer
// is never given the stored value (main strips it), so the box is ALWAYS empty
// and the dots are a placeholder. Three things follow, none of which
// `useCommitField` can express:
//
//   - There is no stored value to follow, so the resync effect has nothing to do.
//   - An empty draft means UNCHANGED, never "delete this" — clearing the box
//     cannot remove a key (see `removeCredential`), so an empty commit is a no-op
//     rather than a write.
//   - After a commit the draft must go back to empty, so the dots come back and
//     the field reads as stored again. That is the only reason the reset is here
//     and not left to each caller.
//
// Left to each caller is exactly what happened, and they disagreed: GitHub and
// Companion reset the draft themselves, while Voice and Agent Chat passed a
// constant '' to `useCommitField` — whose resync effect keys on `[value]` and so
// never re-fired, leaving the typed key sitting in the box until the section
// unmounted. Same field, two behaviours, depending on which page you were on.
export function useCredentialField(
  onCommit: (next: string) => void,
): { value: string; onChange: (next: string) => void; onBlur: () => void } {
  const [draft, setDraft] = useState('');

  const draftRef = useRef(draft);
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;

  const change = useCallback((next: string) => {
    draftRef.current = next;
    setDraft(next);
  }, []);

  const commit = useCallback(() => {
    const next = draftRef.current;
    if (!next) return;
    draftRef.current = '';
    setDraft('');
    commitRef.current(next);
  }, []);

  // Same reason as above: closing Settings with the cursor still in the box must
  // not drop what was typed.
  useEffect(() => () => { commit(); }, [commit]);

  return { value: draft, onChange: change, onBlur: commit };
}
