import { canonicalJson } from '@tracepay/shared';
import { post } from './api';

/**
 * Checks a TracePay receipt's Ed25519 signature in the browser, with WebCrypto: nothing is sent
 * anywhere, so the answer doesn't depend on trusting TracePay's server. The key's fingerprint is
 * shown too, to compare with the one TracePay publishes (README, /api/audit/public-key).
 */

export interface Verification {
  valid: boolean;
  /** Where the check ran: this browser, or (if it can't check Ed25519) TracePay's server. */
  where: 'browser' | 'server';
  /** SHA-256 of the public key (SPKI), grouped for reading aloud: "3f2a 9c01 …". */
  fingerprint: string | null;
}

const fromBase64 = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const spkiOf = (pem: string) => fromBase64(pem.replace(/-----(BEGIN|END) PUBLIC KEY-----/g, '').replace(/\s+/g, ''));

/** SHA-256 of the key, as "3f2a 9c01 …" (16 groups). */
export async function keyFingerprint(publicKeyPem: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', spkiOf(publicKeyPem)));
  return [...digest]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .match(/.{4}/g)!
    .join(' ');
}

export async function verifyReceipt(r: { document: unknown; signature: string; publicKeyPem: string }): Promise<Verification> {
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey('spki', spkiOf(r.publicKeyPem), { name: 'Ed25519' }, false, ['verify']);
  } catch {
    // An older browser without Ed25519 in WebCrypto: ask TracePay's server instead, and say so.
    const { valid } = await post<{ valid: boolean }>('/receipts/verify', { document: r.document, signature: r.signature, publicKeyPem: r.publicKeyPem });
    return { valid, where: 'server', fingerprint: null };
  }
  const valid = await crypto.subtle.verify({ name: 'Ed25519' }, key, fromBase64(r.signature), new TextEncoder().encode(canonicalJson(r.document)));
  return { valid, where: 'browser', fingerprint: await keyFingerprint(r.publicKeyPem) };
}
