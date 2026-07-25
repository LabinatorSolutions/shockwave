// The desktop's HTTP client for the Shockwave API. Every data operation the app
// used to do against the local DB now goes through here. Connected → the server;
// unreachable → a typed error the caller surfaces as a notification (there's no
// local fallback — no local DB).

import { readApiConfig } from './config.js';

export type ApiErrorKind = 'unreachable' | 'unauthorized' | 'server' | 'config';

export class ApiError extends Error {
  kind: ApiErrorKind;
  constructor(kind: ApiErrorKind, message: string) {
    super(message);
    this.kind = kind;
    this.name = 'ApiError';
  }
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
    res = await fetch(target, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
  } catch (err: any) {
    throw new ApiError('unreachable', `Can't reach the Shockwave server: ${err?.message ?? err}`);
  } finally {
    clearTimeout(timer);
  }
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
  // Reachability probe for the connect/test flow.
  async health(url: string, apiKey: string): Promise<boolean> {
    const t = new URL('health', url.endsWith('/') ? url : `${url}/`).href;
    try {
      const r = await fetch(t, { headers: { Authorization: `Bearer ${apiKey}` } });
      return r.ok;
    } catch { return false; }
  },
};
