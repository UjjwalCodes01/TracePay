import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import { canonicalJson } from './hash-chain';

/**
 * Ed25519 receipt signing. The private key lives only in the server env
 * (base64 PKCS#8 DER); the public key is published so anyone can verify an
 * exported receipt without trusting TracePay's database.
 */

export interface SigningKeys {
  privateKey: KeyObject;
  publicKey: KeyObject;
}

export function generateSigningKeys(): { privateKeyB64: string; publicKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKeyB64: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
  };
}

export function loadSigningKeys(privateKeyB64: string): SigningKeys {
  const privateKey = createPrivateKey({ key: Buffer.from(privateKeyB64, 'base64'), format: 'der', type: 'pkcs8' });
  return { privateKey, publicKey: createPublicKey(privateKey) };
}

export function publicKeyPem(keys: SigningKeys): string {
  return keys.publicKey.export({ format: 'pem', type: 'spki' }).toString();
}

export function signDocument(document: unknown, keys: SigningKeys): string {
  return sign(null, Buffer.from(canonicalJson(document)), keys.privateKey).toString('base64');
}

export function verifyDocument(document: unknown, signatureB64: string, publicKeyPemText: string): boolean {
  return verify(
    null,
    Buffer.from(canonicalJson(document)),
    createPublicKey(publicKeyPemText),
    Buffer.from(signatureB64, 'base64'),
  );
}
