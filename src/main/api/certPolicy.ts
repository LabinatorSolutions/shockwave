// PURE certificate-approval policy. No electron, no fs, so
// `node --test` can exercise it directly — the same split as `keys.ts` (pure) vs
// `settingsStore.ts` (stateful), and `workspaceFolder.ts` vs `sync.ts`.
//
// `net.ts` owns the Electron wiring (the session, the verify callback, the stored
// pin) and calls in here for the one decision that matters. That decision is what
// stands between a hostile network and every credential the user owns, so it lives
// somewhere a test can reach it.

/** Chromium's verify-proc reply codes, and our own outcome names. */
export const DECISION = {
  /** Publicly-trusted chain — let Chromium's own result stand. */
  USE_CHROMIUM: 'use-chromium',
  /** Matches the fingerprint the user approved. */
  ACCEPT: 'accept',
  /** Not the approved one (or nothing approved yet) — hold, and ask the user. */
  ASK: 'ask',
};

/**
 * Decide what to do with a certificate.
 *
 * @param {object} o
 * @param {string} o.verificationResult  Chromium's result, e.g. 'net::OK'.
 * @param {string} o.offered             Fingerprint the server offered (display form).
 * @param {string} o.approved            Fingerprint the user approved ('' = none).
 * @returns {string} one of DECISION.
 *
 * Two rules, and nothing else:
 *
 *   1. A chain that verifies publicly is Chromium's call. Nothing is pinned for
 *      those, so a Let's Encrypt renewal — new key every ~90 days — is invisible.
 *
 *   2. Otherwise (self-signed always lands here, because nothing vouches for it)
 *      accept ONLY the exact fingerprint the user approved. Anything else asks.
 *
 * There is deliberately NO third rule that adopts an unknown fingerprint. One
 * used to exist — a 30-second window opened by the connect flow — and it decided
 * first approval FOR the user without ever showing them a fingerprint, so anyone
 * intercepting first setup was recorded silently, permanently, and never warned
 * about again. Narrowing WHEN an auto-approve fires is not a substitute for not
 * having one.
 */
export function decideCert({ verificationResult, offered, approved }) {
  if (verificationResult === 'net::OK') return DECISION.USE_CHROMIUM;
  if (offered && approved && offered === approved) return DECISION.ACCEPT;
  return DECISION.ASK;
}

/**
 * Chromium reports `sha256/<base64>`; openssl prints uppercase hex pairs joined
 * by colons. The user's whole job is comparing what the app shows against what
 * `shockwave-fingerprint` prints on the server, so both must be in one notation
 * or the comparison can never succeed and approving is pure theatre. openssl's
 * form wins — it's the one on the server.
 *
 * Anything that isn't a SHA-256 comes back untouched rather than mangled.
 */
export function toDisplayFingerprint(raw) {
  if (typeof raw !== 'string' || !raw) return '';
  const b64 = raw.startsWith('sha256/') ? raw.slice(7) : raw;
  try {
    const hex = Buffer.from(b64, 'base64').toString('hex').toUpperCase();
    if (hex.length !== 64) return raw;
    return (hex.match(/../g) ?? []).join(':');
  } catch {
    return raw;
  }
}

/**
 * May this fingerprint be pinned?
 *
 * Approving is meant to record the value the user just compared against
 * `shockwave-fingerprint` on their server. Nothing enforced that: `api:approveCert`
 * pinned whatever string arrived, so the tie between WHAT WAS SHOWN and WHAT GETS
 * STORED was UI convention rather than a rule. Convention is exactly what "trust
 * any certificate" was, and it survived for the same reason — nobody checked.
 *
 * So the rule: the only approvable fingerprint is the one main last read off the
 * server (`readServerCert`), for the host currently configured. A stale reading,
 * a reading from a different host, or no reading at all → refuse.
 *
 * @param {{host: string, offered: string}|null} shown  What main last displayed.
 * @param {string} host         Host in the configured companion URL.
 * @param {string} fingerprint  What the caller wants pinned.
 */
export function mayApprove(shown, host, fingerprint) {
  if (!shown || !fingerprint || !host) return false;
  if (shown.host !== host) return false;
  return shown.offered === fingerprint;
}

/**
 * Should a parked certificate be offered for approval right now?
 *
 * There is ONE slot for it, written by any companion request including background
 * traffic, so it has to be matched against the host actually being connected to.
 * Without that, changing the server URL could surface the PREVIOUS server's
 * certificate — its retries are still in flight and its pin was just cleared —
 * and approving it would store the wrong server's fingerprint.
 *
 * @param {{host: string, at: number}|null} pending
 * @param {string} host   Host being connected to ('' = don't filter).
 * @param {number} now
 * @param {number} withinMs
 */
export function pendingApplies(pending, host, now, withinMs) {
  if (!pending) return false;
  if (now - pending.at > withinMs) return false;
  if (host && pending.host !== host) return false;
  return true;
}
