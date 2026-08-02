// The companion talks over HTTPS, and every request carries the bearer API key —
// which is enough, on its own, to read the whole decrypted secret store from
// GET /settings. So the certificate check is the thing standing between a
// hostile network and every credential the user owns.
//
// Two deployments, one check:
//
//   Publicly-trusted cert (COMPANION_DOMAIN + Let's Encrypt)
//       → Chromium's own verification decides. A forged cert fails it. Renewals
//         rotate the key every ~90 days and are invisible, because nothing is
//         pinned.
//
//   Self-signed cert (the no-domain default)
//       → Chromium's verification ALWAYS fails, so it can't tell the user's
//         server from an impostor. We pin instead: remember the fingerprint the
//         user approved, and accept only that one.
//
// This used to be `verificationResult === 'net::OK' ? cb(-3) : cb(0)` — i.e.
// "if the certificate is invalid, trust it anyway". That accepted any forged
// cert on both deployments, including domains with a perfectly good cert, so a
// machine-in-the-middle on any network got the API key on the first request.
//
// Nothing is EVER approved automatically. A fingerprint is pinned in exactly one
// place — approveFingerprint(), called when the user presses Approve on a
// fingerprint Settings has shown them. Two situations reach that point and both
// take the same path — hold the connection, remember what we saw, ask:
//   • nothing approved for this server yet (first connection)
//   • what it's offering isn't what was approved (it changed)
// `approved === null` in the payload is what tells the UI which question to ask.
//
// NOTE ON WORDING: the connection is HELD, not rejected. Completing it means
// sending the API key, and that can't happen before the user confirms the server
// — so the attempt stops, shows what it saw, and waits. This file used to call
// that a "rejection" (REJECT, lastRejection, CertRejection), which read as a
// verdict on something the user had already approved and made the flow
// impossible to explain. Keep the names describing what it is: a certificate
// pending the user's approval.
//
// A session-scoped fetch (Chromium's network stack) is what gives us
// setCertificateVerifyProc at all; Node's global fetch/undici has no equivalent.

import { session as electronSession } from 'electron';
import tls from 'node:tls';
import crypto from 'node:crypto';
import { readApiConfig, writeApiConfig } from './config.js';
// The decision itself is pure and unit-tested — see certPolicy.ts. This file is
// only the Electron wiring around it.
import { decideCert, toDisplayFingerprint, pendingApplies, mayApprove, DECISION } from './certPolicy.js';

// Chromium's verify-proc reply codes.
const CB_USE_CHROMIUM = -3;
const CB_ACCEPT = 0;
const CB_DO_NOT_CONNECT = -2;

// How long a parked certificate stays offerable. Generous on purpose: the
// renderer PULLS this at startup (the push can fire before the window exists), and
// a boot slow enough to miss a 15s window would have shown nothing at all. One
// value — there used to be a second, longer one passed in at the pull site.
const PENDING_TTL_MS = 5 * 60_000;

/** A certificate the app stopped on, waiting for the user to approve it. */
export interface PendingCert {
  host: string;
  /** Fingerprint the server offered, in the display format below. */
  offered: string;
  /** Fingerprint previously approved for this host; null = never approved. */
  approved: string | null;
  at: number;
}


let ses: Electron.Session | null = null;
let pendingApproval: PendingCert | null = null;

// Chromium caches its certificate verdict per host for the life of a session, and
// the verify proc is not consulted again once it has one. That bites BOTH ways:
// before approval there's no fresh certificate to show, and after approval the
// stored verdict is still "don't connect", so approving appeared to do nothing.
//
// There is no API to drop just that cache, so a change retires the whole session
// and the next request builds a new one. Safe because this session is in-memory
// and holds nothing worth keeping — no cookies, no storage. The live feed's stream
// dies with it and reconnects on its own.
let epoch = 0;
function retireSession(): void {
  epoch += 1;
  ses = null;
}

// The fingerprint the live session was built against. Checked on every use, so
// ANY change to the stored pin invalidates the cached verdict — not just the two
// paths that call retireSession() explicitly.
//
// This is a security bug fixed, not tidying. Changing the companion URL clears the
// pin (see config.ts) but went through neither approve nor forget, so the session —
// and Chromium's cached "accept" — survived. The result: the app connected happily
// with NOTHING approved, and the panel showed Connected with no fingerprint to
// show. Pinning was effectively off until the process restarted. Deciding here,
// from the stored value, means a future caller that clears the pin some other way
// can't reopen the same hole by forgetting to retire.
let sessionFingerprint: string | null = null;

// Announced on EVERY held connection — no dedupe here. The renderer's toast
// carries a fixed id, so while it's on screen a repeat updates it in place
// instead of stacking, and once the user dismisses it the next held connection
// brings it back. That's the rule: open ⇒ don't show again, closed ⇒ show again.
// Tracking "already told them" in this file got that wrong — dismissing meant it
// never returned, so everything silently stopped syncing with nothing on screen.
let announce: ((c: PendingCert) => void) | null = null;

export function onCertNeedsApproval(cb: (c: PendingCert) => void): void { announce = cb; }

/** The certificate currently awaiting approval, if it was seen within `withinMs`.
 *
 *  `host` filters it. There is one slot here, written by ANY companion request —
 *  including background traffic. Without the filter, changing the server URL
 *  could surface the PREVIOUS server's certificate for approval (its retries are
 *  still in flight, and its pin was just cleared), and approving it would store
 *  the wrong server's fingerprint. */
export function getPendingCert(host?: string, withinMs = PENDING_TTL_MS): PendingCert | null {
  return pendingApplies(pendingApproval, host ?? '', Date.now(), withinMs) ? pendingApproval : null;
}

/** Host out of a companion URL, for matching against a pending certificate. */
export function hostOf(url: string): string {
  try { return new URL(url).hostname; } catch { return ''; }
}

/**
 * Go and LOOK at a server's certificate, deliberately, over our own TLS socket.
 *
 * This is what Connect actually needs, and it must not be inferred from a failed
 * fetch. Chromium caches its certificate verification per session, so the verify
 * proc fires on the FIRST connection to a host and then not again — meaning a
 * second Connect press produced no fresh certificate, and after the 15s window
 * lapsed the user got "Could not reach the server" for a server that was up and
 * merely un-approved. The approval panel became unreachable, which broke the whole
 * feature: no amount of re-entering a correct URL and key could get past it.
 *
 * `rejectUnauthorized: false` is correct and not a weakening: we are not
 * establishing a trusted channel here, we are reading an identity to show the
 * user. Nothing is sent over this socket — no API key, no request — and the
 * fingerprint it returns is only ever displayed or compared, never trusted on its
 * own. The trusted channel is companionFetch, which still refuses anything
 * unapproved.
 */
export interface SeenCert {
  host: string;
  offered: string;
  /** True when the chain verifies against the system CAs — i.e. a real
   *  certificate, which is never pinned and must never prompt for approval. */
  trusted: boolean;
}

export function readServerCert(url: string, timeoutMs = 6_000): Promise<SeenCert | null> {
  return new Promise((resolve) => {
    let u: URL;
    try { u = new URL(url); } catch { resolve(null); return; }
    if (u.protocol !== 'https:') { resolve(null); return; }
    const host = u.hostname;
    const socket = tls.connect({
      host,
      port: Number(u.port) || 443,
      servername: /^\d{1,3}(\.\d{1,3}){3}$/.test(host) ? undefined : host, // SNI is invalid for an IP
      rejectUnauthorized: false,
      timeout: timeoutMs,
    });
    const done = (v: SeenCert | null) => {
      try { socket.destroy(); } catch { /* already gone */ }
      resolve(v);
    };
    socket.once('secureConnect', () => {
      const peer = socket.getPeerCertificate();
      if (!peer || !peer.raw) { done(null); return; }
      const hex = crypto.createHash('sha256').update(peer.raw).digest('hex').toUpperCase();
      // `authorized` is still reported with rejectUnauthorized:false — it's the
      // verdict, not the enforcement. Without it a domain with a perfectly good
      // certificate would be offered for approval, since nothing is pinned for
      // those and any fingerprint would look unapproved.
      const seen: SeenCert = {
        host, offered: (hex.match(/../g) ?? []).join(':'), trusted: socket.authorized,
      };
      // Record what we read. This — not the renderer's word for it — is what
      // approveFingerprint will accept later.
      lastShown = seen;
      done(seen);
    });
    socket.once('timeout', () => done(null));
    socket.once('error', () => done(null));
  });
}

export function clearPendingCert(): void { pendingApproval = null; }

// The last certificate main actually READ off a server and put in front of the
// user. Approving is only allowed to pin this exact value, for this exact host —
// see mayApprove in certPolicy.ts for why the UI showing it isn't enough.
let lastShown: SeenCert | null = null;

/** What main last displayed for approval, if anything. */
export function shownCert(): SeenCert | null { return lastShown; }

/**
 * Approve a fingerprint the user has just been shown. The ONLY writer of the pin.
 *
 * Refuses anything that isn't the fingerprint main last read off the configured
 * host. Returns false when it refuses, so the caller reports rather than pretending
 * something was stored.
 */
export function approveFingerprint(fingerprint: string): boolean {
  const host = hostOf(readApiConfig().url);
  if (!mayApprove(lastShown, host, fingerprint)) return false;
  writeApiConfig({ certFingerprint: fingerprint });
  clearPendingCert();
  return true;
  // No explicit retire: getCompanionSession() compares the live session against
  // the stored pin and retires on any difference. One mechanism, so a future
  // caller that changes the pin can't forget to invalidate the cached verdict —
  // which is precisely how clearing the pin via a URL change let the app connect
  // with nothing approved.
}

/** The fingerprint currently approved for this machine, for display. Empty when
 *  the server has a publicly-trusted certificate (nothing to pin) or nothing has
 *  been approved yet. */
export function approvedFingerprint(): string {
  return readApiConfig().certFingerprint;
}

/** Un-approve. The user compared the app's value against the server's and they
 *  didn't match, or they want to re-approve from scratch. */
export function forgetFingerprint(): void {
  writeApiConfig({ certFingerprint: '' });
  clearPendingCert();
}

function getCompanionSession(): Electron.Session {
  // Retire on ANY change to the stored pin, whoever made it. Clearing it via a
  // URL change calls neither approve nor forget, so without this the cached
  // "accept" verdict outlived the approval and the app connected with nothing
  // approved at all.
  const pinned = readApiConfig().certFingerprint;
  if (ses && sessionFingerprint !== pinned) retireSession();
  if (ses) return ses;
  sessionFingerprint = pinned;
  // In-memory partition (no 'persist:' prefix) — isolated from the windows'
  // default session, so this policy never touches renderer traffic. The epoch
  // suffix is what makes retireSession() effective: a new partition name is a new
  // cache, which is the only way to drop Chromium's cached certificate verdict.
  ses = electronSession.fromPartition(`companion-api-${epoch}`);
  ses.setCertificateVerifyProc((req, cb) => {
    const offered = toDisplayFingerprint(req.certificate?.fingerprint ?? '');
    const approved = readApiConfig().certFingerprint;
    const decision = decideCert({ verificationResult: req.verificationResult, offered, approved });

    if (decision === DECISION.USE_CHROMIUM) return cb(CB_USE_CHROMIUM);
    if (decision === DECISION.ACCEPT) return cb(CB_ACCEPT);

    // Hold the connection so the API key never leaves, remember what was offered,
    // and let the UI ask. Nothing is approved here — see certPolicy.ts for why
    // there is no automatic path.
    pendingApproval = { host: req.hostname, offered, approved: approved || null, at: Date.now() };
    try { announce?.(pendingApproval); } catch { /* window gone */ }
    cb(CB_DO_NOT_CONNECT);
  });
  return ses;
}

// fetch-compatible, backed by Chromium's net stack. Same call shape as global
// fetch (method/headers/body/signal), so client.ts is a drop-in swap.
export function companionFetch(input: string, init?: RequestInit): Promise<Response> {
  return getCompanionSession().fetch(input, init);
}
