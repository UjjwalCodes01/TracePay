import { describe, expect, it } from 'vitest';
import { failedRules, runPreflight } from '../src/modules/license-compiler/compiler';
import { AS_OF, commercialIntent, internalOnlyC, marketDataA, replacementD, researchNotesB, source, terms } from './fixtures';

const run = (sources = [marketDataA, researchNotesB], intent = commercialIntent, asOf = AS_OF) =>
  runPreflight({ intent, sources, asOf });

const failedIds = (r: ReturnType<typeof run>) => failedRules(r).map((f) => `${f.ruleId}:${f.assetVersionId ?? '-'}`);

describe('license compiler', () => {
  it('passes a compatible commercial build and records attribution obligations', () => {
    const report = run();
    expect(report.verdict).toBe('pass');
    expect(report.obligations).toEqual([
      { assetVersionId: 'av_b_v1', assetTitle: 'Asset B', text: 'Analysis courtesy of Contributor B' },
    ]);
    expect(report.economics).toMatchObject({ totalBps: 4000, maxContributorCents: 800, minPublisherResidualCents: 1200 });
  });

  it('blocks a commercial build when one source is internal-research only', () => {
    const report = run([marketDataA, researchNotesB, internalOnlyC]);
    expect(report.verdict).toBe('block');
    expect(failedIds(report)).toEqual(['PURPOSE_ALLOWED:av_c_v1', 'COMMERCIAL_USE:av_c_v1']);
  });

  it('passes again once the blocked source is replaced', () => {
    expect(run([marketDataA, researchNotesB, replacementD]).verdict).toBe('pass');
  });

  it('allows the same sources for internal research', () => {
    const report = run([marketDataA, internalOnlyC], { ...commercialIntent, purpose: 'internal_research', distribution: 'internal' });
    expect(report.verdict).toBe('pass');
  });

  it('allows a derived report but blocks a build that exposes raw data (adversarial case)', () => {
    expect(run([marketDataA]).verdict).toBe('pass');
    const withRaw = run([marketDataA], { ...commercialIntent, includesRawData: true });
    expect(withRaw.verdict).toBe('block');
    expect(failedIds(withRaw)).toEqual(['RAW_REDISTRIBUTION:av_a_v1']);
  });

  it('changing an approved term changes the policy result', () => {
    const before = source('x', terms({ commercialUse: true }));
    const after = source('x', terms({ commercialUse: false }));
    expect(run([before]).verdict).toBe('pass');
    expect(failedIds(run([after]))).toEqual(['COMMERCIAL_USE:av_x_v1']);
  });

  it('blocks draft, revoked, expired and not-yet-valid licenses', () => {
    const draft = source('d1', terms(), { license: { id: 'l1', status: 'draft', terms: terms() } });
    const revoked = source('d2', terms(), { license: { id: 'l2', status: 'revoked', terms: terms() } });
    const expired = source('d3', terms({ validUntil: '2026-06-30' }));
    const future = source('d4', terms({ validFrom: '2027-01-01' }));
    const report = run([draft, revoked, expired, future]);
    expect(failedIds(report)).toEqual([
      'LICENSE_APPROVED:av_d1_v1',
      'LICENSE_APPROVED:av_d2_v1',
      'LICENSE_IN_TERM:av_d3_v1',
      'LICENSE_IN_TERM:av_d4_v1',
    ]);
  });

  it('blocks a source with no license grant', () => {
    expect(failedIds(run([source('n', terms(), { license: null })]))).toEqual(['LICENSE_PRESENT:av_n_v1']);
  });

  it('blocks prohibited derivatives and out-of-territory use', () => {
    const noDerivs = source('p', terms({ derivativeReports: 'prohibited' }));
    const euOnly = source('t', terms({ territories: ['DE', 'FR'] }));
    expect(failedIds(run([noDerivs, euOnly]))).toEqual(['DERIVATIVE_ALLOWED:av_p_v1', 'TERRITORY:av_t_v1']);
  });

  it('rejects percentage terms above 100% instead of normalizing them', () => {
    const big1 = source('g1', terms({ economics: { kind: 'percent_of_gross', bps: 6000 } }));
    const big2 = source('g2', terms({ economics: { kind: 'percent_of_gross', bps: 5000 } }));
    expect(failedIds(run([big1, big2]))).toEqual(['ECON_TOTAL_BPS:-', 'ECON_PRICE_COVERS:-']);
  });

  it('blocks fixed fees that exceed the sale price', () => {
    const pricey = source('f', terms({ economics: { kind: 'fixed_per_sale', amountCents: 2500 } }));
    expect(failedIds(run([pricey]))).toEqual(['ECON_PRICE_COVERS:-']);
  });

  it('blocks a payable source without a PayPal payee', () => {
    expect(failedIds(run([source('e', terms(), { payeeEmail: null })]))).toEqual(['PAYEE_DEFINED:av_e_v1']);
  });

  it('blocks duplicate assets and empty builds', () => {
    const v2 = { ...marketDataA, assetVersionId: 'av_a_v2' };
    expect(failedIds(run([marketDataA, v2]))).toEqual(['NO_DUPLICATE_ASSETS:av_a_v2']);
    expect(failedIds(run([]))).toEqual(['SOURCES_PRESENT:-']);
  });

  it('is deterministic', () => {
    const sources = [marketDataA, researchNotesB, internalOnlyC];
    expect(run(sources)).toEqual(run(sources));
  });
});
