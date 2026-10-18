import { describe, expect, it } from 'vitest';
import { calculateSettlement, SettlementError, type FrozenTerm } from '../src/modules/settlements/engine';

const term = (id: string, overrides: Partial<FrozenTerm> = {}): FrozenTerm => ({
  licenseId: `lic_${id}`,
  assetVersionId: `av_${id}`,
  assetTitle: `Asset ${id}`,
  contributorId: `user_${id}`,
  payeeEmail: `${id}@contributor.example`,
  economics: { kind: 'percent_of_gross', bps: 2500 },
  payableOn: 'included_in_build',
  citedInOutput: true,
  ...overrides,
});

const settle = (terms: FrozenTerm[], gross = 2000) =>
  calculateSettlement({ verifiedGrossCents: gross, currency: 'USD', publisherId: 'pub', terms });

describe('settlement engine', () => {
  it('reproduces the illustrative $20 split exactly', () => {
    const r = settle([
      term('a', { economics: { kind: 'percent_of_gross', bps: 2500 } }),
      term('b', { economics: { kind: 'percent_of_gross', bps: 1500 } }),
      term('c', { economics: { kind: 'percent_of_gross', bps: 1000 } }),
    ]);
    expect(r.lines.map((l) => [l.recipientId, l.amountCents])).toEqual([
      ['user_a', 500],
      ['user_b', 300],
      ['user_c', 200],
      ['pub', 1000],
    ]);
    expect(r.contributorTotalCents + r.publisherResidualCents).toBe(2000);
  });

  it('always reconciles to the gross amount, flooring shares and giving the remainder to the publisher', () => {
    for (const gross of [1, 7, 333, 1999, 2001, 123457]) {
      const r = settle(
        [
          term('a', { economics: { kind: 'percent_of_gross', bps: 3333 } }),
          term('b', { economics: { kind: 'percent_of_gross', bps: 3333 } }),
        ],
        gross,
      );
      const sum = r.lines.reduce((s, l) => s + l.amountCents, 0);
      expect(sum).toBe(gross);
      for (const l of r.lines) expect(Number.isInteger(l.amountCents)).toBe(true);
    }
  });

  it('pays a cited_in_output source nothing when the output did not cite it', () => {
    const r = settle([term('a'), term('b', { payableOn: 'cited_in_output', citedInOutput: false })]);
    const b = r.lines.find((l) => l.recipientId === 'user_b')!;
    expect(b).toMatchObject({ amountCents: 0, payable: false });
    expect(r.publisherResidualCents).toBe(1500);
  });

  it('applies fixed per-sale fees', () => {
    const r = settle([term('a', { economics: { kind: 'fixed_per_sale', amountCents: 250 } })]);
    expect(r.lines[0]).toMatchObject({ amountCents: 250, payable: true });
    expect(r.publisherResidualCents).toBe(1750);
  });

  it('rejects percentage terms above 100%', () => {
    expect(() =>
      settle([
        term('a', { economics: { kind: 'percent_of_gross', bps: 7000 } }),
        term('b', { economics: { kind: 'percent_of_gross', bps: 4000 } }),
      ]),
    ).toThrow(SettlementError);
  });

  it('rejects obligations that exceed the verified sale', () => {
    expect(() => settle([term('a', { economics: { kind: 'fixed_per_sale', amountCents: 5000 } })])).toThrow(/exceed/);
  });

  it('rejects zero, negative and fractional gross amounts', () => {
    expect(() => settle([term('a')], 0)).toThrow(SettlementError);
    expect(() => settle([term('a')], -100)).toThrow(RangeError);
    expect(() => settle([term('a')], 19.99)).toThrow(RangeError);
  });

  it('refuses a payable line with no payee', () => {
    expect(() => settle([term('a', { payeeEmail: null })])).toThrow(/no payee/);
  });

  it('never marks the publisher residual as a payout', () => {
    const r = settle([term('a')]);
    expect(r.lines.at(-1)).toMatchObject({ kind: 'publisher_residual', payable: false });
  });
});
