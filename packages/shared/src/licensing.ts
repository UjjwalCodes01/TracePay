import type { Economics, LicenseTerms, BuildIntent } from './schemas';

export const PURPOSES = ['internal_research', 'commercial_report'] as const;
export type Purpose = (typeof PURPOSES)[number];

export const LICENSE_STATUSES = ['requested', 'draft', 'offered', 'approved', 'declined', 'withdrawn', 'revoked', 'superseded'] as const;
export type LicenseStatus = (typeof LICENSE_STATUSES)[number];

/** Statuses that can govern a build: the latest of these is the license in force (or revoked). */
export const GOVERNING_STATUSES = ['approved', 'revoked'] as const satisfies readonly LicenseStatus[];
/** Statuses still awaiting a decision from one of the two parties. */
export const PENDING_STATUSES = ['requested', 'offered'] as const satisfies readonly LicenseStatus[];

export type { BuildIntent, Economics, LicenseTerms } from './schemas';

export const RULE_IDS = [
  'SOURCES_PRESENT',
  'NO_DUPLICATE_ASSETS',
  'LICENSE_PRESENT',
  'LICENSE_APPROVED',
  'LICENSE_IN_TERM',
  'PURPOSE_ALLOWED',
  'COMMERCIAL_USE',
  'DERIVATIVE_ALLOWED',
  'RAW_REDISTRIBUTION',
  'TERRITORY',
  'CURRENCY_MATCH',
  'PAYEE_DEFINED',
  'ATTRIBUTION',
  'ECON_TOTAL_BPS',
  'ECON_PRICE_COVERS',
] as const;
export type RuleId = (typeof RULE_IDS)[number];

export type RuleOutcome = 'pass' | 'fail' | 'skip' | 'obligation';

export interface RuleResult {
  ruleId: RuleId;
  /** Asset version the rule was evaluated for; absent for build-level rules. */
  assetVersionId?: string;
  outcome: RuleOutcome;
  message: string;
}

export interface AttributionObligation {
  assetVersionId: string;
  assetTitle: string;
  text: string;
}

export interface PreflightReport {
  policyVersion: string;
  verdict: 'pass' | 'block';
  results: RuleResult[];
  obligations: AttributionObligation[];
  economics: {
    priceCents: number;
    totalBps: number;
    fixedFeesCents: number;
    /** Worst case owed to contributors if every source is payable. */
    maxContributorCents: number;
    minPublisherResidualCents: number;
  };
}

// ---- the words people see -----------------------------------------------------

/** What each check confirms, as the app names it. */
export const RULE_LABELS: Record<RuleId, string> = {
  SOURCES_PRESENT: 'Sources chosen',
  NO_DUPLICATE_ASSETS: 'Each source used once',
  LICENSE_PRESENT: 'Licensed to you',
  LICENSE_APPROVED: 'License agreed by both sides',
  LICENSE_IN_TERM: 'License is current',
  PURPOSE_ALLOWED: 'Allowed for this use',
  COMMERCIAL_USE: 'May be sold',
  DERIVATIVE_ALLOWED: 'May be used in reports',
  RAW_REDISTRIBUTION: 'Original data may be shared',
  TERRITORY: 'Allowed in this country',
  CURRENCY_MATCH: 'Same currency',
  PAYEE_DEFINED: 'Contributor can be paid',
  ATTRIBUTION: 'Credit line',
  ECON_TOTAL_BPS: 'Shares add up',
  ECON_PRICE_COVERS: 'Price covers contributors’ shares',
};

export const PURPOSE_LABELS: Record<Purpose, string> = {
  internal_research: 'internal research',
  commercial_report: 'reports that are sold',
};

export const LICENSE_STATUS_LABELS: Record<LicenseStatus, string> = {
  requested: 'Requested',
  draft: 'Draft',
  offered: 'Offered',
  approved: 'Approved',
  declined: 'Declined',
  withdrawn: 'Withdrawn',
  revoked: 'Revoked',
  superseded: 'Replaced by a newer version',
};

/** "a, b and c" */
export function joinWords(words: readonly string[]): string {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

const regions = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'code' });

/** "US" → "the United States"; unknown codes are shown as they are. */
export function describeTerritory(code: string): string {
  const name = regions.of(code.toUpperCase()) ?? code;
  return /^(United|Netherlands|Philippines|Czech|Dominican|Central African|Bahamas|Gambia|Maldives|Marshall|Solomon|Comoros|Seychelles|Cayman|Falkland|Faroe|Cook)\b/.test(name)
    ? `the ${name}`
    : name;
}

/** null (worldwide) → "anywhere"; ["US","GB"] → "the United States and the United Kingdom". */
export function describeTerritories(codes: readonly string[] | null): string {
  return codes === null ? 'anywhere' : joinWords(codes.map(describeTerritory));
}

/** "2027-12-31" → "December 31, 2027", the same on every machine. */
export function formatDay(isoDate: string): string {
  const d = new Date(`${isoDate.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return isoDate;
  return d.toLocaleDateString('en-US', { timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric' });
}
