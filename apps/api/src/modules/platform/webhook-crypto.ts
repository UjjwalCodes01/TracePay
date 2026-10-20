import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Webhook signing, TracePay → receiver.
 *
 *   TracePay-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
 *
 * During a secret rotation the header carries one v1 per valid secret, so
 * receivers can switch secrets without dropping events. Receivers should reject
 * timestamps outside a tolerance window (5 minutes) to stop replays.
 */

export const SIGNATURE_HEADER = 'TracePay-Signature';
export const SIGNATURE_TOLERANCE_SECONDS = 300;
const SECRET_PREFIX = 'whsec_';

export function generateWebhookSecret(): string {
  return `${SECRET_PREFIX}${randomBytes(32).toString('base64url')}`;
}

export function computeSignature(secret: string, timestamp: number, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

export function signatureHeader(secrets: string[], timestamp: number, body: string): string {
  return [`t=${timestamp}`, ...secrets.map((s) => `v1=${computeSignature(s, timestamp, body)}`)].join(',');
}

/**
 * Reference verifier (also documented for receivers). Accepts the request if ANY
 * v1 signature matches and the timestamp is within the tolerance window.
 */
export function verifyWebhookSignature(args: {
  header: string | undefined;
  body: string;
  secret: string;
  toleranceSeconds?: number;
  now?: number;
}): boolean {
  if (!args.header) return false;
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of args.header.split(',')) {
    const [k, v] = part.split('=', 2).map((s) => s?.trim());
    if (k === 't' && v && /^\d{1,12}$/.test(v)) timestamp = Number(v);
    else if (k === 'v1' && v && /^[0-9a-f]{64}$/.test(v)) signatures.push(v);
  }
  if (timestamp === null || signatures.length === 0) return false;
  const now = args.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > (args.toleranceSeconds ?? SIGNATURE_TOLERANCE_SECONDS)) return false;
  const expected = Buffer.from(computeSignature(args.secret, timestamp, args.body), 'hex');
  return signatures.some((s) => {
    const got = Buffer.from(s, 'hex');
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}

/**
 * Encrypts signing secrets at rest (AES-256-GCM). They must be recoverable to
 * sign deliveries, so they can't be hashed like API keys; a database leak alone
 * doesn't reveal them.
 */
export class SecretBox {
  /** keys[0] seals; every key is tried when opening, so adding or rotating the key never strands old secrets. */
  private constructor(private readonly keys: Buffer[]) {}

  /**
   * WEBHOOK_SECRET_KEY: 32 random bytes as base64 or hex. Without it the key is
   * derived (HKDF) from the audit signing key, so a deployment works out of the
   * box. The derived key stays a fallback for opening, so setting (or later
   * changing) WEBHOOK_SECRET_KEY keeps existing endpoints working; previous
   * explicit keys can be listed in WEBHOOK_SECRET_KEY_PREVIOUS (comma-separated).
   */
  static fromEnv(explicitKey: string | undefined, fallbackMaterial: string, previousKeys?: string): SecretBox {
    const derived = fallbackMaterial ? Buffer.from(hkdfSync('sha256', fallbackMaterial, 'tracepay', 'webhook-secret-encryption/v1', 32)) : null;
    const explicit = explicitKey?.trim() ? parseKey(explicitKey.trim(), 'WEBHOOK_SECRET_KEY') : null;
    const previous = (previousKeys ?? '').split(',').map((k) => k.trim()).filter(Boolean).map((k) => parseKey(k, 'WEBHOOK_SECRET_KEY_PREVIOUS'));
    const keys = [explicit, ...previous, derived].filter((k): k is Buffer => k !== null);
    if (keys.length === 0) throw new Error('No key material for webhook secret encryption.');
    return new SecretBox(keys);
  }

  static forTests(): SecretBox {
    return new SecretBox([randomBytes(32)]);
  }

  seal(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.keys[0]!, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64url'), ct.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.');
  }

  open(sealed: string): string {
    const [version, iv, ct, tag] = sealed.split('.');
    if (version !== 'v1' || !iv || !ct || !tag) throw new Error('Unrecognised sealed secret.');
    for (const key of this.keys) {
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
        decipher.setAuthTag(Buffer.from(tag, 'base64url'));
        return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
      } catch {
        // Wrong key (authentication failed): try the next one.
      }
    }
    throw new Error('Cannot decrypt the webhook secret with any configured key.');
  }
}

function parseKey(value: string, name: string): Buffer {
  const key = /^[0-9a-f]{64}$/i.test(value) ? Buffer.from(value, 'hex') : Buffer.from(value, 'base64');
  if (key.length !== 32) throw new Error(`${name} must be 32 bytes, encoded as base64 or hex.`);
  return key;
}
