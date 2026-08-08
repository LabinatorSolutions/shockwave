// Traefik's dynamic configuration — cert, key, and both config files.
//
// ONE owner, on purpose. Traefik's dynamic directory holds three things that
// only make sense together:
//
//   companion.crt / .key  the server's identity (self-signed mode only)
//   tls.yml               what makes that certificate Traefik's DEFAULT
//   router.yml            the route to the api, and which TLS mode it uses
//
// They used to have two owners: this process wrote the certificate and tls.yml,
// while a one-shot `traefik-config` sidecar wrote router.yml. Neither container
// could see the other, and each re-derived the same IP-vs-domain decision.
//
// That split cost a real outage, and the mechanism is worth stating exactly,
// because it is silent from every angle:
//
//   `ensureSelfSignedCert` wrote tls.yml ONLY on the branch that generated a
//   certificate. Reuse returned early. So a dynamic directory holding a valid
//   companion.crt and no tls.yml was a stable state — and Traefik's response to
//   having no default certificate is not an error, it is a throwaway
//   certificate it mints at every startup. The server answered HTTPS perfectly
//   while presenting an identity no desktop had approved; this process logged
//   "self-signed certificate ready"; and NOTHING repaired it, because every
//   repair path (restart, `POST /update`, re-running install.sh) came back
//   through the same early return. `shockwave rotate-cert` was the only way
//   out, and it fixes a config bug by changing the server's identity.
//
// The rule that replaces it: **reuse applies to the certificate, never to the
// configuration that publishes it.** The certificate is an identity and must not
// churn — every desktop has approved its fingerprint. The two YAML files are
// derived, deterministic, and identical on every boot, so there is nothing to
// preserve and nothing to be gained by guarding the write. Asserting the whole
// desired state on every boot is what makes a boot a repair.
//
// When COMPANION_DOMAIN is set none of the certificate half applies — Let's
// Encrypt issues the real one, the desktop verifies it normally, and any
// self-signed leftovers are DELETED rather than left behind as Traefik's default
// with a live private key beside them. The router is still written here, by the
// same call, so the mode is decided once (`normalizeTlsEnv` in server.ts) and
// written once.

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
const ROUTER_CONF = path.join(DYNAMIC_DIR, 'router.yml');

const BACKEND = 'http://api:8080';

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

// Write through a temp file in the same directory, then rename.
//
// Traefik watches this directory and reloads on any change, so a reader can
// arrive mid-write. A rename is atomic within one filesystem, so it never sees
// half a file. The `.tmp` extension matters: Traefik's file provider loads only
// .yml/.yaml/.toml/.json and skips anything else, so the temp file is invisible
// to it rather than briefly being a second, malformed config.
async function writeAtomic(dest: string, body: string): Promise<void> {
  const tmp = `${dest}.tmp`;
  await fs.writeFile(tmp, body);
  await fs.rename(tmp, dest);
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

/** Serve our certificate as Traefik's DEFAULT, so a request carrying no server
 *  name — which is every request to a bare IP — gets this one rather than the
 *  throwaway Traefik mints when no default is configured.
 *
 *  Written unconditionally. See the header: guarding this behind "did we just
 *  generate a certificate?" is what made a missing tls.yml unrecoverable. */
async function writeTlsConf(): Promise<void> {
  await writeAtomic(TLS_CONF, `tls:
  stores:
    default:
      defaultCertificate:
        certFile: ${CERT}
        keyFile: ${KEY}
  certificates:
    - certFile: ${CERT}
      keyFile: ${KEY}
`);
}

/** Create-or-reuse the certificate for `configuredHost()`, and always point
 *  Traefik at it. Returns its public PEM. */
export async function ensureSelfSignedCert(host = configuredHost()): Promise<string> {
  await fs.mkdir(DYNAMIC_DIR, { recursive: true });
  if (!(await certUsable(host))) {
    const san = isIp(host) ? `IP:${host}` : `DNS:${host}`;
    await execFileP('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', KEY, '-out', CERT,
      '-days', '3650', '-subj', `/CN=${host}`,
      '-addext', `subjectAltName=${san}`,
    ]);
  }
  await writeTlsConf();
  return fs.readFile(CERT, 'utf8');
}

/** The route to the api, and which certificate serves it.
 *
 *  No domain → a catch-all router with `tls: {}`, which resolves to the default
 *  certificate written by `writeTlsConf`. Domain → `Host(...)` with the Let's
 *  Encrypt resolver, which owns the certificate itself.
 *
 *  The IP-in-COMPANION_DOMAIN case never reaches here: `normalizeTlsEnv`
 *  (server.ts) settles it before anything reads either variable. That used to be
 *  re-decided in the sidecar, which is a different container and could not see
 *  the first answer — two implementations of one decision, kept in agreement by
 *  hand. */
export async function writeRouter(domain: string): Promise<void> {
  await fs.mkdir(DYNAMIC_DIR, { recursive: true });
  const tls = domain ? `
        certResolver: le` : ' {}';
  const rule = domain ? `Host(\`${domain}\`)` : 'PathPrefix(`/`)';
  await writeAtomic(ROUTER_CONF, `http:
  routers:
    api:
      rule: "${rule}"
      entryPoints: ["websecure"]
      service: api
      tls:${tls}
  services:
    api:
      loadBalancer:
        servers:
          - url: "${BACKEND}"
`);
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
