import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number, options: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;

// OWASP-recommended scrypt parameters (N=2^17, r=8, p=1).
const PARAMS = { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
const KEYLEN = 32;

/**
 * Each scrypt derivation takes ~128 MiB and real CPU, so concurrent derivations
 * are capped and the waiting queue is bounded. Excess login/signup bursts get a
 * clear "busy" error instead of exhausting the server's memory.
 */
const MAX_CONCURRENT = 4;
const MAX_QUEUED = 64;
let active = 0;
const waiting: Array<() => void> = [];

export class CryptoBusyError extends Error {}

async function withScryptSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT) {
    if (waiting.length >= MAX_QUEUED) throw new CryptoBusyError('Too many sign-in attempts right now. Try again in a moment.');
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

/** Format: scrypt$N$r$p$<salt b64>$<hash b64> — parameters travel with the hash so they can be raised later. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await withScryptSlot(() => scryptAsync(password.normalize('NFKC'), salt, KEYLEN, PARAMS));
  return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, n, r, p, saltB64, hashB64] = stored.split('$');
  if (algo !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await withScryptSlot(() =>
    scryptAsync(password.normalize('NFKC'), Buffer.from(saltB64, 'base64'), expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: PARAMS.maxmem,
    }),
  );
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** A hash computed even when the user doesn't exist, so login timing doesn't reveal valid emails. */
export const DUMMY_PASSWORD_HASH = 'scrypt$131072$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
