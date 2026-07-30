// Self-signed TLS for a PUBLIC server with no domain.
//
// The certificate is created ONCE, at boot (see server.ts), for the host the
// installer recorded in COMPANION_HOST. It is the server's identity from the
// moment the installer finishes and it does not change afterwards.
//
// That timing is load-bearing. This used to run inside /telegram/connect, so a
// fresh install had no certificate of ours at all — Traefik served its own
// throwaway one, the desktop approved THAT, and then connecting Telegram
// replaced it. The fingerprint changed on a routine action, the desktop showed
// its "identity changed" warning with no attacker anywhere, and a user who sees
// that warning during normal setup learns to click through the one prompt that
// catches a real machine-in-the-middle.
//
// When COMPANION_DOMAIN is set, none of this applies — Let's Encrypt issues a
// real certificate, the desktop verifies it normally, and any self-signed
// leftovers are DELETED (removeSelfSignedCert) rather than left behind as
// Traefik's default certificate with a live private key beside it.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';

const execFileP = promisify(execFile);

// Shared with Traefik: both containers mount this volume (Traefik's file provider
// watches it). Overridable for local unit tests.
const DYNAMIC_DIR = process.env.TRAEFIK_DYNAMIC_DIR || '/etc/traefik/dynamic';
const CERT = path.join(DYNAMIC_DIR, 'companion.crt');
const KEY = path.join(DYNAMIC_DIR, 'companion.key');
const TLS_CONF = path.join(DYNAMIC_DIR, 'tls.yml');

const isIp = (s: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(s);

/** The host this server's certificate is issued for. Recorded by the installer.
 *
 *  Deliberately NOT looked up at runtime. The installer already resolves the
 *  public IP to print your Server URL, and the certificate has to be issued for
 *  the exact address you type into the desktop — two independent lookups can
 *  disagree, and then the certificate is for one address while you connect to
 *  another. One lookup, at install, written down. */
export function configuredHost(): string {
  const host = (process.env.COMPANION_HOST || '').trim();
  if (!host) throw new Error('COMPANION_HOST is not set — re-run the installer so it can record this server\'s address.');
  return host;
}

const RENEW_BEFORE_MS = 30 * 24 * 60 * 60 * 1000; // regenerate within 30d of expiry

// Reuse an existing certificate that still matches the host and isn't near
// expiry. Regenerating when nothing changed would move the server's identity for
// no reason, and every desktop would have to approve it again.
async function certUsable(host: string): Promise<boolean> {
  try {
    const { stdout } = await execFileP('openssl', ['x509', '-in', CERT, '-noout', '-subject', '-ext', 'subjectAltName', '-enddate']);
    if (!stdout.includes(host)) return false;                       // host changed
    const end = /notAfter=(.+)/.exec(stdout)?.[1]?.trim();
    if (!end) return false;
    const expiry = Date.parse(end);
    if (!Number.isFinite(expiry)) return false;
    if (expiry - Date.now() <= RENEW_BEFORE_MS) return false;
    await fs.access(KEY);                                            // key must still be beside it
    return true;
  } catch {
    return false; // missing, unreadable, or no key → regenerate
  }
}

/** Create-or-reuse the certificate for `configuredHost()`. Returns its public PEM. */
export async function ensureSelfSignedCert(host = configuredHost()): Promise<string> {
  await fs.mkdir(DYNAMIC_DIR, { recursive: true });
  if (await certUsable(host)) return fs.readFile(CERT, 'utf8');

  const san = isIp(host) ? `IP:${host}` : `DNS:${host}`;
  await execFileP('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', KEY, '-out', CERT,
    '-days', '3650', '-subj', `/CN=${host}`,
    '-addext', `subjectAltName=${san}`,
  ]);
  // Serve it as Traefik's DEFAULT certificate, so a request with no hostname (an
  // IP in the address bar) gets this rather than Traefik's throwaway.
  await fs.writeFile(TLS_CONF, `tls:
  stores:
    default:
      defaultCertificate:
        certFile: ${CERT}
        keyFile: ${KEY}
  certificates:
    - certFile: ${CERT}
      keyFile: ${KEY}
`);
  return fs.readFile(CERT, 'utf8');
}

/** The existing certificate's PEM, or null. For handing Telegram a copy — it
 *  must never create one, or it would change the server's identity mid-life. */
export async function readCertPem(): Promise<string | null> {
  return fs.readFile(CERT, 'utf8').catch(() => null);
}

/** Delete the self-signed certificate, its key, and the Traefik TLS config that
 *  points at them. Run when COMPANION_DOMAIN is set: with a real certificate in
 *  play these are dead, and leaving them means a private key sits on disk
 *  claiming to be this server, still registered as Traefik's default. */
export async function removeSelfSignedCert(): Promise<void> {
  await Promise.all([
    fs.rm(CERT, { force: true }),
    fs.rm(KEY, { force: true }),
    fs.rm(TLS_CONF, { force: true }),
  ]);
}
