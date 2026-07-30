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
