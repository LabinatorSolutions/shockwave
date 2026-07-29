// The companion talks over HTTPS. When it's fronted by Traefik with a self-signed
// cert (the no-domain default), Node/undici's strict verification would reject it.
// We route every companion request through a DEDICATED Electron session whose
// certificate-verify proc trusts a self-signed cert — the user opted into this in
// Settings ("allow any self-signed").
//
// This session is used ONLY by companionFetch, which is used ONLY for companion
// API calls, so every request here IS the companion. That's why the proc needs no
// host allowlist (and why it works for the Test-before-Save flow, where the URL
// being probed isn't stored yet): a publicly-trusted cert still verifies normally;
// a self-signed / otherwise-untrusted one is trusted anyway.
//
// Using a session-scoped `fetch` (Chromium's network stack) instead of Node's
// global fetch (undici) gives us the setCertificateVerifyProc hook, which undici
// has no equivalent for, and avoids undici-version coupling.

import { session as electronSession } from 'electron';

let ses: Electron.Session | null = null;

function getChat(): Electron.Session {
  if (ses) return ses;
  // In-memory partition (no 'persist:' prefix) — isolated from the windows'
  // default session, so this trust override never touches renderer traffic.
  ses = electronSession.fromPartition('companion-api');
  ses.setCertificateVerifyProc((req, cb) => {
    // -3 = use Chromium's own result; 0 = trust. A valid/public cert verifies
    // normally; anything else (self-signed, untrusted CA, …) is trusted anyway.
    if (req.verificationResult === 'net::OK') cb(-3);
    else cb(0);
  });
  return ses;
}

// fetch-compatible, backed by Chromium's net stack. Same call shape as global
// fetch (method/headers/body/signal), so client.ts is a drop-in swap.
export function companionFetch(input: string, init?: RequestInit): Promise<Response> {
  return getChat().fetch(input, init);
}
