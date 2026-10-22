import type { LicenseTerms } from '@tracepay/shared';
import { describe, expect, it } from 'vitest';
import type { ResolvedSource } from '../src/modules/catalog/catalog.service';
import { checkAnswerRights } from '../src/modules/answers/rights';

const terms = (over: Partial<LicenseTerms> = {}): LicenseTerms => ({
  commercialUse: true,
  derivativeReports: 'allowed',
  rawRedistribution: false,
  allowedPurposes: ['internal_research', 'commercial_report'],
  territories: null,
  validFrom: '2026-01-01',
  validUntil: '2027-12-31',
  attributionText: null,
  economics: { kind: 'none' },
  aiAnswers: { allowed: true, centsPerCitation: 3 },
  payableOn: 'included_in_build',
  currency: 'USD',
  ...over,
});

const source = (id: string, over: Partial<ResolvedSource> = {}, t: Partial<LicenseTerms> = {}): ResolvedSource => ({
  assetId: `asset_${id}`,
  assetTitle: id,
  assetVersionId: id,
  contributorId: `user_${id}`,
  contributorName: `Author ${id}`,
  payeeEmail: `${id}@example.com`,
  termsHash: 'h',
  license: { id: `lic_${id}`, status: 'approved', terms: terms(t) },
  ...over,
});

const reasonOf = (s: ResolvedSource, asOf = '2026-10-23') => {
  const r = checkAnswerRights([s], asOf);
  return r.excluded[0]?.code ?? (r.eligible.length ? 'eligible' : 'none');
};

describe('which sources an AI answer may use', () => {
  it('allows an approved, in-term, commercial, worldwide license that permits AI answers and has a payee', () => {
    const r = checkAnswerRights([source('ok')], '2026-10-23');
    expect(r.eligible).toEqual([expect.objectContaining({ centsPerCitation: 3 })]);
    expect(r.excluded).toEqual([]);
  });

  it('refuses every other case, each for a reason it states', () => {
    expect(reasonOf(source('a', { license: null }))).toBe('no_license');
    expect(reasonOf(source('b', { license: null, licenseProblem: 'has unreadable terms' }))).toBe('no_license');
    expect(reasonOf(source('c', { license: { id: 'l', status: 'revoked', terms: terms() } }))).toBe('revoked');
    expect(reasonOf(source('d', { license: { id: 'l', status: 'offered', terms: terms() } }))).toBe('not_approved');
    expect(reasonOf(source('e', {}, { validUntil: '2026-09-30' }))).toBe('out_of_term');
    expect(reasonOf(source('f', {}, { validFrom: '2026-12-01' }))).toBe('out_of_term');
    expect(reasonOf(source('g', {}, { aiAnswers: undefined }))).toBe('ai_not_allowed'); // licenses from before the clause
    expect(reasonOf(source('h', {}, { aiAnswers: { allowed: false, centsPerCitation: 0 } }))).toBe('ai_not_allowed');
    expect(reasonOf(source('i', {}, { commercialUse: false, allowedPurposes: ['internal_research'] }))).toBe('not_commercial');
    expect(reasonOf(source('j', {}, { territories: ['US'] }))).toBe('territory');
    expect(reasonOf(source('k', { payeeEmail: null }))).toBe('no_payee');
  });

  it('lets a free source (0¢ per citation) be used without a payee', () => {
    expect(reasonOf(source('free', { payeeEmail: null }, { aiAnswers: { allowed: true, centsPerCitation: 0 } }))).toBe('eligible');
  });

  it('checks the last valid day inclusively, and the day after as expired', () => {
    expect(reasonOf(source('edge', {}, { validUntil: '2026-10-23' }))).toBe('eligible');
    expect(reasonOf(source('edge', {}, { validUntil: '2026-10-22' }))).toBe('out_of_term');
  });
});
