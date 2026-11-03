import { describe, expect, it } from 'vitest';
import { extractTerms } from '../src/modules/licenses/extract';
import { looksLikeRsl, readRsl, RslError } from '../src/modules/licenses/rsl';

const TODAY = '2026-11-02';
const rsl = (license: string, content = '') => `<?xml version="1.0" encoding="UTF-8"?>
<rsl xmlns="https://rslstandard.org/rsl">
  <content url="/research/">${content}
    <license>${license}</license>
  </content>
</rsl>`;

describe('reading RSL 1.0 licenses', () => {
  it('pays per use: a price per AI output becomes the per-citation rate and a fixed amount per report sale', () => {
    const r = readRsl(
      rsl(`<permits type="usage">ai-input search</permits><prohibits type="usage">ai-train</prohibits><permits type="user">commercial</permits><permits type="geo">US GB</permits>
           <payment type="use"><amount currency="USD">0.02</amount></payment>`),
      TODAY,
    );
    expect(r).toMatchObject({ source: 'rsl', model: 'RSL 1.0' });
    expect(r.terms).toMatchObject({
      aiAnswers: { allowed: true, centsPerCitation: 2 },
      economics: { kind: 'fixed_per_sale', amountCents: 2 },
      commercialUse: true,
      allowedPurposes: ['internal_research', 'commercial_report'],
      territories: ['US', 'GB'],
      payableOn: 'cited_in_output',
      derivativeReports: 'allowed',
      rawRedistribution: false,
      validFrom: TODAY,
    });
    // Each term quotes the element it came from.
    expect(r.evidence.find((e) => e.field === 'aiAnswers')!.quote).toContain('<permits type="usage">ai-input search</permits>');
    expect(r.evidence.find((e) => e.field === 'aiAnswers')!.quote).toContain('<amount currency="USD">0.02</amount>');
    expect(r.warnings).toEqual([]);
    expect(r.evidence.find((e) => e.field === 'aiAnswers')!.note).toMatch(/never trains/);
  });

  it('turns an attribution license into a credit line, and names the standard license', () => {
    const r = readRsl(
      rsl(
        `<permits type="usage">ai-all</permits><permits type="user">commercial non-commercial</permits>
         <payment type="attribution"><standard>https://creativecommons.org/licenses/by/4.0/</standard></payment>`,
        '<copyright>© 2026 Example Research</copyright>',
      ),
      TODAY,
    );
    expect(r.terms).toMatchObject({ aiAnswers: { allowed: true, centsPerCitation: 0 }, derivativeReports: 'allowed_with_attribution', licenseName: 'CC BY 4.0', economics: { kind: 'none' } });
    expect(r.terms.attributionText).toBe('© 2026 Example Research · CC BY 4.0 · /research/');
  });

  it('reads conservatively: nothing granted that the document doesn’t grant', () => {
    // No usage stated: no AI. No user stated: internal research only.
    const silent = readRsl(rsl('<payment type="free"/>'), TODAY);
    expect(silent.terms).toMatchObject({ aiAnswers: { allowed: false }, commercialUse: false, derivativeReports: 'prohibited' });
    expect(silent.warnings.join(' ')).toMatch(/read conservatively/);
    // A prohibition beats a permission.
    const banned = readRsl(rsl('<permits type="usage">all</permits><prohibits type="usage">ai-all</prohibits><permits type="user">commercial</permits>'), TODAY);
    expect(banned.terms.aiAnswers!.allowed).toBe(false);
    // Training only: answering is a different use.
    expect(readRsl(rsl('<permits type="usage">ai-train</permits>'), TODAY).terms.aiAnswers!.allowed).toBe(false);
  });

  it('leaves AI off, with a reason, when the terms are ones TracePay can’t honour', () => {
    const cases: Array<[string, RegExp]> = [
      ['<payment type="subscription"><custom>https://example.com/plans</custom></payment>', /subscription payment/],
      ['<payment type="use"><amount currency="EUR">0.02</amount></payment>', /US dollars/],
      ['<payment type="use"><amount currency="USD">9.00</amount></payment>', /per-citation limit/],
      ['<prohibits type="geo">CN</prohibits>', /excludes CN/],
    ];
    for (const [extra, why] of cases) {
      const r = readRsl(rsl(`<permits type="usage">ai-input</permits><permits type="user">commercial</permits>${extra}`), TODAY);
      expect(r.terms.aiAnswers!.allowed).toBe(false);
      expect(r.terms.derivativeReports).toBe('prohibited');
      expect(r.warnings.join(' ')).toMatch(why);
    }
  });

  it('follows the license that allows AI answers when a document offers several, and notes it', () => {
    const xml = `<rsl xmlns="https://rslstandard.org/rsl"><content url="/">
      <license><permits type="usage">search</permits></license>
      <license><permits type="usage">ai-input</permits><permits type="user">commercial</permits><payment type="use"><amount currency="USD">0.05</amount></payment></license>
    </content></rsl>`;
    const r = readRsl(xml, TODAY);
    expect(r.terms.aiAnswers).toEqual({ allowed: true, centsPerCitation: 5 });
    expect(r.warnings.join(' ')).toMatch(/offers 2 licenses/);
  });

  it('accepts a prefixed namespace, and refuses entity declarations and broken XML', () => {
    const prefixed = `<r:rsl xmlns:r="https://rslstandard.org/rsl"><r:content url="/"><r:license><r:permits type="usage">ai-input</r:permits></r:license></r:content></r:rsl>`;
    expect(looksLikeRsl(prefixed)).toBe(true);
    expect(readRsl(prefixed, TODAY).terms.aiAnswers!.allowed).toBe(true);
    expect(() => readRsl(`<!DOCTYPE rsl [<!ENTITY x "y">]>${rsl('')}`, TODAY)).toThrow(RslError);
    expect(() => readRsl('<rsl xmlns="https://rslstandard.org/rsl"><content url="/"><license></content></rsl>', TODAY)).toThrow(RslError);
    expect(() => readRsl('<rsl xmlns="https://rslstandard.org/rsl"></rsl>', TODAY)).toThrow(/no <content>/);
  });

  it('is read exactly, never sent to the AI, when pasted into the terms draft', async () => {
    const r = await extractTerms(rsl('<permits type="usage">ai-input</permits><permits type="user">commercial</permits>'), { useModel: true, today: TODAY });
    expect(r.source).toBe('rsl');
    expect(looksLikeRsl('A plain contract that mentions rsl and https://rslstandard.org/rsl')).toBe(false);
  });
});

describe('real RSL files', () => {
  it('reads rslcollective.org’s license (fetched 2026-11-03): AI use granted, but its terms live in a collective license, so nothing is assumed free', () => {
    // https://rslcollective.org/robots.txt → License: https://rslcollective.org/license.xml?ilc_id=ILC-YWFV80
    const real = `<rsl xmlns="https://rslstandard.org/rsl">
  <content url="/">
    <license>
      <permits type="usage">ai-all</permits>
      <payment>
        <standard>https://internetcollective.org/license</standard>
      </payment>
    </license>
  </content>
</rsl>`;
    const r = readRsl(real, TODAY);
    expect(r.terms.aiAnswers!.allowed).toBe(false);
    expect(r.terms.commercialUse).toBe(false);
    expect(r.warnings.join(' ')).toMatch(/refers to terms at https:\/\/internetcollective\.org\/license/);
    expect(r.evidence.find((e) => e.field === 'economics')!.quote).toBe('<payment><standard>https://internetcollective.org/license</standard></payment>');
  });
});
