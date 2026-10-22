import { describe, expect, it } from 'vitest';
import { calculateSettlement, SettlementError, type FrozenTerm } from '../src/modules/settlements/engine';
import { describeFormula } from '@tracepay/shared';

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

describe('formulas in plain words', () => {
  it('describes every formula the engine writes', () => {
    const r = calculateSettlement({
      verifiedGrossCents: 2000,
      currency: 'USD',
      publisherId: 'pub',
      terms: [
        { licenseId: 'a', assetVersionId: 'a', assetTitle: 'A', contributorId: 'ca', payeeEmail: 'a@x', economics: { kind: 'percent_of_gross', bps: 2500 }, payableOn: 'included_in_build', citedInOutput: true },
        { licenseId: 'b', assetVersionId: 'b', assetTitle: 'B', contributorId: 'cb', payeeEmail: 'b@x', economics: { kind: 'fixed_per_sale', amountCents: 200 }, payableOn: 'included_in_build', citedInOutput: true },
        { licenseId: 'c', assetVersionId: 'c', assetTitle: 'C', contributorId: 'cc', payeeEmail: 'c@x', economics: { kind: 'percent_of_gross', bps: 1000 }, payableOn: 'cited_in_output', citedInOutput: false },
        { licenseId: 'd', assetVersionId: 'd', assetTitle: 'D', contributorId: 'cd', payeeEmail: null, economics: { kind: 'none' }, payableOn: 'included_in_build', citedInOutput: true },
      ],
    });
    expect(r.lines.map((l) => describeFormula(l.formula))).toEqual([
      '25% of $20.00',
      '$2.00 for each sale',
      'Nothing: the license pays only when the report cites it, and it didn’t',
      'Nothing: the license has no payment',
      'What’s left of $20.00 after contributors’ shares',
    ]);
    // Every engine formula has a plain description (none falls through unchanged).
    for (const l of r.lines) expect(describeFormula(l.formula)).not.toBe(l.formula);
  });
});
