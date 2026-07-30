// The desktop's HTTP client for the Shockwave API. Every data operation the app
// used to do against the local DB now goes through here. Connected → the server;
// unreachable → a typed error the caller surfaces as a notification (there's no
// local fallback — no local DB).

import { readApiConfig } from './config.js';
import { companionFetch, getPendingCert, hostOf, clearPendingCert, type PendingCert } from './net.js';

// 'needsApproval' is deliberately separate from 'unreachable': the server
// answered, the app just held the connection because its certificate isn't the
// approved one. Reporting that as offline would be a lie, would look identical
// to the server being down, and would give the user no route to the one screen
// that can resolve it.
export type ApiErrorKind = 'unreachable' | 'unauthorized' | 'server' | 'config' | 'needsApproval';

export class ApiError extends Error {
  kind: ApiErrorKind;
  /** Present on 'needsApproval' — the offered and previously-approved fingerprints. */
  cert?: PendingCert;
  constructor(kind: ApiErrorKind, message: string, cert?: PendingCert) {
    super(message);
    this.kind = kind;
    if (cert) this.cert = cert;
    this.name = 'ApiError';
  }
}

// A held connection surfaces as a generic fetch failure, so tell the two apart by
// whether the verify proc parked a certificate for THIS host moments ago.
function transportError(err: any, url: string): ApiError {
  const cert = getPendingCert(hostOf(url));
  if (cert) {
    return new ApiError(
      'needsApproval',
      cert.approved
        ? "The server's certificate has changed. Review it in Settings → Companion."
        : 'This server needs to be approved in Settings → Companion.',
      cert,
    );
  }
  return new ApiError('unreachable', `Can't reach the Shockwave server: ${err?.message ?? err}`);
}

const TIMEOUT_MS = 8000;

function base(): { url: string; apiKey: string } {
  const c = readApiConfig();
  if (!c.url || !c.apiKey) throw new ApiError('config', 'The Shockwave server is not configured.');
  return c;
}

async function request(method: string, pathname: string, body?: any): Promise<any> {
  const { url, apiKey } = base();
  const target = new URL(pathname.replace(/^\//, ''), url.endsWith('/') ? url : `${url}/`).href;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await companionFetch(target, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
  } catch (err: any) {
    throw transportError(err, target);
  } finally {
    clearTimeout(timer);
  }
  // Got a response, so the certificate was accepted — drop any parked one so a
  // stale entry can't be offered for approval later.
  clearPendingCert();
  if (res.status === 401) throw new ApiError('unauthorized', 'The server rejected the API key.');
  if (!res.ok) throw new ApiError('server', `Server error (HTTP ${res.status}).`);
  if (res.status === 204) return null;
  const json = await res.json().catch(() => ({}));
  return json.result ?? json;
}

export const api = {
  get: (p: string) => request('GET', p),
  patch: (p: string, body: any) => request('PATCH', p, body),
  post: (p: string, body?: any) => request('POST', p, body ?? {}),
  del: (p: string) => request('DELETE', p),
  // Reachability probe for the Connect flow. Reports a certificate awaiting
  // approval separately from a plain failure, so Settings can show the
  // fingerprint and ask, rather than saying "couldn't reach it" about a server
  // that is plainly up. NEVER approves anything — it only reports.
  async health(url: string, apiKey: string): Promise<{ ok: boolean; cert?: PendingCert }> {
    const t = new URL('health', url.endsWith('/') ? url : `${url}/`).href;
    try {
      const r = await companionFetch(t, { headers: { Authorization: `Bearer ${apiKey}` } });
      clearPendingCert(); // answered ⇒ certificate accepted
      return { ok: r.ok };
    } catch {
      const cert = getPendingCert(hostOf(t));
      return cert ? { ok: false, cert } : { ok: false };
    }
  },
  // Open a long-lived Server-Sent Events stream. `onEvent` fires per `data:`
  // frame (parsed JSON); `onClose` fires once when the stream ends for any
  // reason (abort, drop, non-2xx) so the caller can reconnect. Returns an abort
  // fn. No timeout — it stays open until aborted or the connection drops.
  stream(pathname: string, onEvent: (evt: any) => void, onClose?: () => void): () => void {
    const { url, apiKey } = base();
    const target = new URL(pathname.replace(/^\//, ''), url.endsWith('/') ? url : `${url}/`).href;
    const ctrl = new AbortController();
    let aborted = false;
    (async () => {
      try {
        const res = await companionFetch(target, {
          headers: { Authorization: `Bearer ${apiKey}`, Accept: 'text/event-stream' },
          signal: ctrl.signal,
        });
        if (!res.ok || !res.body) return;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
            for (const line of frame.split('\n')) {
              if (!line.startsWith('data:')) continue; // skip `:` comments/pings
              const data = line.slice(5).trim();
              if (data) { try { onEvent(JSON.parse(data)); } catch { /* malformed frame */ } }
            }
          }
        }
      } catch { /* aborted or connection dropped */ }
      if (!aborted) onClose?.(); // dropped on its own → caller reconnects
    })();
    return () => { aborted = true; ctrl.abort(); }; // deliberate stop → no onClose, no reconnect
  },
};
