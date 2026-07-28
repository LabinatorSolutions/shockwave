// Self-signed TLS for the Telegram webhook, for a PUBLIC server with no domain.
// Telegram accepts a self-signed cert if you upload its public PEM to setWebhook
// (see connect()). We: detect the server's public IP, generate a cert whose CN/SAN
// is that IP, and write it + a Traefik dynamic-TLS config so Traefik serves it as
// the default cert. The PEM is returned for the setWebhook upload.
//
// When COMPANION_DOMAIN IS set (a real domain w/ Let's Encrypt, or an ngrok host
// with ngrok's own cert), none of this runs — the cert is already trusted.

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

// Ask the outside world for our public IP (a NAT'd box can't know it locally, but
// this deployment is a public server, so the answer is directly reachable).
export async function detectPublicIp(): Promise<string> {
  const res = await fetch('https://api.ipify.org');
  const ip = (await res.text()).trim();
  if (!isIp(ip)) throw new Error(`could not detect public IP (got: ${JSON.stringify(ip).slice(0, 40)})`);
  return ip;
}

// Generate a self-signed cert for `host` (IP or domain), write it + a Traefik
// dynamic TLS config that serves it as the DEFAULT cert (so an SNI-less / IP
// request gets it, not Traefik's throwaway default). Returns the public cert PEM.
// Regenerates on every call, so a changed host yields a matching cert.
export async function ensureSelfSignedCert(host: string): Promise<string> {
  await fs.mkdir(DYNAMIC_DIR, { recursive: true });
  const san = isIp(host) ? `IP:${host}` : `DNS:${host}`;
  await execFileP('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', KEY, '-out', CERT,
    '-days', '3650', '-subj', `/CN=${host}`,
    '-addext', `subjectAltName=${san}`,
  ]);
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
