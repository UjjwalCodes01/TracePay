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
import { formatBps, formatMoney } from '@tracepay/shared';

export const POLICY_VERSION = 'tracepay-policy/1';

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
    add('SOURCES_PRESENT', 'fail', 'Select at least one licensed source.');
  } else {
    add('SOURCES_PRESENT', 'pass', `${sources.length} source(s) selected.`);
  }

  const seen = new Map<string, string>();
  let duplicate = false;
  for (const s of sources) {
    const prior = seen.get(s.assetId);
    if (prior !== undefined) {
      duplicate = true;
      add('NO_DUPLICATE_ASSETS', 'fail', `"${s.assetTitle}" is selected more than once; pin a single version.`, s.assetVersionId);
    }
    seen.set(s.assetId, s.assetVersionId);
  }
  if (!duplicate && sources.length > 0) add('NO_DUPLICATE_ASSETS', 'pass', 'Each asset is pinned to one version.');

  // ---- per-source rules ------------------------------------------------------
  for (const s of sources) {
    const id = s.assetVersionId;
    const name = `"${s.assetTitle}"`;

    if (!s.license) {
      add('LICENSE_PRESENT', 'fail', `${name} has no license grant for this publisher.`, id);
      continue;
    }
    add('LICENSE_PRESENT', 'pass', `${name} has license ${s.license.id}.`, id);

    const t = s.license.terms;

    if (s.license.status !== 'approved') {
      add('LICENSE_APPROVED', 'fail', `${name}'s license is ${s.license.status}; only approved terms are enforceable.`, id);
    } else {
      add('LICENSE_APPROVED', 'pass', `${name}'s terms are approved.`, id);
    }

    if (asOf < t.validFrom) {
      add('LICENSE_IN_TERM', 'fail', `${name}'s license starts on ${t.validFrom}.`, id);
    } else if (t.validUntil !== null && asOf > t.validUntil) {
      add('LICENSE_IN_TERM', 'fail', `${name}'s license expired on ${t.validUntil}.`, id);
    } else {
      add('LICENSE_IN_TERM', 'pass', `${name}'s license is in term on ${asOf}.`, id);
    }

    if (!t.allowedPurposes.includes(intent.purpose)) {
      add('PURPOSE_ALLOWED', 'fail', `${name} is licensed for ${t.allowedPurposes.join(', ')} only, not ${intent.purpose}.`, id);
    } else {
      add('PURPOSE_ALLOWED', 'pass', `${name} permits ${intent.purpose}.`, id);
    }

    if (intent.distribution === 'sale') {
      if (!t.commercialUse) add('COMMERCIAL_USE', 'fail', `${name} does not permit commercial use.`, id);
      else add('COMMERCIAL_USE', 'pass', `${name} permits commercial use.`, id);
    } else {
      add('COMMERCIAL_USE', 'skip', 'Not distributed for sale.', id);
    }

    if (t.derivativeReports === 'prohibited') {
      add('DERIVATIVE_ALLOWED', 'fail', `${name} prohibits derivative reports.`, id);
    } else {
      add('DERIVATIVE_ALLOWED', 'pass', `${name} permits derivative reports.`, id);
    }

    if (intent.includesRawData) {
      if (!t.rawRedistribution) add('RAW_REDISTRIBUTION', 'fail', `${name} prohibits redistributing its raw content.`, id);
      else add('RAW_REDISTRIBUTION', 'pass', `${name} permits raw redistribution.`, id);
    } else {
      add('RAW_REDISTRIBUTION', 'skip', 'Deliverable does not expose raw source content.', id);
    }

    if (t.territories !== null && !t.territories.includes(intent.territory)) {
      add('TERRITORY', 'fail', `${name} is licensed for ${t.territories.join(', ')}, not ${intent.territory}.`, id);
    } else {
      add('TERRITORY', 'pass', `${name} is licensed for ${intent.territory}.`, id);
    }

    if (t.currency !== intent.currency) {
      add('CURRENCY_MATCH', 'fail', `${name}'s terms are in ${t.currency}, the sale is in ${intent.currency}.`, id);
    } else {
      add('CURRENCY_MATCH', 'pass', `Terms and sale are both in ${intent.currency}.`, id);
    }

    if (t.economics.kind !== 'none' && !s.payeeEmail) {
      add('PAYEE_DEFINED', 'fail', `${name} is owed money but has no PayPal payee on file.`, id);
    } else {
      add('PAYEE_DEFINED', t.economics.kind === 'none' ? 'skip' : 'pass',
        t.economics.kind === 'none' ? 'No payment owed.' : `Payee on file for ${s.contributorName}.`, id);
    }

    if (t.derivativeReports === 'allowed_with_attribution' && t.attributionText) {
      obligations.push({ assetVersionId: id, assetTitle: s.assetTitle, text: t.attributionText });
      add('ATTRIBUTION', 'obligation', `Output must credit: "${t.attributionText}".`, id);
    } else {
      add('ATTRIBUTION', 'skip', 'No attribution required.', id);
    }
  }

  // ---- build-level economics -------------------------------------------------
  const licensed = sources.flatMap((s) => (s.license ? [s.license.terms.economics] : []));
  const totalBps = licensed.reduce((sum, e) => sum + (e.kind === 'percent_of_gross' ? e.bps : 0), 0);
  const fixedFeesCents = licensed.reduce((sum, e) => sum + (e.kind === 'fixed_per_sale' ? e.amountCents : 0), 0);
  const percentCents = Math.floor((intent.priceCents * totalBps) / 10_000);
  const maxContributorCents = percentCents + fixedFeesCents;

  if (totalBps > 10_000) {
    add('ECON_TOTAL_BPS', 'fail', `Percentage royalties total ${formatBps(totalBps)}, above 100%. Terms are rejected, not normalized.`);
  } else {
    add('ECON_TOTAL_BPS', 'pass', `Percentage royalties total ${formatBps(totalBps)}.`);
  }

  if (intent.distribution === 'sale') {
    if (maxContributorCents > intent.priceCents) {
      add('ECON_PRICE_COVERS', 'fail',
        `Contributor obligations (${formatMoney(maxContributorCents)}) exceed the ${formatMoney(intent.priceCents)} price.`);
    } else {
      add('ECON_PRICE_COVERS', 'pass',
        `Price ${formatMoney(intent.priceCents)} covers up to ${formatMoney(maxContributorCents)} of contributor obligations.`);
    }
  } else {
    add('ECON_PRICE_COVERS', 'skip', 'Not distributed for sale.');
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
