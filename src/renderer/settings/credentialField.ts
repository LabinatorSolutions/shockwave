// One definition of how every credential box behaves, so the six of them can't
// drift apart.
//
// The renderer is never given a credential value (main strips them — see
// stripCredentials in src/main/settingsStore.ts), so these boxes are always
// empty on render. That leaves the placeholder as the only thing that can say
// whether a key is already saved.
//
// Dots mean saved. Nothing typed and no dots means nothing is saved. Typing
// replaces whatever is stored. There is no reveal — the value isn't here to
// reveal, and a control that can never work is worse than no control.

// Long enough to read as a real credential. A short run of dots looked like a
// truncated hint rather than a stored value.
const DOTS = '•'.repeat(40);

/** Placeholder for a credential input. Same two strings in every field. */
export function credentialPlaceholder(saved: boolean): string {
  return saved ? DOTS : 'Paste your key';
}
