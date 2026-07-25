// The desktop's connection to the Shockwave API: URL + API key, in
// <userData>/api.json (mode 0600, tmp+rename). The key is protected with
// Electron safeStorage (OS keychain) — the only local encryption left, and it's
// just for this one credential, not the app's secrets (those live server-side).

import fs from 'node:fs';
import path from 'node:path';
import { app, safeStorage } from 'electron';

export interface ApiConfig {
  url: string;
  apiKey: string;   // plaintext in memory; safeStorage-wrapped on disk
}

const DEFAULT: ApiConfig = { url: '', apiKey: '' };

function file(): string {
  return path.join(app.getPath('userData'), 'api.json');
}

interface OnDisk { url?: string; apiKey?: string | null } // apiKey = base64 safeStorage blob

export function readApiConfig(): ApiConfig {
  let parsed: OnDisk;
  try { parsed = JSON.parse(fs.readFileSync(file(), 'utf8')); }
  catch { return { ...DEFAULT }; }
  let apiKey = '';
  if (parsed.apiKey) {
    try { apiKey = safeStorage.decryptString(Buffer.from(parsed.apiKey, 'base64')); }
    catch { apiKey = ''; } // keychain changed → re-enter the key, not a crash
  }
  return { url: parsed.url ?? '', apiKey };
}

export function writeApiConfig(cfg: Partial<ApiConfig>): ApiConfig {
  const next: ApiConfig = { ...readApiConfig(), ...cfg };
  const onDisk: OnDisk = {
    url: next.url,
    apiKey: next.apiKey && safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(next.apiKey).toString('base64')
      : (next.apiKey || null),
  };
  const f = file();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(onDisk), { mode: 0o600 });
  fs.renameSync(tmp, f);
  return next;
}

export function isConfigured(): boolean {
  const c = readApiConfig();
  return !!(c.url && c.apiKey);
}
