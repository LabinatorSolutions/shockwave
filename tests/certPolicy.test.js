// The companion certificate-approval decision (src/main/api/certPolicy.ts).
//
// Why this is tested: every companion request carries the bearer API key, and
// GET /settings returns the whole DECRYPTED secret store — provider keys, the
// GitHub PAT, OAuth refresh tokens. This decision is the only thing standing
// between a hostile network and all of it. It shipped once as
// `verificationResult === 'net::OK' ? cb(-3) : cb(0)` — "if the certificate is
// invalid, trust it anyway" — which accepted any forged certificate on every
// deployment.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideCert,
  toDisplayFingerprint,
  pendingApplies,
  mayApprove,
  DECISION,
} from '../src/main/api/certPolicy.ts';

const APPROVED = 'AA:BB:CC:DD';
const OTHER = '11:22:33:44';

test('a publicly-trusted chain is Chromium\'s call, pinning stays out of it', () => {
  // Nothing pinned for these, which is what makes a Let's Encrypt renewal (new
  // key every ~90 days) invisible instead of a warning four times a year.
  assert.equal(
    decideCert({ verificationResult: 'net::OK', offered: OTHER, approved: APPROVED }),
    DECISION.USE_CHROMIUM,
  );
  assert.equal(
    decideCert({ verificationResult: 'net::OK', offered: '', approved: '' }),
    DECISION.USE_CHROMIUM,
  );
});

test('an untrusted chain is accepted only on an exact fingerprint match', () => {
  assert.equal(
    decideCert({ verificationResult: 'net::ERR_CERT_AUTHORITY_INVALID', offered: APPROVED, approved: APPROVED }),
    DECISION.ACCEPT,
  );
});

test('a DIFFERENT fingerprint asks — never silently accepted', () => {
  assert.equal(
    decideCert({ verificationResult: 'net::ERR_CERT_AUTHORITY_INVALID', offered: OTHER, approved: APPROVED }),
    DECISION.ASK,
  );
});

test('nothing approved yet asks — there is no first-contact auto-approve', () => {
  // The regression this pins: a 30-second window used to adopt an unknown
  // fingerprint automatically during the connect flow. It decided first approval
  // FOR the user without ever showing them a fingerprint, so anyone intercepting
  // first setup was recorded silently, permanently, and never warned about again.
  assert.equal(
    decideCert({ verificationResult: 'net::ERR_CERT_AUTHORITY_INVALID', offered: OTHER, approved: '' }),
    DECISION.ASK,
  );
});

test('an empty offered fingerprint asks, even against an empty pin', () => {
  // Two empty strings must not compare equal into an ACCEPT.
  assert.equal(
    decideCert({ verificationResult: 'net::ERR_CERT_INVALID', offered: '', approved: '' }),
    DECISION.ASK,
  );
  assert.equal(
    decideCert({ verificationResult: 'net::ERR_CERT_INVALID', offered: '', approved: APPROVED }),
    DECISION.ASK,
  );
});

test('fingerprints render in openssl notation, so the two sides can be compared', () => {
  // The user's whole job is checking the app's value against what
  // `shockwave-fingerprint` prints on the server. Chromium gives base64, openssl
  // gives uppercase hex pairs — mismatched notations make the comparison
  // impossible and the approval step theatre.
  const bytes = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
  const got = toDisplayFingerprint(`sha256/${bytes.toString('base64')}`);
  assert.equal(
    got,
    '00:01:02:03:04:05:06:07:08:09:0A:0B:0C:0D:0E:0F:'
    + '10:11:12:13:14:15:16:17:18:19:1A:1B:1C:1D:1E:1F',
  );
  assert.match(got, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
});

test('a value that is not a SHA-256 is shown verbatim, not mangled', () => {
  assert.equal(toDisplayFingerprint('sha1/abcd'), 'sha1/abcd');
  assert.equal(toDisplayFingerprint('not base64 at all !!'), 'not base64 at all !!');
  assert.equal(toDisplayFingerprint(''), '');
  assert.equal(toDisplayFingerprint(undefined), '');
});

test('the same certificate renders identically with or without the sha256/ prefix', () => {
  const b64 = Buffer.alloc(32, 7).toString('base64');
  assert.equal(toDisplayFingerprint(`sha256/${b64}`), toDisplayFingerprint(b64));
});

// ── which parked certificate may be offered for approval ─────────────────────

test('a parked certificate is only offered for the host it came from', () => {
  // One slot, written by ANY companion request including background traffic. After
  // a URL change the previous server's retries are still in flight and its pin was
  // just cleared — without the host filter its certificate would be offered for
  // approval, and approving it would store the wrong server's fingerprint.
  const pending = { host: 'old.example.com', at: 1_000 };
  assert.equal(pendingApplies(pending, 'old.example.com', 1_500, 15_000), true);
  assert.equal(pendingApplies(pending, 'new.example.com', 1_500, 15_000), false);
});

test('no host given means do not filter', () => {
  const pending = { host: 'a.example.com', at: 1_000 };
  assert.equal(pendingApplies(pending, '', 1_500, 15_000), true);
});

test('a stale parked certificate is not offered', () => {
  const pending = { host: 'a.example.com', at: 1_000 };
  assert.equal(pendingApplies(pending, 'a.example.com', 1_000 + 15_001, 15_000), false);
  assert.equal(pendingApplies(pending, 'a.example.com', 1_000 + 15_000, 15_000), true);
});

test('nothing parked means nothing to offer', () => {
  assert.equal(pendingApplies(null, 'a.example.com', 1, 15_000), false);
});

// ── what may be pinned ───────────────────────────────────────────────────────

test('only the fingerprint main actually read may be approved', () => {
  // The gap this closes: api:approveCert used to pin whatever string it was
  // handed, so "the value on screen" and "the value stored" were tied together by
  // UI convention rather than by a check — the same unenforced-policy shape as the
  // certificate check that used to trust anything.
  const shown = { host: 'server.example.com', offered: 'AA:BB:CC', trusted: false };
  assert.equal(mayApprove(shown, 'server.example.com', 'AA:BB:CC'), true);
  assert.equal(mayApprove(shown, 'server.example.com', '11:22:33'), false, 'a different value');
});

test('a reading from another host cannot be approved for this one', () => {
  // The URL can change between the reading and the approval; the old server's
  // fingerprint must not be pinned for the new one.
  const shown = { host: 'old.example.com', offered: 'AA:BB:CC', trusted: false };
  assert.equal(mayApprove(shown, 'new.example.com', 'AA:BB:CC'), false);
});

test('nothing read means nothing to approve', () => {
  assert.equal(mayApprove(null, 'server.example.com', 'AA:BB:CC'), false);
});

test('empty values never approve', () => {
  const shown = { host: 'server.example.com', offered: '', trusted: false };
  assert.equal(mayApprove(shown, 'server.example.com', ''), false, 'two empties must not match');
  assert.equal(mayApprove({ ...shown, offered: 'AA:BB' }, '', 'AA:BB'), false, 'no host configured');
});
