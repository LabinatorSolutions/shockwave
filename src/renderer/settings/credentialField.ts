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

/**
 * Remove the stored credential at `path`.
 *
 * Typing replaces; this is the only way to remove. Clearing the box can't do it —
 * the renderer holds no credential values, so every credential it sends reads as
 * empty and empty ones are stripped from saves deliberately, to stop an unrelated
 * edit wiping your keys. Without this there was no way to revoke a leaked key from
 * the app at all.
 *
 * `settings:changed` fires from main, so the field's `has*` flag updates itself.
 */
export function removeCredential(path: string): Promise<{ ok: boolean; error?: string }> {
  return window.api.settings.deleteCredential(path);
}
