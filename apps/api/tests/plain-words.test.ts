import { describe, expect, it } from 'vitest';
import { describeTerritories, describeTerritory, formatDay, joinWords, LICENSE_STATUSES, LICENSE_STATUS_LABELS, PURPOSES, PURPOSE_LABELS, RULE_IDS, RULE_LABELS } from '@tracepay/shared';
import { runPreflight } from '../src/modules/license-compiler/compiler';
import { AS_OF, commercialIntent, internalOnlyC, marketDataA, replacementD, researchNotesB, source, terms } from './fixtures';

/** What people read must be words, not the system's internal values. */
describe('plain words', () => {
  it('names every rule, purpose and license status', () => {
    for (const id of RULE_IDS) expect(RULE_LABELS[id]).toMatch(/^[A-Z][a-z]/);
    for (const p of PURPOSES) expect(PURPOSE_LABELS[p]).not.toMatch(/_/);
    for (const s of LICENSE_STATUSES) expect(LICENSE_STATUS_LABELS[s]).toMatch(/^[A-Z][a-z]/);
  });

  it('describes places and dates the same way on every machine', () => {
    expect(describeTerritory('us')).toBe('the United States');
    expect(describeTerritory('DE')).toBe('Germany');
    expect(describeTerritories(['US', 'GB', 'IN'])).toBe('the United States, the United Kingdom and India');
    expect(describeTerritories(null)).toBe('anywhere');
    expect(formatDay('2027-12-31')).toBe('December 31, 2027');
    expect(formatDay('not a date')).toBe('not a date');
    expect(joinWords([])).toBe('');
    expect(joinWords(['a'])).toBe('a');
    expect(joinWords(['a', 'b'])).toBe('a and b');
  });

  it('writes license-check results without codes, ids or raw values', () => {
    const reports = [
      runPreflight({ intent: commercialIntent, sources: [marketDataA, researchNotesB], asOf: AS_OF }),
      runPreflight({ intent: { ...commercialIntent, distribution: 'internal', purpose: 'internal_research' }, sources: [marketDataA], asOf: AS_OF }),
      runPreflight({
        intent: { ...commercialIntent, includesRawData: true, territory: 'FR', priceCents: 100 },
        sources: [
          marketDataA,
          marketDataA,
          internalOnlyC,
          replacementD,
          source('e', terms({ territories: ['US', 'GB'], validUntil: '2026-01-31', rawRedistribution: false, derivativeReports: 'prohibited' }), { payeeEmail: null }),
          { ...source('f', terms()), license: { id: 'lic_f', status: 'offered', terms: terms({ validFrom: '2027-01-01', economics: { kind: 'percent_of_gross', bps: 9000 } }) } },
          { ...source('g', terms()), license: null },
        ],
        asOf: AS_OF,
      }),
    ];
    for (const r of reports) {
      for (const res of r.results) {
        expect(res.message.replace(/"[^"]*"/g, "“name”"), res.ruleId).not.toMatch(/internal_research|commercial_report|lic_|_[a-z]+_|\bgross\b|deliverable|asset|preflight|payee|\d{4}-\d{2}-\d{2}/i);
      }
    }
  });
});
