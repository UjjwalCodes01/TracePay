import { createHash } from 'node:crypto';

import { canonicalJson } from '@tracepay/shared';

/** Deterministic JSON: object keys sorted recursively, no whitespace — one definition for signing here and checking in the browser. */
export { canonicalJson };

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

export const GENESIS_HASH = '0'.repeat(64);

export interface ChainEntry {
  entityType: string;
  entityId: string;
  eventType: string;
  payload: unknown;
  createdAt: string;
}

/** hash_n = sha256(hash_{n-1} || canonical(entry_n)). Editing any entry breaks every later hash. */
export function chainHash(previousHash: string, entry: ChainEntry): string {
  return sha256Hex(previousHash + canonicalJson(entry));
}

export interface StoredChainEntry extends ChainEntry {
  previousHash: string;
  hash: string;
}

export function verifyChain(entries: StoredChainEntry[]): { ok: true } | { ok: false; brokenAt: number } {
  let prev = GENESIS_HASH;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    const { previousHash, hash, ...entry } = e;
    if (previousHash !== prev || chainHash(prev, entry) !== hash) return { ok: false, brokenAt: i };
    prev = hash;
  }
  return { ok: true };
}
