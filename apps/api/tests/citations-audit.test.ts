import { describe, expect, it } from 'vitest';
import { centsToDecimal, decimalToCents } from '@tracepay/shared';
import { validateCitations, type DraftSection, type RetrievedChunk } from '../src/modules/generation/citations';
import { chainHash, GENESIS_HASH, verifyChain, type StoredChainEntry } from '../src/modules/audit/hash-chain';
import { generateSigningKeys, loadSigningKeys, publicKeyPem, signDocument, verifyDocument } from '../src/modules/audit/signing';

const retrieved: RetrievedChunk[] = [
  { handle: 'C1', chunkId: 'chunk_a1', assetVersionId: 'av_a' },
  { handle: 'C2', chunkId: 'chunk_b1', assetVersionId: 'av_b' },
  { handle: 'C3', chunkId: 'chunk_d1', assetVersionId: 'av_d' },
];

const section = (key: string, body: string, requiresCitation = true): DraftSection => ({ key, heading: key, body, requiresCitation });

describe('citation validation', () => {
  it('resolves handles to recorded chunks and reports retrieved-but-uncited sources', () => {
    const r = validateCitations([section('f1', 'Spend grew 12% [C1] driven by AI tooling [C2] [C1].'), section('outlook', 'Positive.', false)], retrieved);
    expect(r.ok).toBe(true);
    expect(r.citations.map((c) => c.chunkId)).toEqual(['chunk_a1', 'chunk_b1']);
    expect(r.citedAssetVersionIds).toEqual(['av_a', 'av_b']);
    expect(r.retrievedNotCitedAssetVersionIds).toEqual(['av_d']);
  });

  it('rejects an invented source reference', () => {
    const r = validateCitations([section('f1', 'A bold claim [C9].')], retrieved);
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatchObject({ reason: 'unknown_reference', handle: 'C9' });
  });

  it('rejects an uncited finding', () => {
    const r = validateCitations([section('f1', 'An unsupported claim.')], retrieved);
    expect(r.errors[0]).toMatchObject({ reason: 'missing_citation' });
  });
});

describe('audit hash chain', () => {
  const build = (payloads: unknown[]): StoredChainEntry[] => {
    let prev = GENESIS_HASH;
    return payloads.map((payload, i) => {
      const entry = { entityType: 'sale', entityId: 's1', eventType: `e${i}`, payload, createdAt: `2026-10-18T00:00:0${i}.000Z` };
      const hash = chainHash(prev, entry);
      const stored = { ...entry, previousHash: prev, hash };
      prev = hash;
      return stored;
    });
  };

  it('verifies an untouched chain and detects an edited entry', () => {
    const chain = build([{ amount: 2000 }, { status: 'COMPLETED' }, { payout: 'PENDING' }]);
    expect(verifyChain(chain)).toEqual({ ok: true });
    chain[1]!.payload = { status: 'REFUNDED' };
    expect(verifyChain(chain)).toEqual({ ok: false, brokenAt: 1 });
  });

  it('is insensitive to object key order', () => {
    const e = { entityType: 'x', entityId: '1', eventType: 'y', createdAt: 't', payload: { b: 1, a: 2 } };
    expect(chainHash(GENESIS_HASH, e)).toBe(chainHash(GENESIS_HASH, { ...e, payload: { a: 2, b: 1 } }));
  });
});

describe('receipt signing', () => {
  it('verifies with the public key and fails after tampering', () => {
    const keys = loadSigningKeys(generateSigningKeys().privateKeyB64);
    const receipt = { saleId: 's1', grossCents: 2000, lines: [{ to: 'a', cents: 500 }] };
    const sig = signDocument(receipt, keys);
    expect(verifyDocument(receipt, sig, publicKeyPem(keys))).toBe(true);
    expect(verifyDocument({ ...receipt, grossCents: 2001 }, sig, publicKeyPem(keys))).toBe(false);
  });
});

describe('money', () => {
  it('converts between PayPal decimals and cents exactly', () => {
    expect(decimalToCents('20.00')).toBe(2000);
    expect(decimalToCents('0.5')).toBe(50);
    expect(decimalToCents('19.99')).toBe(1999);
    expect(centsToDecimal(1999)).toBe('19.99');
    expect(centsToDecimal(5)).toBe('0.05');
    expect(() => decimalToCents('1.999')).toThrow();
    expect(() => decimalToCents('-1')).toThrow();
  });
});
