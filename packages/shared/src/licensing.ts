import { z } from 'zod';

export const PURPOSES = ['internal_research', 'commercial_report'] as const;
export type Purpose = (typeof PURPOSES)[number];

export const LICENSE_STATUSES = ['requested', 'draft', 'offered', 'approved', 'declined', 'withdrawn', 'revoked', 'superseded'] as const;
export type LicenseStatus = (typeof LICENSE_STATUSES)[number];

/** Statuses that can govern a build: the latest of these is the license in force (or revoked). */
export const GOVERNING_STATUSES = ['approved', 'revoked'] as const satisfies readonly LicenseStatus[];
/** Statuses still awaiting a decision from one of the two parties. */
export const PENDING_STATUSES = ['requested', 'offered'] as const satisfies readonly LicenseStatus[];

/**
 * Economic terms a contributor has agreed to. Percentages are basis points of
 * the verified gross sale (2500 = 25%) so settlement never touches floats.
 */
export const EconomicsSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('percent_of_gross'), bps: z.number().int().min(0).max(10_000) }),
  z.object({ kind: z.literal('fixed_per_sale'), amountCents: z.number().int().min(0) }),
  z.object({ kind: z.literal('none') }),
]);
export type Economics = z.infer<typeof EconomicsSchema>;

/**
 * The normalized, machine-executable form of a license grant. AI may draft
 * this from a document, but only an approved record is ever enforced.
 */
export const LicenseTermsSchema = z
  .object({
    commercialUse: z.boolean(),
    derivativeReports: z.enum(['allowed', 'allowed_with_attribution', 'prohibited']),
    rawRedistribution: z.boolean(),
    allowedPurposes: z.array(z.enum(PURPOSES)).min(1),
    /** ISO-3166 alpha-2 codes; null means worldwide. */
    territories: z.array(z.string().regex(/^[A-Za-z]{2}$/).transform((c) => c.toUpperCase())).nullable(),
    validFrom: z.iso.date(),
    validUntil: z.iso.date().nullable(),
    attributionText: z.string().min(1).nullable(),
    economics: EconomicsSchema,
    /**
     * Using the work to answer questions (AI agents, chat), paid per VERIFIED citation:
     * only passages an answer actually relies on are paid. Absent means not allowed,
     * so licenses written before this clause existed keep their terms (and hashes).
     */
    aiAnswers: z
      .object({
        allowed: z.boolean(),
        /** Paid for each passage of this source that an answer verifiably cites. */
        centsPerCitation: z.number().int().min(0).max(500),
      })
      .optional(),
    /**
     * When the contributor is owed money: whenever their source is part of an
     * approved build, or only when the final output actually cites it.
     */
    payableOn: z.enum(['included_in_build', 'cited_in_output']),
    currency: z.literal('USD'),
  })
  .refine((t) => t.derivativeReports !== 'allowed_with_attribution' || t.attributionText !== null, {
    message: 'Add the credit line reports must include.',
    path: ['attributionText'],
  })
  .refine((t) => t.validUntil === null || t.validUntil >= t.validFrom, {
    message: 'The end date must be on or after the start date.',
    path: ['validUntil'],
  })
  .refine((t) => t.allowedPurposes.includes('commercial_report') === t.commercialUse, {
    message: 'Commercial use and the allowed purposes disagree.',
    path: ['allowedPurposes'],
  });
export type LicenseTerms = z.infer<typeof LicenseTermsSchema>;

/** What the publisher intends to make and how it will be distributed. */
export const BuildIntentSchema = z
  .object({
    title: z.string().min(3).max(200),
    brief: z.string().min(10).max(4000),
    purpose: z.enum(PURPOSES),
    distribution: z.enum(['sale', 'internal']),
    /** Would the deliverable expose raw source content (e.g. a data appendix)? */
    includesRawData: z.boolean(),
    territory: z.string().regex(/^[A-Za-z]{2}$/).transform((c) => c.toUpperCase()),
    /** Up to $10,000 — within PayPal's per-transaction limits and the database's integer range. */
    priceCents: z.number().int().min(0).max(1_000_000),
    currency: z.literal('USD'),
  })
  .refine((i) => i.distribution !== 'sale' || i.priceCents > 0, {
    message: 'A deliverable for sale needs a price',
    path: ['priceCents'],
  });
export type BuildIntent = z.infer<typeof BuildIntentSchema>;

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
