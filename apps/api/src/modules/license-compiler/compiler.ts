import type {
  AttributionObligation,
  BuildIntent,
  LicenseStatus,
  LicenseTerms,
  PreflightReport,
  RuleId,
  RuleOutcome,
  RuleResult,
} from '@tracepay/shared';
import { describeTerritories, describeTerritory, formatBps, formatDay, formatMoney, joinWords, PURPOSE_LABELS } from '@tracepay/shared';

export const POLICY_VERSION = 'tracepay-policy/1';

/** "X's license is …" for each license that isn't approved. */
const STATUS_PHRASES: Partial<Record<LicenseStatus, string>> = {
  requested: 'only requested so far',
  draft: 'still a draft',
  offered: 'offered but not accepted yet',
  declined: 'declined',
  withdrawn: 'withdrawn',
  revoked: 'revoked',
  superseded: 'replaced by a newer version',
};

/** One selected source as the compiler sees it: a pinned asset version and its grant. */
export interface CompilerSource {
  assetId: string;
  assetTitle: string;
  assetVersionId: string;
  contributorName: string;
  payeeEmail: string | null;
  license: {
    id: string;
    status: LicenseStatus;
    terms: LicenseTerms;
  } | null;
  /** Why there is no usable license, when one exists but can't be read. */
  licenseProblem?: string;
}

export interface PreflightInput {
  intent: BuildIntent;
  sources: CompilerSource[];
  /** ISO date (YYYY-MM-DD) the build is evaluated on. Injected for determinism. */
  asOf: string;
}

/**
 * The license compiler. A pure, deterministic function: the same intent,
 * sources and date always produce the same report. No AI is involved — the
 * model may later *explain* a failed rule, but never decides one.
 */
export function runPreflight({ intent, sources, asOf }: PreflightInput): PreflightReport {
  const results: RuleResult[] = [];
  const obligations: AttributionObligation[] = [];
  const add = (ruleId: RuleId, outcome: RuleOutcome, message: string, assetVersionId?: string) =>
    results.push(assetVersionId ? { ruleId, outcome, message, assetVersionId } : { ruleId, outcome, message });

  // ---- build-level structure -------------------------------------------------
  if (sources.length === 0) {
    add('SOURCES_PRESENT', 'fail', 'Choose at least one licensed source.');
  } else {
    add('SOURCES_PRESENT', 'pass', `${sources.length} source${sources.length === 1 ? '' : 's'} chosen.`);
  }

  const seen = new Map<string, string>();
  let duplicate = false;
  for (const s of sources) {
    const prior = seen.get(s.assetId);
    if (prior !== undefined) {
      duplicate = true;
      add('NO_DUPLICATE_ASSETS', 'fail', `"${s.assetTitle}" is chosen more than once. Keep one version of it.`, s.assetVersionId);
    }
    seen.set(s.assetId, s.assetVersionId);
  }
  if (!duplicate && sources.length > 0) add('NO_DUPLICATE_ASSETS', 'pass', 'Each source is used once.');

  // ---- per-source rules ------------------------------------------------------
  for (const s of sources) {
    const id = s.assetVersionId;
    const name = `"${s.assetTitle}"`;

    if (!s.license) {
      add('LICENSE_PRESENT', 'fail', s.licenseProblem ? `${name} ${s.licenseProblem}` : `${name} isn’t licensed to you.`, id);
      continue;
    }
    add('LICENSE_PRESENT', 'pass', `${name} is licensed to you.`, id);

    const t = s.license.terms;

    if (s.license.status !== 'approved') {
      add('LICENSE_APPROVED', 'fail', `${name}’s license is ${STATUS_PHRASES[s.license.status] ?? s.license.status}. Only a license both sides have agreed to can be used.`, id);
    } else {
      add('LICENSE_APPROVED', 'pass', `${name}’s license is agreed by both sides.`, id);
    }

    if (asOf < t.validFrom) {
      add('LICENSE_IN_TERM', 'fail', `${name}’s license starts on ${formatDay(t.validFrom)}.`, id);
    } else if (t.validUntil !== null && asOf > t.validUntil) {
      add('LICENSE_IN_TERM', 'fail', `${name}’s license ended on ${formatDay(t.validUntil)}.`, id);
    } else {
      add('LICENSE_IN_TERM', 'pass', `${name}’s license is current.`, id);
    }

    if (!t.allowedPurposes.includes(intent.purpose)) {
      add('PURPOSE_ALLOWED', 'fail', `${name} may be used only for ${joinWords(t.allowedPurposes.map((p) => PURPOSE_LABELS[p]))}, not ${PURPOSE_LABELS[intent.purpose]}.`, id);
    } else {
      add('PURPOSE_ALLOWED', 'pass', `${name} may be used for ${PURPOSE_LABELS[intent.purpose]}.`, id);
    }

    if (intent.distribution === 'sale') {
      if (!t.commercialUse) add('COMMERCIAL_USE', 'fail', `${name} may not be used in anything that is sold.`, id);
      else add('COMMERCIAL_USE', 'pass', `${name} may be used commercially.`, id);
    } else {
      add('COMMERCIAL_USE', 'skip', 'The report isn’t for sale.', id);
    }

    if (t.derivativeReports === 'prohibited') {
      add('DERIVATIVE_ALLOWED', 'fail', `${name} may not be used to write reports.`, id);
    } else {
      add('DERIVATIVE_ALLOWED', 'pass', `${name} may be used to write reports.`, id);
    }

    if (intent.includesRawData) {
      if (!t.rawRedistribution) add('RAW_REDISTRIBUTION', 'fail', `${name} doesn’t allow its original data to be shared.`, id);
      else add('RAW_REDISTRIBUTION', 'pass', `${name} allows its original data to be shared.`, id);
    } else {
      add('RAW_REDISTRIBUTION', 'skip', 'The report doesn’t include original source data.', id);
    }

    if (t.territories !== null && !t.territories.includes(intent.territory)) {
      add('TERRITORY', 'fail', `${name} may be used only in ${describeTerritories(t.territories)}, not ${describeTerritory(intent.territory)}.`, id);
    } else {
      add('TERRITORY', 'pass', `${name} may be used in ${describeTerritory(intent.territory)}.`, id);
    }

    if (t.currency !== intent.currency) {
      add('CURRENCY_MATCH', 'fail', `${name}’s license is in ${t.currency}, but the sale is in ${intent.currency}.`, id);
    } else {
      add('CURRENCY_MATCH', 'pass', `The license and the sale are both in ${intent.currency}.`, id);
    }

    if (t.economics.kind !== 'none' && !s.payeeEmail) {
      add('PAYEE_DEFINED', 'fail', `${name} is owed a share, but its contributor hasn’t added a PayPal email yet.`, id);
    } else {
      add('PAYEE_DEFINED', t.economics.kind === 'none' ? 'skip' : 'pass',
        t.economics.kind === 'none' ? 'Nothing is owed.' : `${s.contributorName} can be paid with PayPal.`, id);
    }

    if (t.derivativeReports === 'allowed_with_attribution' && t.attributionText) {
      obligations.push({ assetVersionId: id, assetTitle: s.assetTitle, text: t.attributionText });
      add('ATTRIBUTION', 'obligation', `The report must credit: "${t.attributionText}".`, id);
    } else {
      add('ATTRIBUTION', 'skip', 'No credit line needed.', id);
    }
  }

  // ---- build-level economics -------------------------------------------------
  const licensed = sources.flatMap((s) => (s.license ? [s.license.terms.economics] : []));
  const totalBps = licensed.reduce((sum, e) => sum + (e.kind === 'percent_of_gross' ? e.bps : 0), 0);
  const fixedFeesCents = licensed.reduce((sum, e) => sum + (e.kind === 'fixed_per_sale' ? e.amountCents : 0), 0);
  const percentCents = Math.floor((intent.priceCents * totalBps) / 10_000);
  const maxContributorCents = percentCents + fixedFeesCents;

  if (totalBps > 10_000) {
    add('ECON_TOTAL_BPS', 'fail', `Contributors’ percentage shares add up to ${formatBps(totalBps)}, more than 100%. Fix the licenses; TracePay never scales shares down.`);
  } else {
    add('ECON_TOTAL_BPS', 'pass', `Contributors’ percentage shares add up to ${formatBps(totalBps)}.`);
  }

  if (intent.distribution === 'sale') {
    if (maxContributorCents > intent.priceCents) {
      add('ECON_PRICE_COVERS', 'fail',
        `Contributors could be owed ${formatMoney(maxContributorCents)}, more than the ${formatMoney(intent.priceCents)} price.`);
    } else {
      add('ECON_PRICE_COVERS', 'pass',
        `The ${formatMoney(intent.priceCents)} price covers the most contributors could be owed (${formatMoney(maxContributorCents)}).`);
    }
  } else {
    add('ECON_PRICE_COVERS', 'skip', 'The report isn’t for sale.');
  }

  return {
    policyVersion: POLICY_VERSION,
    verdict: results.some((r) => r.outcome === 'fail') ? 'block' : 'pass',
    results,
    obligations,
    economics: {
      priceCents: intent.priceCents,
      totalBps,
      fixedFeesCents,
      maxContributorCents,
      minPublisherResidualCents: Math.max(0, intent.priceCents - maxContributorCents),
    },
  };
}

export function failedRules(report: PreflightReport): RuleResult[] {
  return report.results.filter((r) => r.outcome === 'fail');
}
