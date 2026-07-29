// PURE version comparison for the companion-upgrade flow (plain .js, no
// electron import — unit-tested under node --test, same pattern as
// workspaceRow.js).
//
// Desktop versions come from app.getVersion() ('1.0.21'); companion versions
// from GET /health ('v1.0.21' from a published image, 'dev' for local builds).

// '1.2.3' or 'v1.2.3' -> [1, 2, 3]; null for anything else ('dev', '', junk).
export function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(v ?? '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

// How the companion relates to this desktop:
//   'match'           — same release
//   'companion-older' — companion behind the desktop -> offer the upgrade
//   'companion-newer' — companion ahead -> the DESKTOP is stale, nothing to push
//   'dev'             — either side unversioned (local build) -> stay silent
export function classifyVersions(desktop, companion) {
  const d = parseVersion(desktop);
  const c = parseVersion(companion);
  if (!d || !c) return 'dev';
  for (let i = 0; i < 3; i++) {
    if (c[i] < d[i]) return 'companion-older';
    if (c[i] > d[i]) return 'companion-newer';
  }
  return 'match';
}
