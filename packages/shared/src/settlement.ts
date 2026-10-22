import type { Economics, LicenseTerms } from './licensing';
import { assertCents, formatBps, formatMoney } from './money';

export const ROUNDING_RULE =
  'Each contributor share is floored to the cent; any remainder stays with the publisher.';

/** A license term frozen at build time. Later edits to the license never change it. */
export interface FrozenTerm {
  licenseId: string;
  assetVersionId: string;
  assetTitle: string;
  contributorId: string;
  payeeEmail: string | null;
  economics: Economics;
  payableOn: LicenseTerms['payableOn'];
  /** From the provenance graph: did the final artifact cite this source? */
  citedInOutput: boolean;
}

export interface SettlementInput {
  /** Gross amount PayPal reported as captured — never the requested price. */
  verifiedGrossCents: number;
  currency: 'USD';
  publisherId: string;
  terms: FrozenTerm[];
}

export interface SettlementLine {
  kind: 'contributor' | 'publisher_residual';
  recipientId: string;
  payeeEmail: string | null;
  licenseId: string | null;
  assetVersionId: string | null;
  amountCents: number;
  /** Human-readable calculation, stored with the line for audit. */
  formula: string;
  payable: boolean;
  note: string | null;
}

export interface SettlementResult {
  grossCents: number;
  currency: 'USD';
  lines: SettlementLine[];
  contributorTotalCents: number;
  publisherResidualCents: number;
  roundingRule: string;
}

export class SettlementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettlementError';
  }
}

/**
 * Applies frozen, approved license terms to a verified sale. Pure and exact:
 * the lines always sum to the gross amount, or the calculation is rejected.
 */
export function calculateSettlement(input: SettlementInput): SettlementResult {
  const { verifiedGrossCents: gross } = input;
  assertCents(gross, 'verifiedGrossCents');
  if (gross === 0) throw new SettlementError('Cannot settle a zero-value sale.');

  const totalBps = input.terms.reduce(
    (sum, t) => sum + (t.economics.kind === 'percent_of_gross' ? t.economics.bps : 0),
    0,
  );
  if (totalBps > 10_000) {
    throw new SettlementError(`Percentage terms total ${totalBps} bps (> 10000). Rejecting rather than normalizing.`);
  }

  const lines: SettlementLine[] = input.terms.map((t) => {
    const base = {
      kind: 'contributor' as const,
      recipientId: t.contributorId,
      payeeEmail: t.payeeEmail,
      licenseId: t.licenseId,
      assetVersionId: t.assetVersionId,
    };

    if (t.payableOn === 'cited_in_output' && !t.citedInOutput) {
      return {
        ...base,
        amountCents: 0,
        formula: '0 (not cited)',
        payable: false,
        note: `License pays only when cited; "${t.assetTitle}" was not cited in the final output.`,
      };
    }

    const e = t.economics;
    switch (e.kind) {
      case 'percent_of_gross': {
        const amount = Math.floor((gross * e.bps) / 10_000);
        return {
          ...base,
          amountCents: amount,
          formula: `floor(${gross}¢ × ${e.bps} / 10000) = ${amount}¢`,
          payable: amount > 0,
          note: null,
        };
      }
      case 'fixed_per_sale':
        return {
          ...base,
          amountCents: e.amountCents,
          formula: `fixed ${e.amountCents}¢ per sale`,
          payable: e.amountCents > 0,
          note: null,
        };
      case 'none':
        return { ...base, amountCents: 0, formula: 'no payment term', payable: false, note: null };
    }
  });

  for (const line of lines) {
    if (line.payable && !line.payeeEmail) {
      throw new SettlementError(`License ${line.licenseId} is payable but has no payee.`);
    }
  }

  const contributorTotalCents = lines.reduce((sum, l) => sum + l.amountCents, 0);
  if (contributorTotalCents > gross) {
    throw new SettlementError(
      `Contributor obligations ${formatMoney(contributorTotalCents)} exceed the verified sale ${formatMoney(gross)}.`,
    );
  }

  const publisherResidualCents = gross - contributorTotalCents;
  lines.push({
    kind: 'publisher_residual',
    recipientId: input.publisherId,
    payeeEmail: null,
    licenseId: null,
    assetVersionId: null,
    amountCents: publisherResidualCents,
    formula: `${gross}¢ − ${contributorTotalCents}¢ = ${publisherResidualCents}¢`,
    // The publisher is the PayPal merchant: their share never leaves their account.
    payable: false,
    note: 'Retained by the publisher (merchant of record). PayPal fees are borne by the publisher.',
  });

  return {
    grossCents: gross,
    currency: input.currency,
    lines,
    contributorTotalCents,
    publisherResidualCents,
    roundingRule: ROUNDING_RULE,
  };
}

/**
 * A settlement line's formula in plain words, for people reading a receipt or a
 * payout list ("25% of $20.00"). The exact formula stays on the line for auditors.
 * Kept next to the engine that writes the formulas, so the two can't drift apart.
 */
export function describeFormula(formula: string): string {
  const pct = /^floor\((\d+)¢ × (\d+) \/ 10000\) = (\d+)¢$/.exec(formula);
  if (pct) return `${formatBps(Number(pct[2]))} of ${formatMoney(Number(pct[1]))}`;
  const fixed = /^fixed (\d+)¢ per sale$/.exec(formula);
  if (fixed) return `${formatMoney(Number(fixed[1]))} for each sale`;
  const rest = /^(\d+)¢ − (\d+)¢ = (\d+)¢$/.exec(formula);
  if (rest) return `What’s left of ${formatMoney(Number(rest[1]))} after contributors’ shares`;
  if (formula === '0 (not cited)') return 'Nothing: the license pays only when the report cites it, and it didn’t';
  if (formula === 'no payment term') return 'Nothing: the license has no payment';
  if (formula.startsWith('= verified capture')) return 'The sale, as PayPal confirmed it';
  return formula;
}
