import { describeTerritories, formatDay, LICENSE_STATUS_LABELS } from '@tracepay/shared';
import type { ResolvedSource } from '../catalog/catalog.service';

/**
 * Which of a library's sources may be used to answer a question, today. Pure and
 * deterministic, like the license compiler: the model never sees a source this
 * rejects, so it can't use (or be paid for) what isn't licensed.
 */

export type ExclusionCode = 'no_license' | 'not_approved' | 'revoked' | 'out_of_term' | 'ai_not_allowed' | 'not_commercial' | 'territory' | 'no_payee' | 'over_budget' | 'demo_only' | 'instructions';

export interface EligibleSource {
  source: ResolvedSource;
  centsPerCitation: number;
}

export interface ExcludedSource {
  assetVersionId: string;
  assetTitle: string;
  contributorName: string;
  code: ExclusionCode;
  reason: string;
}

export function checkAnswerRights(sources: ResolvedSource[], asOf: string): { eligible: EligibleSource[]; excluded: ExcludedSource[] } {
  const eligible: EligibleSource[] = [];
  const excluded: ExcludedSource[] = [];
  const exclude = (s: ResolvedSource, code: ExclusionCode, reason: string) =>
    excluded.push({ assetVersionId: s.assetVersionId, assetTitle: s.assetTitle, contributorName: s.contributorName, code, reason });

  for (const s of sources) {
    const l = s.license;
    if (!l) {
      exclude(s, 'no_license', s.licenseProblem ? `This source ${s.licenseProblem}` : 'It isn’t licensed to this library.');
      continue;
    }
    if (l.status === 'revoked') {
      exclude(s, 'revoked', 'The contributor revoked the license.');
      continue;
    }
    if (l.status !== 'approved') {
      exclude(s, 'not_approved', `The license is ${(LICENSE_STATUS_LABELS[l.status] ?? l.status).toLowerCase()}, not approved.`);
      continue;
    }
    const t = l.terms;
    if (asOf < t.validFrom || (t.validUntil !== null && asOf > t.validUntil)) {
      exclude(s, 'out_of_term', t.validUntil !== null && asOf > t.validUntil ? `The license ended on ${formatDay(t.validUntil)}.` : `The license starts on ${formatDay(t.validFrom)}.`);
      continue;
    }
    if (!t.aiAnswers?.allowed) {
      exclude(s, 'ai_not_allowed', 'The license doesn’t allow answering questions with AI.');
      continue;
    }
    // Answers are a paid service, available anywhere.
    if (!t.commercialUse) {
      exclude(s, 'not_commercial', 'The license doesn’t allow use in anything that is sold.');
      continue;
    }
    if (t.territories !== null) {
      exclude(s, 'territory', `It may be used only in ${describeTerritories(t.territories)}, and answers are available everywhere.`);
      continue;
    }
    if (t.aiAnswers.centsPerCitation > 0 && !s.payeeEmail) {
      exclude(s, 'no_payee', 'The contributor has no PayPal account on file to be paid.');
      continue;
    }
    eligible.push({ source: s, centsPerCitation: t.aiAnswers.centsPerCitation });
  }
  return { eligible, excluded };
}
