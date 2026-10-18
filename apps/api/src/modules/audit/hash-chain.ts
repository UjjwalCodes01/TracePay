import { createHash } from 'node:crypto';

/** Deterministic JSON: object keys sorted recursively, no whitespace. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value instanceof Date) return value.toISOString();
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

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
