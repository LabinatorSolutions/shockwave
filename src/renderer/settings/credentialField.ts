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

/**
 * Placeholder for a credential input. Same three strings in every field.
 *
 * WHY FOCUS MATTERS HERE, when it matters nowhere else in Settings. Chromium
 * keeps a placeholder visible while an empty input is focused, and this box is
 * always empty — so clicking into a stored key changed nothing on screen and the
 * field read as locked. Backspace reinforced it: there is nothing to delete, so
 * nothing happened. Then typing one character replaced forty dots with a single
 * bullet, which looks precisely like having just wiped the key down to one
 * character — at a moment when nothing has been written at all.
 *
 * So focus swaps the dots for what typing will actually do. Clearing them is the
 * feedback ("you are in an empty box now"); saying `replace` is the answer to the
 * question an empty box raises ("did I just delete it?"). Blur brings the dots
 * back, because by then the draft has been committed and reset — see
 * `useCredentialField`.
 *
 * This is not a format-example placeholder and must never become a lookalike for
 * a stored value; that rule is what the dots-on-blur already sit right at the
 * edge of.
 */
export function credentialPlaceholder(saved: boolean, focused = false): string {
  if (!saved) return 'Paste your key';
  return focused ? 'Paste a new key to replace' : DOTS;
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
