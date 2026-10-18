import { describe, expect, it } from 'vitest';
import { DEMO_ASSETS } from '../src/modules/demo/world';
import { extractWithRules, findDate } from '../src/modules/licenses/extract';

const TODAY = '2026-10-19';

describe('rule-based license extraction', () => {
  // The demo licenses are plain-English documents; their approved terms are the ground truth.
  for (const asset of DEMO_ASSETS) {
    it(`drafts the approved terms for "${asset.title}"`, () => {
      const { terms } = extractWithRules(asset.licenseText, TODAY);
      const { validFrom: _a, ...expected } = asset.terms;
      const { validFrom: _b, ...actual } = terms;
      expect(actual).toEqual(expected);
    });
  }

  it('quotes the sentence each value came from', () => {
    const okafor = DEMO_ASSETS.find((a) => a.id === 'asset_okafor_notes')!;
    const { evidence } = extractWithRules(okafor.licenseText, TODAY);
    const econ = evidence.find((e) => e.field === 'economics')!;
    expect(econ.confidence).toBe('high');
    expect(okafor.licenseText).toContain(econ.quote!.replace(/…$/, ''));
  });

  it('chooses the restrictive reading and warns when the document is silent', () => {
    const r = extractWithRules('You may read this dataset.', TODAY);
    expect(r.terms).toMatchObject({
      commercialUse: false,
      allowedPurposes: ['internal_research'],
      rawRedistribution: false,
      economics: { kind: 'none' },
      territories: null,
      validFrom: TODAY,
      validUntil: null,
    });
    expect(r.warnings.length).toBeGreaterThanOrEqual(3);
  });

  it('reads prohibitions, territories and fixed fees', () => {
    const r = extractWithRules(
      'Commercial use is allowed only in the United Kingdom and Ireland. Derivative works are not permitted. Fee: $4.50 per copy sold. This license expires on March 3, 2028.',
      TODAY,
    );
    expect(r.terms).toMatchObject({
      commercialUse: true,
      derivativeReports: 'prohibited',
      territories: ['GB', 'IE'],
      economics: { kind: 'fixed_per_sale', amountCents: 450 },
      validUntil: '2028-03-03',
    });
  });

  it('parses common date formats and rejects impossible dates', () => {
    expect(findDate('until 31 Dec 2027')).toBe('2027-12-31');
    expect(findDate('through September 30, 2026')).toBe('2026-09-30');
    expect(findDate('ends 2027-01-15')).toBe('2027-01-15');
    expect(findDate('on 31 February 2027')).toBeNull();
  });
});
