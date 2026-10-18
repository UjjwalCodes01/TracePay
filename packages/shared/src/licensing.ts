import { z } from 'zod';

export const PURPOSES = ['internal_research', 'commercial_report'] as const;
export type Purpose = (typeof PURPOSES)[number];

export const LICENSE_STATUSES = ['draft', 'approved', 'revoked'] as const;
export type LicenseStatus = (typeof LICENSE_STATUSES)[number];

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
    territories: z.array(z.string().length(2)).nullable(),
    validFrom: z.iso.date(),
    validUntil: z.iso.date().nullable(),
    attributionText: z.string().min(1).nullable(),
    economics: EconomicsSchema,
    /**
     * When the contributor is owed money: whenever their source is part of an
     * approved build, or only when the final output actually cites it.
     */
    payableOn: z.enum(['included_in_build', 'cited_in_output']),
    currency: z.literal('USD'),
  })
  .refine((t) => t.derivativeReports !== 'allowed_with_attribution' || t.attributionText !== null, {
    message: 'attributionText is required when derivative reports require attribution',
    path: ['attributionText'],
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
    territory: z.string().length(2),
    priceCents: z.number().int().min(0),
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
