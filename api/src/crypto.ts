// AES-256-GCM seal/unseal — the server holds the one master key (from MASTER_KEY
// env) and does all secret encryption/decryption. Clients never see ciphertext.
// Fresh 12-byte IV per write. Returns '' on decrypt failure so one bad row can't
// take down a whole read.

import crypto from 'node:crypto';

const IV_BYTES = 12;

export interface Sealed { value: string; iv: Buffer; tag: Buffer; }

export function seal(key: Buffer, plain: string): Sealed {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return { value: ct.toString('base64'), iv, tag: cipher.getAuthTag() };
}

export function unseal(key: Buffer, sealed: { value: string; iv: Buffer | null; tag: Buffer | null }): string {
  if (!sealed.iv || !sealed.tag) return '';
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv));
    d.setAuthTag(Buffer.from(sealed.tag));
    return Buffer.concat([d.update(Buffer.from(sealed.value, 'base64')), d.final()]).toString('utf8');
  } catch (err: any) {
    console.warn('[secrets] decrypt failed:', err?.message ?? err);
    return '';
  }
}
