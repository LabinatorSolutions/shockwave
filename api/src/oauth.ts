// Server-side OAuth token minting. The refresh grant is a pure fetch, so it runs
// on the companion for BOTH consumers: server cron runs, and the desktop agent
// (which now fetches /agent-secret/:name/token instead of refreshing locally).
// One refresh implementation, no local/remote divergence. The interactive
// CONNECT flow stays on the desktop; only refresh lives here.

import type { Db } from './db.js';
import * as store from './store.js';

const EXPIRY_SKEW_MS = 60_000;

// A usable credential for one secret by name: static → the stored token; oauth →
// a fresh access token (refreshed if expired), written back to the store.
export async function mintToken(db: Db, key: Buffer, name: string): Promise<string> {
  const settings = await store.readSettings(db, key);
  const secret = (settings.agentSecrets ?? []).find((s: any) => s.name === name);
  if (!secret) throw new Error(`No secret named "${name}". Call list_agent_secrets to see available names.`);
  if (secret.oauth) return getFreshToken(db, key, name, secret.oauth);
  return secret.token ?? '';
}

async function getFreshToken(db: Db, key: Buffer, name: string, o: any): Promise<string> {
  const fresh = o.expiresAt == null || o.expiresAt - EXPIRY_SKEW_MS > Date.now();
  if (fresh && o.accessToken) return o.accessToken;

  if (!o.refreshToken || !o.tokenUrl) {
    await store.patchOAuth(db, key, name, { status: 'expired' }).catch(() => {});
    throw new Error(`The "${name}" connection has expired — reconnect it in Settings.`);
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: o.refreshToken,
    client_id: o.clientId ?? '',
    client_secret: o.clientSecret ?? '',
  });
  let json: any;
  try {
    const res = await fetch(o.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body.toString(),
    });
    if (!res.ok) throw new Error(`token endpoint ${res.status}`);
    json = await res.json();
  } catch {
    await store.patchOAuth(db, key, name, { status: 'expired' }).catch(() => {});
    throw new Error(`Could not refresh the "${name}" connection — reconnect it in Settings.`);
  }

  const accessToken = json.access_token;
  if (!accessToken) {
    await store.patchOAuth(db, key, name, { status: 'expired' }).catch(() => {});
    throw new Error(`Could not refresh the "${name}" connection — reconnect it in Settings.`);
  }
  const expiresAt = typeof json.expires_in === 'number' ? Date.now() + json.expires_in * 1000 : null;
  const refreshToken = json.refresh_token ?? o.refreshToken; // some providers rotate it
  await store.patchOAuth(db, key, name, { accessToken, refreshToken, expiresAt, status: 'connected' });
  return accessToken;
}
