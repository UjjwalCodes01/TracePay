import type { BuildIntent, LicenseTerms } from '@tracepay/shared';
import type { CompilerSource } from '../src/modules/license-compiler/compiler';

export const AS_OF = '2026-10-18';

export const commercialIntent: BuildIntent = {
  title: 'Developer Tools Market Brief, Q4 2026',
  brief: 'Five findings on the developer-tools market with a short outlook.',
  purpose: 'commercial_report',
  distribution: 'sale',
  includesRawData: false,
  territory: 'US',
  priceCents: 2000,
  currency: 'USD',
};

export function terms(overrides: Partial<LicenseTerms> = {}): LicenseTerms {
  return {
    commercialUse: true,
    derivativeReports: 'allowed',
    rawRedistribution: false,
    allowedPurposes: ['internal_research', 'commercial_report'],
    territories: null,
    validFrom: '2026-01-01',
    validUntil: '2027-12-31',
    attributionText: null,
    economics: { kind: 'percent_of_gross', bps: 2500 },
    payableOn: 'included_in_build',
    currency: 'USD',
    ...overrides,
  };
}

export function source(id: string, t: LicenseTerms, extra: Partial<CompilerSource> = {}): CompilerSource {
  return {
    assetId: `asset_${id}`,
    assetTitle: `Asset ${id.toUpperCase()}`,
    assetVersionId: `av_${id}_v1`,
    contributorName: `Contributor ${id.toUpperCase()}`,
    payeeEmail: `${id}@contributor.example`,
    license: { id: `lic_${id}`, status: 'approved', terms: t },
    ...extra,
  };
}

/** The demo set: A and B are fine, C is internal-research only. */
export const marketDataA = source('a', terms({ economics: { kind: 'percent_of_gross', bps: 2500 } }));
export const researchNotesB = source(
  'b',
  terms({
    derivativeReports: 'allowed_with_attribution',
    attributionText: 'Analysis courtesy of Contributor B',
    economics: { kind: 'percent_of_gross', bps: 1500 },
    payableOn: 'cited_in_output',
  }),
);
export const internalOnlyC = source(
  'c',
  terms({ commercialUse: false, allowedPurposes: ['internal_research'], economics: { kind: 'percent_of_gross', bps: 1000 } }),
);
export const replacementD = source('d', terms({ economics: { kind: 'fixed_per_sale', amountCents: 200 } }));
